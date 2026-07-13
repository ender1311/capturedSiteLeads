import { deliveryEmailHtml, deliverySubject } from "./email-template";

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
            subject: deliverySubject(input.name),
            from_name: fromName,
            from,
            reply_to: from,
            // MailerLite requires an unsubscribe link in campaign content
            content: deliveryEmailHtml(input.name, input.pdfUrl, {
              footerHtml:
                `<p style="margin-top:24px;font-size:12px;color:#9db6b5;text-align:center"><a href="{$unsubscribe}" style="color:#9db6b5">Unsubscribe</a></p>`,
            }),
          },
        ],
      }),
    });
    const campaignId = (await campaignRes.json()).data.id as string;

    await ml(`/campaigns/${campaignId}/schedule`, {
      method: "POST",
      body: JSON.stringify({ delivery: "instant" }),
    });

    // Only remove the throwaway group once the campaign has actually sent —
    // deleting it earlier strips the queued campaign's recipients and
    // silently cancels the send. On timeout, leave the group behind.
    let sent = false;
    for (let i = 0; i < 24; i++) {
      const res = await ml(`/campaigns/${campaignId}`);
      if ((await res.json()).data.status === "sent") {
        sent = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (sent) {
      await ml(`/groups/${groupId}`, { method: "DELETE" }).catch((err) =>
        console.warn("Temp delivery group cleanup failed:", err.message)
      );
    } else {
      console.warn(`Campaign ${campaignId} not sent after 120s; keeping group ${groupId}`);
    }
  } catch (err) {
    // a failed send should not leave an empty orphan group behind
    await ml(`/groups/${groupId}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
}
