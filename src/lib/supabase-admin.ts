import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import { getSupabaseRuntimeConfigOrNull } from "@/lib/config";

export type SupabaseAdminBundle = {
  client: ReturnType<typeof createClient>;
  storageBucket: string;
};

export function getSupabaseAdmin(): SupabaseAdminBundle | null {
  const config = getSupabaseRuntimeConfigOrNull();
  if (!config) return null;

  return {
    client: createClient(config.url, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    }),
    storageBucket: config.storageBucket,
  };
}
