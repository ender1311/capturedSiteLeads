import { sql, type Lead } from "@/lib/db";
import { LeadsTable } from "./leads-table";

export const dynamic = "force-dynamic";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-sm text-zinc-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-zinc-900 dark:text-zinc-50">{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-400">{hint}</div>}
    </div>
  );
}

export default async function Dashboard() {
  if (!process.env.DATABASE_URL) {
    return (
      <p className="text-zinc-500">
        The database is not configured. Set <code>DATABASE_URL</code>, then apply{" "}
        <code>db/schema.sql</code>.
      </p>
    );
  }

  // count(*) over() is evaluated before LIMIT, so this is the true total in a
  // single round trip. The ::int cast keeps it a number (bigint arrives as text).
  let rows: (Lead & { total_count: number })[];
  try {
    rows = (await sql()`
      select *, (count(*) over())::int as total_count
      from leads
      order by created_at desc
      limit 500
    `) as (Lead & { total_count: number })[];
  } catch (e) {
    const message = (e as Error).message;
    return (
      <div className="text-red-600">
        <p>Failed to load leads: {message}</p>
        <p className="mt-2 text-sm text-zinc-500">
          The app could not reach the database. Check that the Neon project is active and{" "}
          <code>DATABASE_URL</code> is current.
        </p>
      </div>
    );
  }

  const leads = rows as Lead[];
  const totalLeads = rows[0]?.total_count ?? 0;
  const delivered = leads.filter((l) => l.status === "complete");
  const opened = delivered.filter((l) => l.opens > 0).length;
  const clicked = delivered.filter((l) => l.clicks > 0).length;
  const problems = leads.filter((l) => l.status === "failed" || l.status === "rejected").length;
  const pct = (n: number) =>
    delivered.length ? `${Math.round((n / delivered.length) * 100)}%` : "–";

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">Leads</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Every form submission, its roadmap PDF, and email engagement.
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Total leads" value={totalLeads} />
        <Stat label="Open rate" value={pct(opened)} hint="of delivered reports" />
        <Stat label="Click rate" value={pct(clicked)} hint="of delivered reports" />
        <Stat label="Failed / rejected" value={problems} />
      </div>

      <div className="mt-8">
        <LeadsTable initialLeads={leads} />
      </div>
    </div>
  );
}
