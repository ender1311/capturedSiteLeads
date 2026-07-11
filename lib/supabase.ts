import { createClient } from "@supabase/supabase-js";

export function supabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export type Lead = {
  id: string;
  name: string;
  email: string;
  site_url: string;
  pdf_url: string | null;
  status: "processing" | "complete" | "failed";
  error: string | null;
  opens: number;
  clicks: number;
  created_at: string;
};
