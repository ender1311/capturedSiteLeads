import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { supabaseAdmin, type Lead } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-sm text-zinc-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
    </div>
  );
}

export default async function Dashboard() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin?callbackUrl=/dashboard");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="mt-4 text-zinc-500">
          Supabase is not configured yet. Set <code>SUPABASE_URL</code> and{" "}
          <code>SUPABASE_SERVICE_ROLE_KEY</code>, then run{" "}
          <code>supabase/schema.sql</code>.
        </p>
      </main>
    );
  }

  const { data, error } = await supabaseAdmin()
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="mt-4 text-red-600">Failed to load leads: {error.message}</p>
      </main>
    );
  }

  const leads = (data ?? []) as Lead[];
  const total = leads.length;
  const opened = leads.filter((l) => l.opens > 0).length;
  const clicked = leads.filter((l) => l.clicks > 0).length;
  const failed = leads.filter((l) => l.status === "failed").length;
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "–");

  return (
    <main className="mx-auto max-w-6xl p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Lead Engagement Dashboard</h1>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/api/auth/signin" });
          }}
        >
          <span className="mr-3 text-sm text-zinc-500">
            {session.user.email}
          </span>
          <button className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Sign out
          </button>
        </form>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Total leads" value={total} />
        <Stat label="Open rate" value={pct(opened)} />
        <Stat label="Click rate" value={pct(clicked)} />
        <Stat label="Pipeline failures" value={failed} />
      </div>

      <div className="mt-8 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3">Report</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Opens</th>
              <th className="px-4 py-3 text-right">Clicks</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                  No leads yet.
                </td>
              </tr>
            )}
            {leads.map((lead) => (
              <tr
                key={lead.id}
                className="border-t border-zinc-100 dark:border-zinc-800"
              >
                <td className="px-4 py-3 font-medium">{lead.name}</td>
                <td className="px-4 py-3">{lead.email}</td>
                <td className="px-4 py-3">
                  <a
                    href={lead.site_url}
                    className="text-blue-600 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {lead.site_url.replace(/^https?:\/\//, "")}
                  </a>
                </td>
                <td className="px-4 py-3">
                  {lead.pdf_url ? (
                    <a
                      href={lead.pdf_url}
                      className="text-blue-600 hover:underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      PDF
                    </a>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      lead.status === "complete"
                        ? "rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800"
                        : lead.status === "failed"
                          ? "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800"
                          : lead.status === "rejected"
                            ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                            : "rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600"
                    }
                  >
                    {lead.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">{lead.opens}</td>
                <td className="px-4 py-3 text-right">{lead.clicks}</td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-500">
                  {new Date(lead.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
