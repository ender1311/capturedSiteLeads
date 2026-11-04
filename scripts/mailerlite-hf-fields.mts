// Creates the MailerLite custom (text) fields that Homepage Fixes writes, if they are missing.
// Idempotent: existing fields are left alone.
//
//   set -a; . ./.env.local; set +a   # or export MAILERLITE_API_KEY
//   npx tsx scripts/mailerlite-hf-fields.mts [--dry-run]
//
// Fields come from lib/mailerlite.ts (name, site_url, pdf_url) and lib/homepage-fixes/deliver.ts
// (goal and the hf_* set); the same list the admin's email-setup endpoint shows as merge fields.
const FIELDS = [
  "name", "site_url", "pdf_url", "goal",
  "hf_outcome", "hf_headline", "hf_fix1_title", "hf_fix2_title", "hf_sent_date",
];
const BASE = "https://connect.mailerlite.com/api";
const dryRun = process.argv.includes("--dry-run");

const key = process.env.MAILERLITE_API_KEY;
if (!key) {
  console.error("MAILERLITE_API_KEY is not set.");
  process.exit(1);
}

async function ml(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
  });
}

async function existingKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let page = 1; page < 20; page++) {
    const res = await ml(`/fields?limit=100&page=${page}`);
    if (!res.ok) throw new Error(`GET /fields failed: ${res.status}`);
    const body = (await res.json()) as { data: { key: string }[]; meta?: { last_page?: number } };
    for (const f of body.data) keys.add(f.key);
    if (page >= (body.meta?.last_page ?? 1)) break;
  }
  return keys;
}

const have = await existingKeys();
let failed = false;
for (const name of FIELDS) {
  if (have.has(name)) {
    console.log(`exists ${name}`);
  } else if (dryRun) {
    console.log(`would create ${name}`);
  } else {
    const res = await ml("/fields", { method: "POST", body: JSON.stringify({ name, type: "text" }) });
    if (res.ok) console.log(`created ${name}`);
    else { console.log(`FAILED ${name} (${res.status})`); failed = true; }
  }
}
process.exit(failed ? 1 : 0);
