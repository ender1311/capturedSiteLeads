import { sendPdfEmail } from "./mailerlite";
import { pdfFilename } from "./storage";

// Above this size, skip the attachment and rely on the link — large
// attachments get clipped or rejected by email clients.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function deliveryEmailHtml(name: string, pdfUrl: string, attached: boolean): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f6f6ec;padding:24px 0">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#143133">
<p>Hi ${escHtml(name)},</p>
<p>Your personalized <strong>Dream Client Roadmap</strong> is ready &mdash; a page-by-page review of your website through the eyes of the dream client you're trying to book.</p>
<p>Inside you'll find the 3 highest-impact opportunities we spotted on your site, why each one matters for bookings, and exactly how to make it right.</p>
${attached ? `<p>Your roadmap is <strong>attached to this email</strong>, or you can view it online:</p>` : ""}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto"><tr><td style="background:#a0a93f;border-radius:999px">
<a href="${escHtml(pdfUrl)}" style="display:inline-block;padding:14px 34px;font-size:16px;font-weight:bold;color:#143133;text-decoration:none">View My Roadmap</a>
</td></tr></table>
<p>Give it a quick read &mdash; most photographers can act on at least one of the fixes the same day.</p>
<p style="margin-top:32px">Talk soon,<br><strong>Maggie</strong><br>Captured Sites</p>
</div></body></html>`;
}

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
      subject: `${input.name}, your Dream Client Roadmap is ready 📸`,
      html: deliveryEmailHtml(input.name, input.pdfUrl, attach),
      attachments: attach
        ? [{ filename: pdfFilename(input.name), content: input.pdf.toString("base64") }]
        : undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
  }
}

// Resend (attachment + link, authenticated domain) when configured;
// falls back to a MailerLite campaign (link only) until then.
export async function sendReportEmail(input: {
  name: string;
  email: string;
  pdfUrl: string;
  pdf: Buffer;
}): Promise<void> {
  if (process.env.RESEND_API_KEY) {
    await sendViaResend(input);
  } else {
    await sendPdfEmail({ name: input.name, email: input.email, pdfUrl: input.pdfUrl });
  }
}
