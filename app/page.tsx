export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center p-8">
      <h1 className="text-3xl font-bold">Captured Site Leads</h1>
      <p className="mt-4 text-zinc-500">
        The service behind Captured Sites&apos; free &ldquo;Your Top Homepage Fixes&rdquo; report:
        it takes the homepage-fixes form, looks at the photographer&apos;s homepage, writes and
        emails their report, and tracks opens and clicks.
      </p>
      <ul className="mt-6 list-disc space-y-2 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
        <li>
          <code>POST /api/homepage-fixes</code> — the form webhook (<code>secret</code> required)
        </li>
        <li>
          <code>POST /api/webhook/resend</code>, <code>POST /api/webhook/mailerlite</code> — email
          open/click events
        </li>
        <li>
          Leads, reports and numbers:{" "}
          <a href="https://beaconfrontier.com/admin/site/capturedsites" className="text-blue-600 hover:underline">
            the Captured Sites page in the Beacon Frontier admin
          </a>
        </li>
      </ul>
    </main>
  );
}
