import { NextResponse, after, type NextRequest } from "next/server";
import { z } from "zod";
import { capRemaining, checkDailyLimits, normalizeEmail, visitorIp, type RateCheck } from "@/lib/abuse";
import { getLiveModel } from "@/lib/guide-store";
import { authorized, parseBody } from "@/lib/lead-intake";
import { leadEmail, leadName, leadSiteUrl } from "@/lib/lead-fields";
import { pickModel } from "@/lib/models";
import { captureSite } from "./capture";
import {
  DeliveredNotRecordedError, deliver, deliverFailed, resendReport, sendAlert, type DeliverLead,
} from "./deliver";
import { runHomepageFixes, DEFAULT_DEADLINE_MS } from "./pipeline";
import {
  REPORT_TYPE, claimCapAlert, claimHfLead, domainOf, getCachedCapture, getHfLead, insertHfLead,
  latestSentFor, markStuckLeads, putCachedCapture, queuedLeads, recentProcessingFor, retryingLeads,
  updateHfLead, type HfOutcome,
} from "./store";
import { TIMEOUT_PASS, checkEmail, checkWebsite, withDeadline, type FieldCheck } from "./validate";

// Intake for "Your Top Homepage Fixes" (spec section 2) and the retry/queue sweep (section 8).
// The Elementor webhook always gets a fast 200 once the secret checks out. Every accepted
// submission ends in exactly one email from one of: processLead's delivery, a re-send of an
// earlier PDF, or the failed path's "couldn't load" note; or a recorded reason for none
// (invalid, limited, queued until the next queue run, held for Maggie).

const RECHECK_DEADLINE_MS = 5000;
const DEDUPE_DAYS = 7;
const TWIN_MINUTES = 10;
const RETRY_AFTER_MINUTES = 10;
// A build attempt lasts at most 300 s; one still `processing` after this long was killed mid-run.
const STUCK_AFTER_MINUTES = 20;
const MAX_PER_SWEEP = 20;
// A sweep shares one 300 s function. Each lead gets the rest of the 270 s pipeline budget, and a
// new lead starts only while that still leaves room for a full worst-case run (capture, write,
// look check, PDF, delivery), so the function is never killed with a row half done.
const LATEST_START_MS = 75_000;

const intakeSchema = z.object({
  name: leadName,
  email: leadEmail,
  site_url: leadSiteUrl,
  goal: z.unknown().transform((v) => (typeof v === "string" ? v.trim().slice(0, 1000) : "")),
});

const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const ok = (body: Record<string, unknown>) => NextResponse.json(body); // always 200: Elementor treats anything else as failure

/** Today's date in Eastern time, the "day" of the once-a-day cap alert. */
function easternDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

// A server-side re-check that takes longer than 5 s, or throws, passes: never block a real person
// because of our own slowness.
const recheck = (p: Promise<FieldCheck>) =>
  withDeadline(p, RECHECK_DEADLINE_MS, TIMEOUT_PASS).catch(() => TIMEOUT_PASS);

export async function handleHomepageFixes(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { body, rawFields, meta, isForm } = await parseBody(req);
  // Form posts arrive via the WordPress server, so proxy headers hold its IP, shared by every
  // visitor: trust headers only for direct (JSON) callers.
  const ip = visitorIp(req, { ...rawFields, ...meta }, { trustHeaders: !isForm });
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const parsed = intakeSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = Object.keys(z.flattenError(parsed.error).fieldErrors).join(", ");
    try {
      const id = await insertHfLead({
        name: str(raw.name), email: normalizeEmail(str(raw.email)), siteUrl: str(raw.site_url),
        goal: str(raw.goal), ip, outcome: "invalid",
      });
      await updateHfLead(id, { outcome: "invalid", error: `invalid payload: ${fields}` });
      return ok({ id, status: "invalid" });
    } catch (e) {
      console.error("Homepage fixes: could not record an invalid payload:", errText(e));
      return ok({ status: "invalid" });
    }
  }

  const lead: DeliverLead = {
    name: parsed.data.name.trim(),
    email: normalizeEmail(parsed.data.email),
    siteUrl: parsed.data.site_url,
    goal: parsed.data.goal,
  };

  const received = Date.now();
  let id: string;
  try {
    id = await insertHfLead({ ...lead, ip, outcome: "processing" });
  } catch (e) {
    const error = `could not save the lead: ${errText(e)}`;
    console.error(`Homepage fixes: ${error}`);
    await sendAlert("failed", { id: "(not saved)", name: lead.name, email: lead.email, site_url: lead.siteUrl, error });
    return ok({ status: "error" });
  }

  // Answer Elementor now (its webhook may give up after about 5 s); the re-checks, limits and the
  // build all run after the response. The row's outcome records where each lead ended up.
  after(async () => {
    try {
      await triage(id, lead, ip, str(raw.site_url), received);
    } catch (e) {
      const error = `intake failed: ${errText(e)}`;
      console.error(`Homepage fixes lead ${id}: ${error}`);
      await updateHfLead(id, { error }).catch(() => {});
      await sendAlert("failed", { id, name: lead.name, email: lead.email, site_url: lead.siteUrl, error });
    }
  });
  return ok({ id, status: "processing" });
}

/**
 * Everything after the row is saved, run in after(): re-checks, limits, duplicates, the cap, then
 * the build. `received` is when the request came in, so the build gets what's left of 270 s.
 * Returns the row's outcome.
 */
async function triage(
  id: string, lead: DeliverLead, ip: string | null, typedSite: string, received: number,
): Promise<HfOutcome> {
  // 1. The on-page checks again, server-side (the snippet can be skipped).
  const [emailCheck, siteCheck] = await Promise.all([
    recheck(checkEmail(lead.email)),
    recheck(checkWebsite(typedSite || lead.siteUrl)),
  ]);
  if (!emailCheck.ok || !siteCheck.ok) {
    const why = [!emailCheck.ok && `email: ${emailCheck.code}`, !siteCheck.ok && `website: ${siteCheck.code}`].filter(Boolean);
    await updateHfLead(id, { outcome: "invalid", error: why.join("; ") });
    return "invalid";
  }

  const domain = domainOf(lead.siteUrl);
  const limit: RateCheck = await checkDailyLimits({ email: lead.email, ip, reportType: REPORT_TYPE }).catch((e) => {
    console.error(errText(e));
    return { allowed: true as const }; // fail open: a limiter outage shouldn't drop real leads
  });
  const earlierSent = () => latestSentFor(lead.email, domain, DEDUPE_DAYS).catch((e) => {
    console.warn("Duplicate lookup failed:", errText(e));
    return null;
  });

  // 2. Over the per-email or per-IP limit: limited; their latest PDF for this site goes out again.
  if (!limit.allowed && limit.kind !== "cap") {
    const earlier = await earlierSent();
    await updateHfLead(id, {
      outcome: "limited",
      error: earlier ? `${limit.reason}; re-sent the report from lead ${earlier.id}` : limit.reason,
    });
    if (earlier) await resendEarlier(id, lead, earlier.pdf_url, "limited");
    return "limited";
  }

  // 3. The same person and site already on its way (a double submit, even on a capped day):
  //    this one stops quietly.
  const twin = await recentProcessingFor(lead.email, domain, TWIN_MINUTES, id).catch((e) => {
    console.warn("Concurrent duplicate lookup failed:", errText(e));
    return null;
  });
  if (twin) {
    await updateHfLead(id, { outcome: "limited", error: `duplicate of lead ${twin.id}, still being built` });
    return "limited";
  }

  // 4. Same person and site got a report in the last 7 days: re-send it instead of building one.
  //    Checked before the cap: a re-send costs nothing, so it never waits in the queue.
  const earlier = await earlierSent();
  if (earlier) {
    await resendEarlier(id, lead, earlier.pdf_url, "sent");
    return "sent";
  }

  // 5. Over the day's service cap: queued for the 7:00 Eastern run; Dan hears once a day.
  if (!limit.allowed) {
    await updateHfLead(id, { outcome: "queued", error: limit.reason });
    const first = await claimCapAlert(easternDay()).catch((e) => {
      console.warn("Cap alert bookkeeping failed:", errText(e));
      return false;
    });
    if (first) {
      await sendAlert("cap", { id, name: lead.name, email: lead.email, site_url: lead.siteUrl, error: limit.reason });
    }
    return "queued";
  }

  // 6. Build it, with the time triage already used taken off the pipeline's budget.
  await processLead(id, { deadlineMs: DEFAULT_DEADLINE_MS - (Date.now() - received) });
  return "processing";
}

/** Re-sends an earlier PDF; for a dedupe the row becomes `sent` with that PDF once it's out. */
async function resendEarlier(id: string, lead: DeliverLead, pdfUrl: string, outcome: "sent" | "limited"): Promise<void> {
  let emailId: string | null;
  try {
    emailId = await resendReport(lead, pdfUrl);
  } catch (e) {
    const error = `re-sending the earlier report failed: ${errText(e)}`;
    console.error(`Homepage fixes lead ${id}: ${error}`);
    await updateHfLead(id, outcome === "sent" ? { outcome: "failed", error } : { error }).catch(() => {});
    await sendAlert("failed", { id, name: lead.name, email: lead.email, site_url: lead.siteUrl, error });
    return;
  }
  // The row keeps the Resend id of the re-send, so its opens and clicks land here.
  const idCol = emailId ? { resend_email_id: emailId } : {};
  if (outcome === "sent" || emailId) {
    await updateHfLead(id, outcome === "sent" ? { outcome: "sent", pdf_url: pdfUrl, ...idCol } : idCol).catch((e) => {
      console.error(`Homepage fixes lead ${id}: re-sent but not recorded: ${errText(e)}`);
    });
  }
}

const buildable = (o: HfOutcome | null) => o === "processing" || o === "retrying";

/**
 * Builds and delivers one lead: cached capture when there is one (a fresh capture is cached for
 * the next person on the same site), the pipeline, then delivery. A thrown error is the lead's
 * first failure (retrying, for the 15-minute sweep) or its second (failed: "couldn't load" email
 * and an alert). An error after the photographer's email went out is never retried.
 */
export async function processLead(leadId: string, opts: { deadlineMs?: number } = {}): Promise<void> {
  const row = await getHfLead(leadId).catch((e) => {
    console.error(`Homepage fixes lead ${leadId}: could not load: ${errText(e)}`);
    return null;
  });
  if (!row || !buildable(row.outcome)) return;
  const lead: DeliverLead = { name: row.name, email: row.email, siteUrl: row.site_url, goal: row.goal ?? "" };
  const domain = domainOf(row.site_url);

  try {
    const cached = await getCachedCapture(domain);
    // The model picked in the admin (app_config llm_model); the default if it can't be read.
    const model = pickModel(await getLiveModel().catch(() => null), process.env.LLM_MODEL);
    const result = await runHomepageFixes(
      { firstName: firstWord(row.name), website: row.site_url, goal: lead.goal, model, capture: cached ?? undefined, deadlineMs: opts.deadlineMs },
      {
        capture: async (url) => {
          const c = await captureSite(url);
          await putCachedCapture(domain, c);
          return c;
        },
      },
    );
    // The CLI or another run may have finished this lead meanwhile: never send twice.
    const now = await getHfLead(leadId);
    if (!now || !buildable(now.outcome)) {
      console.warn(`Homepage fixes lead ${leadId}: now ${now?.outcome ?? "missing"}; not delivering`);
      return;
    }
    await deliver(leadId, lead, result);
  } catch (e) {
    const error = errText(e);
    try {
      if (e instanceof DeliveredNotRecordedError) {
        // The email went out and deliver already alerted; just keep the reason on the row.
        await updateHfLead(leadId, { error });
      } else if (row.retry_count < 1) {
        await updateHfLead(leadId, { outcome: "retrying", retry_count: 1, error });
      } else {
        await deliverFailed(leadId, lead, error);
      }
    } catch (inner) {
      console.error(`Homepage fixes lead ${leadId}: ${error}; then could not record it: ${errText(inner)}`);
    }
  }
}

/**
 * Cron body. Default (every 15 minutes): alerts once for each row stuck in `processing`, then
 * re-runs leads in `retrying` once. `queue` (7:00 Eastern): builds `queued` leads oldest first,
 * up to what the day's cap allows; a queued lead whose person already got a report for this site
 * in the last 7 days gets that report again instead. Both take at most 20 leads, one at a time,
 * and stop starting new ones when time runs short.
 */
export async function sweep(opts: { queue?: boolean } = {}): Promise<{ queued: number; retried: number }> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const counts = { queued: 0, retried: 0 };

  const run = async (ids: string[], from: HfOutcome, key: keyof typeof counts) => {
    for (const id of ids) {
      if (elapsed() > LATEST_START_MS) break;
      if (!(await claimHfLead(id, [from]))) continue; // someone else got it
      if (from === "queued" && (await resentInstead(id))) continue;
      await processLead(id, { deadlineMs: DEFAULT_DEADLINE_MS - elapsed() });
      counts[key]++;
    }
  };

  if (opts.queue) {
    const room = Math.min(await capRemaining(REPORT_TYPE), MAX_PER_SWEEP);
    if (room > 0) await run(await queuedLeads(room), "queued", "queued");
  } else {
    await alertStuck();
    await run(await retryingLeads(RETRY_AFTER_MINUTES, MAX_PER_SWEEP), "retrying", "retried");
  }
  return counts;
}

/** A claimed queued lead whose person already has a report for this site: limited, and re-sent. */
async function resentInstead(id: string): Promise<boolean> {
  const row = await getHfLead(id);
  if (!row) return true;
  const earlier = await latestSentFor(row.email, domainOf(row.site_url), DEDUPE_DAYS).catch(() => null);
  if (!earlier) return false;
  const lead: DeliverLead = { name: row.name, email: row.email, siteUrl: row.site_url, goal: row.goal ?? "" };
  await updateHfLead(id, { outcome: "limited", error: `duplicate of lead ${earlier.id}; re-sent its report` });
  await resendEarlier(id, lead, earlier.pdf_url, "limited");
  return true;
}

/** One alert per row stuck in `processing`; the row itself is left for a human. Never throws. */
async function alertStuck(): Promise<void> {
  let stuck;
  try {
    stuck = await markStuckLeads(STUCK_AFTER_MINUTES);
  } catch (e) {
    console.error("Stuck-row check failed:", errText(e));
    return;
  }
  for (const r of stuck) {
    const since = new Date(r.since).toISOString();
    await sendAlert("failed", { id: r.id, name: r.name, email: r.email, site_url: r.site_url, error: `stuck in processing since ${since}` });
  }
}
