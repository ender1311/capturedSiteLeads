// Delivers a held homepage-fixes report after Dan or Maggie has looked at it (or fixed its copy).
//
//   npx vite-node --config vitest.config.ts scripts/homepage-fixes-deliver.mts -- \
//     <lead-id> [edited-content.json] [--force]
//
// Loads the lead, takes the edited content file or the row's stored content, re-renders the
// mockup and the PDF from the cached capture of the site, runs the copy rules and prints every
// issue, then delivers it (Blob, Resend with the PDF attached, MailerLite, the row).
// Refuses to send when the rules find errors or the PDF overflows, or when the lead is not
// `held` (it may already have an email), unless --force. Without --force the row is claimed
// (held → processing in one statement) right before sending, so two people delivering the same
// lead at once can't both send; a failure before the email goes out puts it back to held.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeliveredNotRecordedError, deliver } from "@/lib/homepage-fixes/deliver";
import { buildFacts } from "@/lib/homepage-fixes/facts";
import { overflowIssues } from "@/lib/homepage-fixes/pipeline";
import { renderAfter, renderPdf } from "@/lib/homepage-fixes/render";
import { fillReport } from "@/lib/homepage-fixes/render-html";
import { checkContent, type RuleIssue } from "@/lib/homepage-fixes/rules";
import { claimHfLead, domainOf, getCachedCapture, getHfLead, updateHfLead } from "@/lib/homepage-fixes/store";
import type { Asset, ReportContent } from "@/lib/homepage-fixes/types";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The scrape cache keeps one capture per domain (the newest); a held report may sit a while.
const CAPTURE_MAX_AGE_DAYS = 365;

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error("usage: homepage-fixes-deliver.mts <lead-id> [edited-content.json] [--force]");
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  let force = false;
  for (const a of argv) {
    if (a === "--") continue;
    if (a === "--force") force = true;
    else if (a.startsWith("--")) usage(`unknown flag ${a}`);
    else pos.push(a);
  }
  const [leadId, contentFile] = pos;
  if (!leadId || pos.length > 2) usage();
  return { leadId, contentFile, force };
}

const dataUri = (a: Asset) => `data:${a.mime};base64,${a.data.toString("base64")}`;

// The row's content also carries the fact sheet and, for held rows, the issues and reason.
function reportContent(stored: unknown): ReportContent {
  if (!stored || typeof stored !== "object") throw new Error("the lead has no stored content");
  const content: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  for (const key of ["fact_sheet", "issues", "held_reason"]) delete content[key];
  return content as unknown as ReportContent;
}

function assertShape(c: ReportContent): void {
  const ok = c && typeof c === "object" && c.first_section && typeof c.first_section.photo === "string"
    && Array.isArray(c.fixes) && c.fixes.length === 2 && Array.isArray(c.first_section_changes);
  if (!ok) throw new Error("content is missing first_section (with photo), first_section_changes or the two fixes");
}

function printIssues(issues: RuleIssue[]): void {
  if (!issues.length) {
    console.log("Rules: no issues.");
    return;
  }
  for (const i of issues) console.log(`  ${i.level.toUpperCase().padEnd(7)} ${i.field}: ${i.message}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = path.join(ROOT, ".env.local");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.PUPPETEER_EXECUTABLE_PATH && process.platform === "darwin") {
    process.env.PUPPETEER_EXECUTABLE_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  const row = await getHfLead(args.leadId);
  if (!row) throw new Error(`no homepage-fixes lead ${args.leadId}`);
  console.log(`Lead ${row.id}: ${row.name} <${row.email}> ${row.site_url} (outcome ${row.outcome ?? "none"})`);
  if (row.outcome !== "held" && !args.force) {
    throw new Error(`lead is ${row.outcome ?? "without an outcome"}, not held; it may already have had an email. Use --force to send anyway.`);
  }

  const content = args.contentFile
    ? (JSON.parse(fs.readFileSync(path.resolve(args.contentFile), "utf8")) as ReportContent)
    : reportContent(row.content);
  assertShape(content);

  const capture = await getCachedCapture(domainOf(row.site_url), CAPTURE_MAX_AGE_DAYS);
  if (!capture) throw new Error(`no cached capture for ${domainOf(row.site_url)}; it can't be re-rendered`);
  const facts = buildFacts(capture);

  const m = content.first_section.photo.match(/photo-(\d+)\./);
  const index = m ? Number(m[1]) - 1 : -1;
  if (index < 0 || index >= capture.photos.length) {
    throw new Error(`first_section.photo ${content.first_section.photo} is not one of the ${capture.photos.length} cached photos`);
  }

  const issues = checkContent(content, facts.pageText);
  console.log("Rendering the mockup and the PDF...");
  const after = await renderAfter(content.first_section, dataUri(capture.photos[index]), capture.logo ? dataUri(capture.logo) : undefined);
  const rendered = await renderPdf(fillReport(content, { before: dataUri(capture.before), after: dataUri({ data: after, mime: "image/jpeg" }) }));
  for (const o of rendered.overflow) {
    const mapped = overflowIssues(content, [o]);
    issues.push(...(mapped.length ? mapped : [{ field: `page ${o.page}`, level: "error" as const, message: "something runs past the bottom of the page" }]));
  }
  printIssues(issues);

  const errors = issues.filter((i) => i.level === "error");
  if (errors.length && !args.force) {
    console.error(`Not sent: ${errors.length} error(s). Fix the content (or pass --force).`);
    process.exitCode = 1;
    return;
  }

  // Keep the original run's usage on the row; this re-render made no Gemini calls.
  const usage = {
    inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0,
    costUsd: Number(row.cost_usd ?? 0), calls: 0,
  };
  if (!args.force && !(await claimHfLead(row.id, ["held"]))) {
    throw new Error("the lead is no longer held (someone else may be delivering it); not sent");
  }
  try {
    await deliver(row.id, { name: row.name, email: row.email, siteUrl: row.site_url, goal: row.goal ?? "" }, {
      outcome: "sent", content, pdf: rendered.pdf, before: capture.before.data, after, facts, usage,
      model: row.model ?? "",
    });
  } catch (e) {
    if (!args.force && !(e instanceof DeliveredNotRecordedError)) {
      await updateHfLead(row.id, { outcome: "held" }).catch(() => {});
    }
    throw e;
  }
  console.log(`Sent to ${row.email}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
