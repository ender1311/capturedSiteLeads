import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy singleton — env vars aren't available at module-eval time during build,
// and every caller in a request would otherwise construct its own client.
let client: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  client ??= createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  return client;
}

export type Lead = {
  id: string;
  name: string;
  email: string;
  site_url: string;
  pdf_url: string | null;
  status: "processing" | "complete" | "failed" | "rejected";
  error: string | null;
  ip: string | null;
  model: string | null;
  opens: number;
  clicks: number;
  created_at: string;
};
