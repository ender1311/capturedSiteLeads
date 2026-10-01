import { sql } from "./db";
import { AGENT_GUIDE } from "./agent-guide";

const KEY = "agent_guide";

export { AGENT_GUIDE as DEFAULT_GUIDE };

type ConfigRow = { value: string; updated_at: string };

async function readConfig(key: string): Promise<ConfigRow | null> {
  const rows = (await sql()`
    select value, updated_at from app_config where key = ${key}
  `) as ConfigRow[];
  return rows[0] ?? null;
}

async function writeConfig(key: string, value: string): Promise<void> {
  await sql()`
    insert into app_config (key, value, updated_at)
    values (${key}, ${value}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

// The guide the LLM actually uses: DB override if saved, else the baked-in default.
export async function getLiveGuide(): Promise<{ value: string; updatedAt: string | null; isDefault: boolean }> {
  const row = await readConfig(KEY);
  if (row?.value?.trim()) {
    return { value: row.value, updatedAt: row.updated_at, isDefault: false };
  }
  return { value: AGENT_GUIDE, updatedAt: null, isDefault: true };
}

export async function saveGuide(value: string): Promise<void> {
  await writeConfig(KEY, value);
}

export async function resetGuide(): Promise<void> {
  await sql()`delete from app_config where key = ${KEY}`;
}

export type EmailProvider = "mailerlite" | "resend";

const EMAIL_PROVIDER_KEY = "email_provider";

// Which service sends the roadmap-delivery email. Defaults to MailerLite:
// its campaign opens/clicks feed the dashboard stats via webhook. Resend
// requires RESEND_API_KEY and the verified capturedsites.com domain.
export async function getEmailProvider(): Promise<EmailProvider> {
  const row = await readConfig(EMAIL_PROVIDER_KEY);
  return row?.value === "resend" ? "resend" : "mailerlite";
}

export async function saveEmailProvider(provider: EmailProvider): Promise<void> {
  await writeConfig(EMAIL_PROVIDER_KEY, provider);
}

const MODEL_KEY = "llm_model";

export async function getLiveModel(): Promise<string | null> {
  const row = await readConfig(MODEL_KEY);
  return row?.value?.trim() || null;
}

export async function saveModel(model: string): Promise<void> {
  await writeConfig(MODEL_KEY, model);
}
