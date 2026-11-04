// The homepage-fixes emails: report, can't see it, hobby, plus the internal alert.
// The look of the old roadmap delivery email, in its own shell: no &mdash;, and
// inline styles only, since the admin previews these in a CSP-restricted frame.
// Copy is Maggie's to edit later; keep it free of dashes and exclamation points.

export const TOUR_URL =
  "https://capturedsites.com/tour/?utm_source=homepage-fixes&utm_medium=email&utm_campaign=homepage-fixes";
// The leads live in the Beacon Frontier admin; an alert links straight to its lead.
export const ADMIN_URL = "https://beaconfrontier.com/admin/site/capturedsites";
export const adminLeadUrl = (id: string) =>
  /^[A-Za-z0-9_-]{1,64}$/.test(id) ? `${ADMIN_URL}/leads/${id}` : ADMIN_URL;

export type Email = { subject: string; html: string; text: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Subjects are plain text: never HTML-escaped, but a line break has no place in a header.
const subjectLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

type Block =
  | { p: string }                              // a paragraph of plain text
  | { button: string; href: string }           // the pill button
  | { tour: "report" | "cant_see" }            // the Captured Sites Tour line
  | { signoff: true };

const TOUR_BEFORE = {
  report: "If you'd love to see what it looks like to have your whole website built this way, I'd love to show you around on a ",
  cant_see: "If you'd ever like help with your website, I'd love to show you around on a ",
};
const TOUR_LINK_TEXT = "Captured Sites Tour";

function blockHtml(b: Block): string {
  if ("p" in b) return `<p style="margin:0 0 16px">${esc(b.p)}</p>`;
  if ("button" in b) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto"><tr><td style="background:#a0a93f;border-radius:999px">
<a href="${esc(b.href)}" style="display:inline-block;padding:14px 34px;font-size:16px;font-weight:bold;color:#143133;text-decoration:none">${esc(b.button)}</a>
</td></tr></table>`;
  }
  if ("tour" in b) {
    return `<p style="margin:0 0 16px">${esc(TOUR_BEFORE[b.tour])}<a href="${esc(TOUR_URL)}" style="color:#143133;font-weight:bold">${TOUR_LINK_TEXT}</a>.</p>`;
  }
  return `<p style="margin:32px 0 0">Talk soon,<br><strong>Maggie</strong><br>Captured Sites</p>`;
}

function blockText(b: Block): string {
  if ("p" in b) return b.p;
  if ("button" in b) return `${b.button}: ${b.href}`;
  if ("tour" in b) return `${TOUR_BEFORE[b.tour]}${TOUR_LINK_TEXT}.\n${TOUR_URL}`;
  return "Talk soon,\nMaggie\nCaptured Sites";
}

/** The shared shell. `footerHtml` is raw HTML (MailerLite's unsubscribe link goes here). */
export function shell(blocks: Block[], footerHtml = ""): { html: string; text: string } {
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#f6f6ec;padding:24px 0">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#143133">
${blocks.map(blockHtml).join("\n")}
${footerHtml}
</div></body></html>`;
  return { html, text: blocks.map(blockText).join("\n\n") + "\n" };
}

export function reportEmail(name: string, pdfUrl: string, attached: boolean): Email {
  const blocks: Block[] = [
    { p: `Hi ${name},` },
    { p: "Your Top Homepage Fixes are ready. It's your own homepage, with your own photo and words, showing a new first section and two more opportunities to turn more visitors into inquiries." },
    ...(attached ? [{ p: "Your fixes are attached to this email, or you can view them online:" }] : []),
    { button: "See My Homepage Fixes", href: pdfUrl },
    { tour: "report" },
    { signoff: true },
  ];
  return { subject: subjectLine(`${name}, your top homepage fixes are ready`), ...shell(blocks) };
}

export type CantSeeReason = "not_live" | "too_little" | "couldnt_load";

export function cantSeeEmail(name: string, reason: CantSeeReason): Email {
  const thanks = "Thanks so much for asking for your homepage fixes.";
  const anotherAddress = "If your site lives at another address, just reply with the link and I'll take care of it.";
  const body: string[] =
    reason === "not_live"
      ? [
          `${thanks} It looks like your homepage isn't quite live yet, so I wasn't able to make them this time.`,
          "Once it's live, come back to capturedsites.com/homepage-fixes and I'll make them for you.",
        ]
      : reason === "too_little"
        ? [`${thanks} My homepage review tool couldn't find enough on your homepage to make your fixes this time.`, anotherAddress]
        : [`${thanks} My homepage review tool couldn't load your homepage, so I wasn't able to make them this time.`, anotherAddress];
  const blocks: Block[] = [{ p: `Hi ${name},` }, ...body.map((p) => ({ p })), { tour: "cant_see" }, { signoff: true }];
  return { subject: subjectLine(`${name}, a quick note about your homepage fixes`), ...shell(blocks) };
}

export function hobbyEmail(name: string, compliment: string): Email {
  const blocks: Block[] = [
    { p: `Hi ${name},` },
    { p: compliment },
    { p: "It sounds like photography is something you love doing for yourself right now, so I won't fill your inbox with fixes. If it ever grows into something you want to take further, I'd love to help." },
    { signoff: true },
  ];
  return { subject: subjectLine(`${name}, a little note about your website`), ...shell(blocks) };
}

export function alertEmail(
  kind: "held" | "failed" | "cap",
  lead: { id: string; name: string; email: string; site_url: string; error?: string },
): Email {
  const link = adminLeadUrl(lead.id);
  const rows: [string, string][] = [
    ["Lead id", lead.id],
    ["Name", lead.name],
    ["Email", lead.email],
    ["Site", lead.site_url],
    ["Error", lead.error ?? "none"],
  ];
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#143133">
<p style="margin:0 0 12px"><strong>Homepage Fixes: ${esc(kind)}</strong></p>
<table role="presentation" cellpadding="4" cellspacing="0" style="border-collapse:collapse">
${rows.map(([k, v]) => `<tr><td style="font-weight:bold;vertical-align:top;padding-right:12px">${esc(k)}</td><td style="white-space:pre-wrap">${esc(v)}</td></tr>`).join("\n")}
</table>
<p style="margin:16px 0 0"><a href="${esc(link)}" style="color:#143133">${esc(link)}</a></p>
</body></html>`;
  const text = `Homepage Fixes: ${kind}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nOpen the lead: ${link}\n`;
  return { subject: subjectLine(`[Homepage Fixes] ${kind}: ${lead.name} (${lead.site_url})`), html, text };
}
