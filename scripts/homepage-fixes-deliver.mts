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
import { redeliverHeld } from "@/lib/homepage-fixes/redeliver";
import type { ReportContent } from "@/lib/homepage-fixes/types";

// The work (render, rules, claim, deliver, revert) is lib/homepage-fixes/redeliver.ts, shared with
// the admin's Re-send button (POST /api/admin/leads/:id/resend).

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envFile = path.join(ROOT, ".env.local");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (!process.env.PUPPETEER_EXECUTABLE_PATH && process.platform === "darwin") {
    process.env.PUPPETEER_EXECUTABLE_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  const content = args.contentFile
    ? (JSON.parse(fs.readFileSync(path.resolve(args.contentFile), "utf8")) as ReportContent)
    : undefined;
  const r = await redeliverHeld(args.leadId, { content, force: args.force, log: (line) => console.log(line) });
  switch (r.status) {
    case "sent":
      return;
    case "not_found":
      throw new Error(`no homepage-fixes lead ${args.leadId}`);
    case "not_held":
      throw new Error(`lead is ${r.outcome ?? "without an outcome"}, not held; it may already have had an email. Use --force to send anyway.`);
    case "blocked":
      console.error(`Not sent: ${r.issues.filter((i) => i.level === "error").length} error(s). Fix the content (or pass --force).`);
      process.exitCode = 1;
      return;
    case "claim_lost":
      throw new Error("the lead is no longer held (someone else may be delivering it); not sent");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
