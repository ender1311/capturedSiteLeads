const API_BASE = "https://connect.mailerlite.com/api";

export async function addSubscriber(input: {
  name: string;
  email: string;
  siteUrl: string;
  pdfUrl: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/subscribers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
    },
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MailerLite subscribe failed (${res.status}): ${body}`);
  }
}
