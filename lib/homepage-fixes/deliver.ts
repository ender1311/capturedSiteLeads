import { put } from "@vercel/blob";
import { addSubscriber, sendPdfEmail } from "@/lib/mailerlite";
import { alertEmail, cantSeeEmail, hobbyEmail, reportEmail, type CantSeeReason, type Email } from "./emails";
import type { PipelineResult } from "./pipeline";
import { pdfFileName } from "./render-html";
import { updateHfLead, type HfOutcome } from "./store";

// One shared delivery step for the route, the crons and the CLI: store the files, email the
// photographer, add them to MailerLite, record everything on the lead row.
// The photographer's email always goes through Resend (PDF attached when it fits); only a Resend
// error falls back to MailerLite's link-only campaign. MailerLite's subscriber upsert and the
// alert emails never block anything: they log and move on.
// Failures before the photographer's email goes out throw normally (safe to retry). Once it has
// gone out, a later failure alerts and throws DeliveredNotRecordedError: retrying would send the
// email twice.

const DEFAULT_FROM = "Maggie | Captured Sites <maggie@capturedsites.com>";
const MAGGIE = "maggie@capturedsites.com";
const DEFAULT_ALERTS = "danluk1311@gmail.com";
// Bigger attachments get clipped or rejected by mail clients; the link still works.
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export type DeliverLead = { name: string; email: string; siteUrl: string; goal: string };
export type AlertLead = { id: string; name: string; email: string; site_url: string; error?: string };
type Attachment = { filename: string; content: string };

/** The photographer already has their email; only the bookkeeping after it failed. Never retry. */
export class DeliveredNotRecordedError extends Error {
  readonly leadId: string;
  constructor(leadId: string, message: string, readonly original?: unknown) {
    super(message);
    this.name = "DeliveredNotRecordedError";
    this.leadId = leadId;
  }
}

async function afterSend(leadId: string, lead: DeliverLead, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    const message = `delivered but not recorded: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`Homepage fixes lead ${leadId}: ${message}`);
    await sendAlert("failed", { id: leadId, name: lead.name, email: lead.email, site_url: lead.siteUrl, error: message });
    throw new DeliveredNotRecordedError(leadId, message, err);
  }
}

/** Which can't-see copy a pipeline reason gets. */
export function cantSeeReason(reason: string): CantSeeReason {
  if (reason === "COMING_SOON") return "not_live";
  if (reason === "TOO_LITTLE_TEXT" || reason === "NO_PHOTO") return "too_little";
  return "couldnt_load"; // unreachable, bot_check, empty, and failed reports
}

async function resendSend(to: string[], e: Email, attachments?: Attachment[]): Promise<void> {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || DEFAULT_FROM,
      to,
      subject: e.subject,
      html: e.html,
      text: e.text,
      attachments: attachments?.length ? attachments : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
}

/** Resend first; on any Resend error, MailerLite's link-only campaign with `fallback` copy. */
async function sendToPhotographer(
  lead: DeliverLead, e: Email, opts: { pdfUrl?: string; attachment?: Attachment; fallback?: Email } = {},
): Promise<void> {
  try {
    await resendSend([lead.email], e, opts.attachment ? [opts.attachment] : undefined);
  } catch (err) {
    console.warn("Resend send failed; falling back to MailerLite:", (err as Error).message);
    const f = opts.fallback ?? e;
    await sendPdfEmail({ name: lead.name, email: lead.email, pdfUrl: opts.pdfUrl ?? "", subject: f.subject, html: f.html });
  }
}

async function upsertSubscriber(lead: DeliverLead, outcome: HfOutcome, extra: {
  pdfUrl?: string; headline?: string; fix1?: string; fix2?: string;
} = {}): Promise<void> {
  try {
    await addSubscriber({
      name: lead.name, email: lead.email, siteUrl: lead.siteUrl, pdfUrl: extra.pdfUrl ?? "",
      fields: {
        goal: lead.goal,
        hf_outcome: outcome,
        hf_headline: extra.headline ?? "",
        hf_fix1_title: extra.fix1 ?? "",
        hf_fix2_title: extra.fix2 ?? "",
        hf_sent_date: outcome === "sent" ? new Date().toISOString().slice(0, 10) : "",
      },
    });
  } catch (err) {
    console.warn("MailerLite subscriber upsert failed:", (err as Error).message);
  }
}

const isPng = (b: Buffer) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const usageCols = (r: { usage: { inputTokens: number; outputTokens: number; costUsd: number } }) => ({
  input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens, cost_usd: r.usage.costUsd,
});

export async function deliver(leadId: string, lead: DeliverLead, result: PipelineResult): Promise<void> {
  switch (result.outcome) {
    case "sent": {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const folder = `homepage-fixes/${unique}`;
      const fileName = pdfFileName(result.content.first_name || lead.name);
      const beforeName = isPng(result.before) ? "before.png" : "before.jpg";
      const [pdf, before, after] = await Promise.all([
        put(`${folder}/${fileName}`, result.pdf, { access: "public", contentType: "application/pdf" }),
        put(`${folder}/${beforeName}`, result.before, { access: "public", contentType: beforeName.endsWith("png") ? "image/png" : "image/jpeg" }),
        put(`${folder}/after.jpg`, result.after, { access: "public", contentType: "image/jpeg" }),
      ]);
      const attach = result.pdf.length <= MAX_ATTACHMENT_BYTES;
      await sendToPhotographer(lead, reportEmail(lead.name, pdf.url, attach), {
        pdfUrl: pdf.url,
        attachment: attach ? { filename: fileName, content: result.pdf.toString("base64") } : undefined,
        fallback: reportEmail(lead.name, pdf.url, false),
      });
      await afterSend(leadId, lead, async () => {
        await upsertSubscriber(lead, "sent", {
          pdfUrl: pdf.url,
          headline: result.content.first_section.headline,
          fix1: result.content.fixes[0].title,
          fix2: result.content.fixes[1].title,
        });
        await updateHfLead(leadId, {
          outcome: "sent", pdf_url: pdf.url, before_url: before.url, after_url: after.url,
          content: { ...result.content, fact_sheet: result.facts.sheet },
          ...usageCols(result), model: result.model,
        });
      });
      return;
    }
    case "hobby": {
      await sendToPhotographer(lead, hobbyEmail(lead.name, result.compliment));
      await afterSend(leadId, lead, async () => {
        await upsertSubscriber(lead, "hobby");
        await updateHfLead(leadId, {
          outcome: "hobby", content: { compliment: result.compliment, fact_sheet: result.facts.sheet },
          ...usageCols(result), model: result.model,
        });
      });
      return;
    }
    case "cant_see": {
      await sendToPhotographer(lead, cantSeeEmail(lead.name, cantSeeReason(result.reason)));
      await afterSend(leadId, lead, async () => {
        await upsertSubscriber(lead, "cant_see");
        await updateHfLead(leadId, { outcome: "cant_see", content: { reason: result.reason }, ...usageCols(result) });
      });
      return;
    }
    case "held": {
      // Nothing goes to the photographer; Dan and Maggie look at it from the dashboard.
      await updateHfLead(leadId, {
        outcome: "held", error: result.reason,
        content: { ...result.content, fact_sheet: result.facts.sheet, issues: result.issues, held_reason: result.reason },
        ...usageCols(result), model: result.model,
      });
      const summary = result.issues.filter((i) => i.level === "error").map((i) => `${i.field}: ${i.message}`);
      await sendAlert("held", {
        id: leadId, name: lead.name, email: lead.email, site_url: lead.siteUrl,
        error: [result.reason, ...summary].join("\n"),
      });
      return;
    }
  }
}

const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/**
 * Re-sends a report the photographer already has (a repeat request, or one over the daily limit):
 * the same report email, the PDF attached when it downloads and fits, MailerLite link-only only
 * if Resend errors. Records nothing; the caller owns the row. Throws only if no email went out.
 */
export async function resendReport(lead: DeliverLead, pdfUrl: string): Promise<void> {
  let attachment: Attachment | undefined;
  try {
    const res = await fetch(pdfUrl);
    if (res.ok) {
      const pdf = Buffer.from(await res.arrayBuffer());
      if (pdf.length > 0 && pdf.length <= MAX_ATTACHMENT_BYTES) {
        attachment = { filename: pdfFileName(firstWord(lead.name)), content: pdf.toString("base64") };
      }
    }
  } catch (err) {
    console.warn("Could not fetch the earlier PDF to attach; sending the link only:", (err as Error).message);
  }
  await sendToPhotographer(lead, reportEmail(lead.name, pdfUrl, !!attachment), {
    pdfUrl, attachment, fallback: reportEmail(lead.name, pdfUrl, false),
  });
}

/**
 * The second failure: the photographer gets the "couldn't load" note, MailerLite gets
 * hf_outcome failed (no PDF), the row becomes `failed`, and Dan gets an alert.
 * If even the note can't be sent, the row still becomes `failed` with both errors.
 */
export async function deliverFailed(leadId: string, lead: DeliverLead, error: string): Promise<void> {
  const alertLead = { id: leadId, name: lead.name, email: lead.email, site_url: lead.siteUrl };
  try {
    await sendToPhotographer(lead, cantSeeEmail(lead.name, "couldnt_load"));
  } catch (err) {
    const message = `${error}\nthe can't-see email also failed: ${err instanceof Error ? err.message : String(err)}`;
    await updateHfLead(leadId, { outcome: "failed", error: message });
    await sendAlert("failed", { ...alertLead, error: message });
    return;
  }
  await afterSend(leadId, lead, async () => {
    await upsertSubscriber(lead, "failed");
    await updateHfLead(leadId, { outcome: "failed", error });
  });
  await sendAlert("failed", { ...alertLead, error });
}

/** Alert email to ALERT_EMAILS (plus Maggie for `held`). Never throws. */
export async function sendAlert(kind: "held" | "failed" | "cap", lead: AlertLead): Promise<void> {
  const to = (process.env.ALERT_EMAILS || DEFAULT_ALERTS).split(",").map((s) => s.trim()).filter(Boolean);
  if (kind === "held" && !to.some((a) => a.toLowerCase() === MAGGIE)) to.push(MAGGIE);
  try {
    await resendSend(to, alertEmail(kind, lead));
  } catch (err) {
    console.error(`Homepage fixes ${kind} alert failed:`, (err as Error).message);
  }
}
