const API_BASE = "https://connect.mailerlite.com/api";

function headers() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
  };
}

async function ml(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { headers: headers(), ...init, });
  if (!res.ok) {
    throw new Error(`MailerLite ${init?.method ?? "GET"} ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res;
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function deliveryEmailHtml(name: string, pdfUrl: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#f6f6ec;padding:24px 0">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:36px 40px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#143133">
<p>Hi ${escHtml(name)},</p>
<p>Your personalized <strong>Dream Client Roadmap</strong> is ready &mdash; a page-by-page review of your website through the eyes of the dream client you're trying to book.</p>
<p>Inside you'll find the 3 highest-impact opportunities we spotted on your site, why each one matters for bookings, and exactly how to make it right.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto"><tr><td style="background:#a0a93f;border-radius:999px">
<a href="${escHtml(pdfUrl)}" style="display:inline-block;padding:14px 34px;font-size:16px;font-weight:bold;color:#143133;text-decoration:none">View My Roadmap</a>
</td></tr></table>
<p>Give it a quick read &mdash; most photographers can act on at least one of the fixes the same day.</p>
<p style="margin-top:32px">Talk soon,<br><strong>Maggie</strong><br>Captured Sites</p>
</div></body></html>`;
}

// Upserts the subscriber with report fields and adds them to the main group
// (which will trigger the nurture automation once it's enabled in MailerLite).
export async function addSubscriber(input: {
  name: string;
  email: string;
  siteUrl: string;
  pdfUrl: string;
}): Promise<void> {
  await ml("/subscribers", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      fields: {
        name: input.name,
        site_url: input.siteUrl,
        pdf_url: input.pdfUrl,
      },
      groups: [process.env.MAILERLITE_GROUP_ID],
    }),
  });
}

// Sends the PDF-delivery email immediately via a single-recipient campaign.
// The automation-email API can't write bodies, so campaigns are the only
// fully-API path; each send uses a throwaway group that is deleted after.
export async function sendPdfEmail(input: {
  name: string;
  email: string;
  pdfUrl: string;
}): Promise<void> {
  const from = process.env.MAILERLITE_FROM_EMAIL || "jetluk+adam@gmail.com";
  const fromName = process.env.MAILERLITE_FROM_NAME || "Maggie | Captured Sites";

  const groupRes = await ml("/groups", {
    method: "POST",
    body: JSON.stringify({ name: `delivery ${input.email} ${Date.now()}`.slice(0, 250) }),
  });
  const groupId = (await groupRes.json()).data.id as string;

  try {
    await ml("/subscribers", {
      method: "POST",
      body: JSON.stringify({ email: input.email, groups: [groupId] }),
    });

    const campaignRes = await ml("/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Roadmap delivery — ${input.email}`.slice(0, 250),
        type: "regular",
        groups: [groupId],
        emails: [
          {
            subject: `${input.name}, your Dream Client Roadmap is ready 📸`,
            from_name: fromName,
            from,
            reply_to: from,
            content: deliveryEmailHtml(input.name, input.pdfUrl),
          },
        ],
      }),
    });
    const campaignId = (await campaignRes.json()).data.id as string;

    await ml(`/campaigns/${campaignId}/schedule`, {
      method: "POST",
      body: JSON.stringify({ delivery: "instant" }),
    });

    // wait for the send so the throwaway group can be removed safely
    for (let i = 0; i < 18; i++) {
      const res = await ml(`/campaigns/${campaignId}`);
      if ((await res.json()).data.status === "sent") break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    await ml(`/groups/${groupId}`, { method: "DELETE" }).catch((err) =>
      console.warn("Temp delivery group cleanup failed:", err.message)
    );
  }
}
