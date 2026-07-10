import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-8">
      <h1 className="text-3xl font-bold">Captured Site Leads</h1>
      <p className="mt-4 text-zinc-500">
        Intake service for website redesign leads: scrapes the lead&apos;s site,
        generates an AI redesign proposal PDF, kicks off the MailerLite email
        sequence, and tracks engagement.
      </p>
      <ul className="mt-6 list-disc space-y-2 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
        <li>
          <code>POST /api/lead</code> — form webhook endpoint (
          <code>x-lead-secret</code> header required)
        </li>
        <li>
          <code>POST /api/webhook/mailerlite</code> — email open/click events
        </li>
        <li>
          <Link href="/dashboard" className="text-blue-600 hover:underline">
            /dashboard
          </Link>{" "}
          — lead engagement stats
        </li>
      </ul>
    </main>
  );
}
