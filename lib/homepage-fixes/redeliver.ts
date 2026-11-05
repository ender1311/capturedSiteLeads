import { removeFromNeverReceived } from "@/lib/mailerlite";
import { DeliveredNotRecordedError, deliver } from "./deliver";
import { buildFacts } from "./facts";
import { overflowIssues } from "./pipeline";
import { renderAfter, renderPdf } from "./render";
import { fillReport } from "./render-html";
import { checkContent, type RuleIssue } from "./rules";
import { claimHfLead, domainOf, getCachedCapture, getHfLead, updateHfLead, type HfLeadRow, type HfOutcome } from "./store";
import type { Asset, ReportContent } from "./types";

// Delivers a held homepage-fixes report: shared by scripts/homepage-fixes-deliver.mts (Dan, from
// a terminal, optionally with edited content or --force: `redeliverHeld`) and
// POST /api/admin/leads/:id/resend (the admin's Re-send button: stored content, never forced; it
// claims the row up front with `claimForRedeliver`, answers, then runs `deliverClaimed`).
//
// Takes the edited content or the row's stored content, re-renders the mockup and the PDF from the
// cached capture of the site, runs the copy rules, then delivers it (Blob, Resend with the PDF
// attached, MailerLite, the row). Refuses when the rules find errors or the PDF overflows, or when
// the lead is not `held` (it may already have an email), unless forced. Unforced, the row is claimed
// (held → processing in one statement) before sending, so two people delivering the same lead at
// once can't both send. While the row is claimed, anything that stops the send (rule errors, no
// capture, a render or delivery failure before the email goes out) puts it back to held; a
// failure after it went out (DeliveredNotRecordedError) never does.

// The scrape cache keeps one capture per domain (the newest); a held report may sit a while.
const CAPTURE_MAX_AGE_DAYS = 365;

export type RedeliverOptions = {
  /** Edited content to send instead of the stored content (the CLI's optional file). */
  content?: ReportContent;
  /** Skip the held check, the rule errors and the claim (the CLI's --force). */
  force?: boolean;
  /** Progress lines (the CLI prints them). */
  log?: (line: string) => void;
};

export type RedeliverResult =
  | { status: "sent"; issues: RuleIssue[] }
  | { status: "not_found" }
  | { status: "not_held"; outcome: HfOutcome | null }
  | { status: "blocked"; issues: RuleIssue[] }
  | { status: "claim_lost" };

const dataUri = (a: Asset) => `data:${a.mime};base64,${a.data.toString("base64")}`;

/** The row's content also carries the fact sheet and, for held rows, the issues and reason. */
export function storedReportContent(stored: unknown): ReportContent {
  if (!stored || typeof stored !== "object") throw new Error("the lead has no stored content");
  const content: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  for (const key of ["fact_sheet", "issues", "held_reason"]) delete content[key];
  return content as unknown as ReportContent;
}

function assertShape(c: ReportContent): void {
  const ok = c && typeof c === "object" && c.first_section && typeof c.first_section.photo === "string"
    && Array.isArray(c.fixes) && c.fixes.length === 2 && Array.isArray(c.first_section_changes);
  if (!ok) throw new Error("content is missing first_section (with photo), first_section_changes or the two fixes");
}

export function formatIssues(issues: RuleIssue[]): string[] {
  if (!issues.length) return ["Rules: no issues."];
  return issues.map((i) => `  ${i.level.toUpperCase().padEnd(7)} ${i.field}: ${i.message}`);
}

/**
 * The CLI path. Throws (without sending) when the content or the cached capture is missing or
 * unusable, and when delivery fails; see the file comment for what happens to the row then.
 */
export async function redeliverHeld(leadId: string, opts: RedeliverOptions = {}): Promise<RedeliverResult> {
  const log = opts.log ?? (() => {});
  const row = await getHfLead(leadId);
  if (!row) return { status: "not_found" };
  log(`Lead ${row.id}: ${row.name} <${row.email}> ${row.site_url} (outcome ${row.outcome ?? "none"})`);
  if (row.outcome !== "held" && !opts.force) return { status: "not_held", outcome: row.outcome };
  return run(row, { ...opts, claimed: false });
}

/** The admin path, step 1 (quick, before answering): load the lead and claim it held → processing. */
export async function claimForRedeliver(leadId: string): Promise<
  { status: "not_found" } | { status: "not_held"; outcome: HfOutcome | null } | { status: "claim_lost" } | { status: "claimed"; row: HfLeadRow }
> {
  const row = await getHfLead(leadId);
  if (!row) return { status: "not_found" };
  if (row.outcome !== "held") return { status: "not_held", outcome: row.outcome };
  if (!(await claimHfLead(row.id, ["held"]))) return { status: "claim_lost" };
  return { status: "claimed", row };
}

/** The admin path, step 2: render, check and deliver a row `claimForRedeliver` claimed. */
export function deliverClaimed(row: HfLeadRow, opts: Omit<RedeliverOptions, "force" | "content"> = {}): Promise<RedeliverResult> {
  return run(row, { ...opts, claimed: true });
}

async function run(row: HfLeadRow, opts: RedeliverOptions & { claimed: boolean }): Promise<RedeliverResult> {
  const log = opts.log ?? (() => {});
  const force = !!opts.force && !opts.claimed;
  // True while this caller holds the row in `processing` and no email has gone out.
  let holding = opts.claimed;
  const release = async () => {
    if (holding) await updateHfLead(row.id, { outcome: "held" }).catch(() => {});
    holding = false;
  };

  try {
    const content = opts.content ?? storedReportContent(row.content);
    assertShape(content);

    const capture = await getCachedCapture(domainOf(row.site_url), CAPTURE_MAX_AGE_DAYS);
    if (!capture) throw new Error(`no cached capture for ${domainOf(row.site_url)}; it can't be re-rendered`);
    const facts = buildFacts(capture);

    const m = content.first_section.photo.match(/photo-(\d+)\./);
    const index = m ? Number(m[1]) - 1 : -1;
    if (index < 0 || index >= capture.photos.length) {
      throw new Error(`first_section.photo ${content.first_section.photo} is not one of the ${capture.photos.length} cached photos`);
    }

    const issues = checkContent(content, facts.pageText);
    log("Rendering the mockup and the PDF...");
    const after = await renderAfter(content.first_section, dataUri(capture.photos[index]), capture.logo ? dataUri(capture.logo) : undefined);
    const rendered = await renderPdf(fillReport(content, { before: dataUri(capture.before), after: dataUri({ data: after, mime: "image/jpeg" }) }));
    for (const o of rendered.overflow) {
      const mapped = overflowIssues(content, [o]);
      issues.push(...(mapped.length ? mapped : [{ field: `page ${o.page}`, level: "error" as const, message: "something runs past the bottom of the page" }]));
    }
    for (const line of formatIssues(issues)) log(line);

    if (issues.some((i) => i.level === "error") && !force) {
      await release();
      return { status: "blocked", issues };
    }

    // Keep the original run's usage on the row; this re-render made no Gemini calls.
    const usage = {
      inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0,
      costUsd: Number(row.cost_usd ?? 0), calls: 0,
    };
    if (!force && !holding) {
      if (!(await claimHfLead(row.id, ["held"]))) return { status: "claim_lost" };
      holding = true;
    }
    try {
      await deliver(row.id, { name: row.name, email: row.email, siteUrl: row.site_url, goal: row.goal ?? "" }, {
        outcome: "sent", content, pdf: rendered.pdf, before: capture.before.data, after, facts, usage,
        model: row.model ?? "",
      });
    } catch (e) {
      // The photographer has the email: the row must never go back to held.
      if (e instanceof DeliveredNotRecordedError) {
        holding = false;
        await removeFromNeverReceived(row.email);
      }
      throw e;
    }
    holding = false;
    // Held put them in "never received"; the report has now gone out.
    await removeFromNeverReceived(row.email);
    log(`Sent to ${row.email}.`);
    return { status: "sent", issues };
  } catch (e) {
    await release();
    throw e;
  }
}
