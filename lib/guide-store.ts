import { supabaseAdmin } from "./supabase";
import { AGENT_GUIDE } from "./agent-guide";

const KEY = "agent_guide";

export { AGENT_GUIDE as DEFAULT_GUIDE };

// The guide the LLM actually uses: DB override if saved, else the baked-in default.
export async function getLiveGuide(): Promise<{ value: string; updatedAt: string | null; isDefault: boolean }> {
  const { data } = await supabaseAdmin()
    .from("app_config")
    .select("value, updated_at")
    .eq("key", KEY)
    .maybeSingle();
  if (data?.value?.trim()) {
    return { value: data.value, updatedAt: data.updated_at, isDefault: false };
  }
  return { value: AGENT_GUIDE, updatedAt: null, isDefault: true };
}

export async function saveGuide(value: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("app_config")
    .upsert({ key: KEY, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Guide save failed: ${error.message}`);
}

export async function resetGuide(): Promise<void> {
  const { error } = await supabaseAdmin().from("app_config").delete().eq("key", KEY);
  if (error) throw new Error(`Guide reset failed: ${error.message}`);
}

const MODEL_KEY = "llm_model";

export async function getLiveModel(): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from("app_config")
    .select("value")
    .eq("key", MODEL_KEY)
    .maybeSingle();
  return data?.value?.trim() || null;
}

export async function saveModel(model: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("app_config")
    .upsert({ key: MODEL_KEY, value: model, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Model save failed: ${error.message}`);
}
