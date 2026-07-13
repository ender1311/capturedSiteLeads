"use client";

import { useEffect, useState } from "react";

type Provider = "mailerlite" | "resend";

const PROVIDERS: {
  id: Provider;
  label: string;
  tagline: string;
  points: string[];
}[] = [
  {
    id: "mailerlite",
    label: "MailerLite",
    tagline: "Engagement tracked in the dashboard",
    points: [
      "Opens and clicks flow into the dashboard stats via the MailerLite webhook",
      "Sends a one-off campaign with the View button — no PDF attachment",
      "Slower delivery (campaign create + send, ~1–2 min) and uses MailerLite quota",
    ],
  },
  {
    id: "resend",
    label: "Resend",
    tagline: "PDF attached, best deliverability",
    points: [
      "Sent instantly from maggie@capturedsites.com (authenticated domain) — strongest inbox placement",
      "The roadmap PDF is attached to the email, plus the View button",
      "Opens and clicks feed the dashboard stats via the Resend webhook",
      "Falls back to MailerLite automatically if Resend ever fails",
    ],
  },
];

export function EmailProviderPicker() {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [resendConfigured, setResendConfigured] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/email-provider")
      .then((r) => r.json())
      .then((d: { current: Provider; resendConfigured: boolean }) => {
        setProvider(d.current);
        setResendConfigured(d.resendConfigured);
      })
      .catch(() => setStatus("Failed to load the email delivery setting."));
  }, []);

  async function switchProvider(id: Provider) {
    const prev = provider;
    setProvider(id);
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/email-provider", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setStatus(
        id === "resend"
          ? "Saved — the next roadmap email goes out via Resend with the PDF attached."
          : "Saved — the next roadmap email goes out via a MailerLite campaign."
      );
    } catch (err) {
      setProvider(prev);
      setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Email delivery</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Which service sends the roadmap email to new leads. Applies immediately; test
        generations never send email either way.
      </p>
      {status && <p className="mt-2 text-sm text-[#337a80]">{status}</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {PROVIDERS.map((p) => {
          const active = provider === p.id;
          const disabled = saving || provider === null || (p.id === "resend" && !resendConfigured);
          return (
            <button
              key={p.id}
              onClick={() => switchProvider(p.id)}
              disabled={disabled}
              className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed ${
                active
                  ? "border-[#337a80] bg-[#337a80]/5 ring-1 ring-[#337a80]"
                  : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">{p.label}</span>
                {active && <span className="text-xs font-bold text-[#337a80]">ACTIVE</span>}
              </div>
              <div className="mt-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">{p.tagline}</div>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-zinc-500">
                {p.points.map((pt) => (
                  <li key={pt}>{pt}</li>
                ))}
              </ul>
              {p.id === "resend" && !resendConfigured && (
                <div className="mt-2 text-xs font-semibold text-amber-600">
                  RESEND_API_KEY is not configured on this deployment.
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
