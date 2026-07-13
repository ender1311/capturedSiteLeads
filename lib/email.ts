import { deliveryEmailHtml, deliverySubject } from "./email-template";
import { getEmailProvider } from "./guide-store";
import { sendPdfEmail } from "./mailerlite";
import { pdfFilename } from "./storage";

// Above this size, skip the attachment and rely on the link — large
// attachments get clipped or rejected by email clients.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

async function sendViaResend(input: {
  name: string;
  email: string;
  pdfUrl: string;
  pdf: Buffer;
}): Promise<void> {
  const attach = input.pdf.length <= MAX_ATTACHMENT_BYTES;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || "Maggie | Captured Sites <maggie@capturedsites.com>",
      to: [input.email],
      subject: deliverySubject(input.name),
      html: deliveryEmailHtml(input.name, input.pdfUrl, { attached: attach }),
      attachments: attach
        ? [{ filename: pdfFilename(input.name), content: input.pdf.toString("base64") }]
        : undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
  }
}

// Provider is admin-selectable in the dashboard (app_config, default
// MailerLite). Resend (attachment + link, authenticated domain) falls back to
// a MailerLite campaign (link only) when the key is unset or Resend errors —
// a delivery-path problem must never cost a lead their report.
export async function sendReportEmail(input: {
  name: string;
  email: string;
  pdfUrl: string;
  pdf: Buffer;
}): Promise<void> {
  const provider = await getEmailProvider().catch(() => "mailerlite" as const);
  if (provider === "resend" && process.env.RESEND_API_KEY) {
    try {
      await sendViaResend(input);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("Resend send failed; falling back to MailerLite:", message);
    }
  }
  await sendPdfEmail({ name: input.name, email: input.email, pdfUrl: input.pdfUrl });
}
