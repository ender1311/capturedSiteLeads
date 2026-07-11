"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Lead } from "@/lib/supabase";

const STATUS_STYLES: Record<string, string> = {
  complete: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  rejected: "bg-amber-100 text-amber-800",
  processing: "bg-zinc-100 text-zinc-600",
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function LeadsTable({ initialLeads }: { initialLeads: Lead[] }) {
  const router = useRouter();
  const [leads, setLeads] = useState(initialLeads);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function handleDelete(lead: Lead) {
    if (!confirm(`Delete lead "${lead.name}" (${lead.email})? This cannot be undone.`)) return;
    setDeleting(lead.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setLeads((prev) => prev.filter((l) => l.id !== lead.id));
    } catch (err) {
      setMessage(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <span className="text-sm text-zinc-500">
          {leads.length} lead{leads.length === 1 ? "" : "s"}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => router.refresh()}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
          <a
            href="/api/leads/export"
            className="rounded-lg bg-[#337a80] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#2a6d72]"
          >
            Export CSV
          </a>
        </div>
      </div>

      {message && (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">{message}</div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-zinc-500">
            <tr className="border-b border-zinc-100 dark:border-zinc-800">
              <th className="px-4 py-3 font-medium">Lead</th>
              <th className="px-4 py-3 font-medium">Site</th>
              <th className="px-4 py-3 font-medium">Report</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Opens</th>
              <th className="px-4 py-3 text-right font-medium">Clicks</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-zinc-500">
                  No leads yet — submissions from the Free Audit form will appear here.
                </td>
              </tr>
            )}
            {leads.map((lead) => (
              <tr
                key={lead.id}
                className="group border-b border-zinc-50 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/40"
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-zinc-900 dark:text-zinc-100">{lead.name}</div>
                  <div className="text-xs text-zinc-500">{lead.email}</div>
                </td>
                <td className="px-4 py-3">
                  <a
                    href={lead.site_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#337a80] hover:underline"
                  >
                    {lead.site_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  </a>
                </td>
                <td className="px-4 py-3">
                  {lead.pdf_url ? (
                    <a
                      href={lead.pdf_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-[#337a80] hover:underline"
                    >
                      View PDF
                    </a>
                  ) : (
                    <span className="text-zinc-400">–</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    title={lead.error ?? undefined}
                    className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[lead.status] ?? STATUS_STYLES.processing}`}
                  >
                    {lead.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{lead.opens}</td>
                <td className="px-4 py-3 text-right tabular-nums">{lead.clicks}</td>
                <td className="whitespace-nowrap px-4 py-3 text-zinc-500" title={new Date(lead.created_at).toLocaleString()}>
                  {timeAgo(lead.created_at)}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => handleDelete(lead)}
                    disabled={deleting === lead.id}
                    className="rounded-md px-2 py-1 text-xs text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    title="Delete lead"
                  >
                    {deleting === lead.id ? "…" : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
