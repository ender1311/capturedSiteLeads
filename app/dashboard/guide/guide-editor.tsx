"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MODEL_OPTIONS, costPerReport } from "@/lib/models";

type GuideState = {
  value: string;
  updatedAt: string | null;
  isDefault: boolean;
};

type Heading = { line: number; level: number; text: string };

function parseHeadings(text: string): Heading[] {
  return text.split("\n").flatMap((raw, line) => {
    const m = raw.match(/^(#{1,3})\s+(.*)/);
    return m ? [{ line, level: m[1].length, text: m[2].trim() }] : [];
  });
}

export function GuideEditor() {
  const [guide, setGuide] = useState<GuideState | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [testName, setTestName] = useState("Jami");
  const [testUrl, setTestUrl] = useState("");
  const [testPain, setTestPain] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ pdf_url?: string; model?: string; error?: string } | null>(null);

  const [model, setModel] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [modelStatus, setModelStatus] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/guide")
      .then((r) => r.json())
      .then((g: GuideState) => {
        setGuide(g);
        setDraft(g.value);
      })
      .catch(() => setStatus({ kind: "err", text: "Failed to load the guide." }));
    fetch("/api/model")
      .then((r) => r.json())
      .then((m: { current: string }) => setModel(m.current))
      .catch(() => setModel(null));
  }, []);

  async function switchModel(id: string) {
    const prev = model;
    setModel(id);
    setSavingModel(true);
    setModelStatus(null);
    try {
      const res = await fetch("/api/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setModelStatus("Saved — the next PDF uses this model.");
    } catch (err) {
      setModel(prev);
      setModelStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingModel(false);
    }
  }

  const headings = useMemo(() => parseHeadings(draft), [draft]);
  const dirty = guide !== null && draft !== guide.value;
  const tokens = Math.round(draft.length / 3.7);
  const activeModel = MODEL_OPTIONS.find((m) => m.id === model) ?? MODEL_OPTIONS[0];
  const guideCostPer1000 = tokens * activeModel.inputPerToken * 1000;

  const jumpTo = useCallback(
    (line: number) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const lines = draft.split("\n");
      const pos = lines.slice(0, line).join("\n").length + (line > 0 ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(pos, pos + (lines[line]?.length ?? 0));
      // scroll the heading into view within the textarea
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      ta.scrollTop = Math.max(0, line * lineHeight - 80);
    },
    [draft]
  );

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/guide", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: draft }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setGuide({ value: draft, updatedAt: new Date().toISOString(), isDefault: false });
      setStatus({ kind: "ok", text: "Saved — the next PDF will use this version." });
    } catch (err) {
      setStatus({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    if (!confirm("Discard the edited version and go back to the built-in guide?")) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/guide", { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setGuide({ value: body.value, updatedAt: null, isDefault: true });
      setDraft(body.value);
      setStatus({ kind: "ok", text: "Reset to the built-in default." });
    } catch (err) {
      setStatus({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (dirty && !confirm("You have unsaved changes — the test uses the last SAVED version. Run anyway?")) {
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/test-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: testName, site_url: testUrl, pain: testPain || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setTestResult({ pdf_url: body.pdf_url, model: body.model });
    } catch (err) {
      setTestResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  if (!guide) {
    return <p className="text-zinc-500">Loading the live guide…</p>;
  }

  return (
    <div className="space-y-6">
      {/* Editor */}
      <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="text-sm text-zinc-500">
            {guide.isDefault ? (
              <span>Using the <strong>built-in default</strong></span>
            ) : (
              <span>
                Custom version{guide.updatedAt ? ` · saved ${new Date(guide.updatedAt).toLocaleString()}` : ""}
              </span>
            )}
            <span className="mx-2">·</span>
            ~{tokens.toLocaleString()} tokens · guide adds ≈ $
            {guideCostPer1000 < 10 ? guideCostPer1000.toFixed(2) : Math.round(guideCostPer1000)} per 1,000 reports
            {dirty && <span className="ml-2 font-semibold text-amber-600">Unsaved changes</span>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={resetToDefault}
              disabled={saving || guide.isDefault}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Reset to default
            </button>
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="rounded-lg bg-[#337a80] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#2a6d72] disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save & go live"}
            </button>
          </div>
        </div>

        {status && (
          <div
            className={`border-b px-4 py-2 text-sm ${
              status.kind === "ok"
                ? "border-green-100 bg-green-50 text-green-800"
                : "border-red-100 bg-red-50 text-red-700"
            }`}
          >
            {status.text}
          </div>
        )}

        <div className="flex">
          <aside className="hidden w-60 flex-none border-r border-zinc-100 p-3 md:block dark:border-zinc-800">
            <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Sections
            </div>
            <div className="max-h-[520px] space-y-0.5 overflow-y-auto">
              {headings.map((h, i) => (
                <button
                  key={i}
                  onClick={() => jumpTo(h.line)}
                  className="block w-full truncate rounded px-2 py-1 text-left text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))}
              {headings.length === 0 && (
                <p className="px-2 text-xs text-zinc-400">No headings found — add lines starting with # to navigate.</p>
              )}
            </div>
          </aside>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-[560px] w-full resize-y bg-transparent p-4 font-mono text-[13px] leading-5 text-zinc-800 outline-none dark:text-zinc-200"
          />
        </div>
      </div>

      {/* Model picker */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Copywriting model</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Which AI writes the roadmaps. Applies immediately to all new PDFs (form leads and tests).
          Cost estimates use the measured ~5.5K in / 1K out tokens per report.
        </p>
        {modelStatus && <p className="mt-2 text-sm text-[#337a80]">{modelStatus}</p>}
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {MODEL_OPTIONS.map((m) => {
            const per = costPerReport(m);
            const active = model === m.id;
            return (
              <button
                key={m.id}
                onClick={() => switchModel(m.id)}
                disabled={savingModel}
                className={`rounded-xl border p-3 text-left transition ${
                  active
                    ? "border-[#337a80] bg-[#337a80]/5 ring-1 ring-[#337a80]"
                    : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">{m.label}</span>
                  {active && <span className="text-xs font-bold text-[#337a80]">ACTIVE</span>}
                </div>
                <div className="mt-1 text-xs text-zinc-500">{m.description}</div>
                <div className="mt-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  ~${per < 0.01 ? per.toFixed(4) : per.toFixed(3)}/PDF · ~${Math.round(per * 1000)}/1,000 leads
                </div>
              </button>
            );
          })}
        </div>
        {model && !MODEL_OPTIONS.some((m) => m.id === model) && (
          <p className="mt-3 text-xs text-zinc-500">
            Currently using a custom model: <code>{model}</code>
          </p>
        )}
      </div>

      {/* Test generation */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Test a generation</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Runs the real pipeline (scrape → AI → PDF) with the <strong>saved</strong> guide.
          Nothing is emailed and no lead is recorded. Takes ~30–60 seconds; costs under a cent.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_2fr_2fr_auto]">
          <input
            value={testName}
            onChange={(e) => setTestName(e.target.value)}
            placeholder="Name"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
          <input
            value={testUrl}
            onChange={(e) => setTestUrl(e.target.value)}
            placeholder="Photographer site URL"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
          <input
            value={testPain}
            onChange={(e) => setTestPain(e.target.value)}
            placeholder="Stated pain (optional, e.g. getting ghosted)"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
          <button
            onClick={runTest}
            disabled={testing || !testUrl || !testName}
            className="rounded-lg bg-[#a0a93f] px-4 py-2 text-sm font-semibold text-[#143133] hover:bg-[#8f9838] disabled:opacity-40"
          >
            {testing ? "Generating…" : "Generate test PDF"}
          </button>
        </div>
        {testing && (
          <p className="mt-3 text-sm text-zinc-500">Scraping the site and writing the roadmap…</p>
        )}
        {testResult?.pdf_url && (
          <p className="mt-3 text-sm">
            <a
              href={testResult.pdf_url}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[#337a80] hover:underline"
            >
              Open the test PDF →
            </a>
            {testResult.model && (
              <span className="ml-2 text-xs text-zinc-500">written by {testResult.model}</span>
            )}
          </p>
        )}
        {testResult?.error && (
          <p className="mt-3 text-sm text-red-600">Test failed: {testResult.error}</p>
        )}
      </div>
    </div>
  );
}
