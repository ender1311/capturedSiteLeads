import { GuideEditor } from "./guide-editor";

export const dynamic = "force-dynamic";

export default function GuidePage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">Roadmap Guide</h1>
      <p className="mt-1 text-sm text-zinc-500">
        This is the live instruction document the AI uses to write every Dream Client Roadmap.
        Edit, save, then run a test generation to see the effect — no emails are sent and no
        leads are recorded by tests.
      </p>
      <div className="mt-6">
        <GuideEditor />
      </div>
    </div>
  );
}
