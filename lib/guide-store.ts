import { sql } from "./db";

// Runtime settings in app_config. Only the live report model is left (picked in the Beacon
// Frontier admin through /api/admin/model; read by the homepage-fixes intake).

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

const MODEL_KEY = "llm_model";

export async function getLiveModel(): Promise<string | null> {
  const row = await readConfig(MODEL_KEY);
  return row?.value?.trim() || null;
}

export async function saveModel(model: string): Promise<void> {
  await writeConfig(MODEL_KEY, model);
}
