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
// `fields` adds extra custom fields (the homepage-fixes hf_* set) on top of the
// three base ones.
export async function addSubscriber(input: {
  name: string;
  email: string;
  siteUrl: string;
  /** Sent only when non-empty, so a later upsert never blanks an earlier PDF link. */
  pdfUrl?: string;
  fields?: Record<string, string>;
  /** Extra MailerLite group ids to join on top of the main group (empty ids are skipped). */
  extraGroups?: (string | undefined)[];
}): Promise<void> {
  const groups = [process.env.MAILERLITE_GROUP_ID, ...(input.extraGroups ?? [])].filter(
    (g): g is string => typeof g === "string" && g.trim() !== "",
  );
  await ml("/subscribers", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      fields: {
        name: input.name,
        site_url: input.siteUrl,
        ...(input.pdfUrl ? { pdf_url: input.pdfUrl } : {}),
        ...input.fields,
      },
      groups,
    }),
  });
}

/** The "Homepage Fixes: never received" group id; empty when unset (all never-received logic is then a no-op). */
export function neverReceivedGroupId(): string | undefined {
  const id = process.env.MAILERLITE_HF_NEVER_RECEIVED_GROUP_ID?.trim();
  return id ? id : undefined;
}

// Maggie's follow-up automation waits 2 days, then skips anyone in this group: they will not get a
// report, so they must not get the follow-ups either. The upsert adds the group and keeps the others.
// Never throws: a MailerLite error must not block emails, row updates or retries.
export async function addToNeverReceived(input: { name: string; email: string }): Promise<void> {
  const groupId = neverReceivedGroupId();
  if (!groupId) return;
  try {
    await ml("/subscribers", {
      method: "POST",
      body: JSON.stringify({ email: input.email, fields: { name: input.name }, groups: [groupId] }),
    });
  } catch (err) {
    console.warn("MailerLite never-received group add failed:", (err as Error).message);
  }
}

// A held report that finally goes out: the person is no longer a never-received. A 404 (not in the
// group, or no such subscriber) is fine. Never throws.
export async function removeFromNeverReceived(email: string): Promise<void> {
  const groupId = neverReceivedGroupId();
  if (!groupId) return;
  try {
    const found = await fetch(`${API_BASE}/subscribers/${encodeURIComponent(email)}`, { headers: headers() });
    if (found.status === 404) return;
    if (!found.ok) throw new Error(`MailerLite GET subscriber failed (${found.status})`);
    const subscriberId = (await found.json()).data?.id as string | undefined;
    if (!subscriberId) return;
    const res = await fetch(`${API_BASE}/subscribers/${subscriberId}/groups/${groupId}`, { method: "DELETE", headers: headers() });
    if (!res.ok && res.status !== 404) throw new Error(`MailerLite DELETE group failed (${res.status})`);
  } catch (err) {
    console.warn("MailerLite never-received group removal failed:", (err as Error).message);
  }
}

const UNSUBSCRIBE_FOOTER =
  `<p style="margin-top:24px;font-size:12px;color:#9db6b5;text-align:center"><a href="{$unsubscribe}" style="color:#9db6b5">Unsubscribe</a></p>`;

// Puts the unsubscribe footer inside the card (before its closing </div>) when
// the caller's HTML doesn't already carry MailerLite's {$unsubscribe} tag.
function withUnsubscribe(html: string): string {
  if (html.includes("{$unsubscribe}")) return html;
  const at = html.lastIndexOf("</div>");
  return at >= 0 ? html.slice(0, at) + UNSUBSCRIBE_FOOTER + html.slice(at) : html + UNSUBSCRIBE_FOOTER;
}

// Sends one email immediately via a single-recipient campaign (the homepage-fixes fallback
// when Resend errors). The automation-email API can't write bodies, so campaigns are the only
// fully-API path; each send uses a throwaway group that is deleted after. The unsubscribe link
// MailerLite requires is added if the html doesn't carry one.
export async function sendPdfEmail(input: {
  name: string;
  email: string;
  pdfUrl: string;
  subject: string;
  html: string;
}): Promise<void> {
  const from = process.env.MAILERLITE_FROM_EMAIL || "jetluk+adam@gmail.com";
  const fromName = process.env.MAILERLITE_FROM_NAME || "Maggie | Captured Sites";

  const groupRes = await ml("/groups", {
    method: "POST",
    body: JSON.stringify({ name: `delivery ${input.email} ${Date.now()}`.slice(0, 250) }),
  });
  const groupId = (await groupRes.json()).data.id as string;
  let scheduled = false;

  try {
    await ml("/subscribers", {
      method: "POST",
      body: JSON.stringify({ email: input.email, groups: [groupId] }),
    });

    const campaignRes = await ml("/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Homepage fixes delivery — ${input.email}`.slice(0, 250),
        type: "regular",
        groups: [groupId],
        emails: [
          {
            subject: input.subject,
            from_name: fromName,
            from,
            reply_to: from,
            // MailerLite requires an unsubscribe link in campaign content
            content: withUnsubscribe(input.html),
          },
        ],
      }),
    });
    const campaignId = (await campaignRes.json()).data.id as string;

    await ml(`/campaigns/${campaignId}/schedule`, {
      method: "POST",
      body: JSON.stringify({ delivery: "instant" }),
    });
    scheduled = true;

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
    // Once scheduled, the email is on its way: a polling hiccup must not delete
    // the group (that cancels a queued send) or throw (the caller would resend).
    if (scheduled) {
      console.warn(`Polling campaign after scheduling failed; treating as sent and keeping group ${groupId}:`, (err as Error).message);
      return;
    }
    // a failed send should not leave an empty orphan group behind
    await ml(`/groups/${groupId}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
}
