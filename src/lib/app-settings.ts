/**
 * Persistent app settings stored in Supabase `app_settings` table.
 *
 * Required SQL (run once):
 *   create table if not exists app_settings (
 *     key   text primary key,
 *     value text not null,
 *     updated_at timestamptz default now()
 *   );
 *   insert into app_settings (key, value)
 *     values ('dispatch_mode', 'item_ready')
 *     on conflict do nothing;
 */

import { getSupabaseAdmin } from "@/lib/supabase-admin";

export type DispatchMode =
  | "item_ready"        // dispatch each clean item regardless of siblings
  | "document_complete"; // only dispatch when ALL items in the document are clean

const DEFAULTS: Record<string, string> = {
  dispatch_mode: "item_ready",
};

export async function getSetting(key: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return DEFAULTS[key] ?? "";

  const { data } = await supabase.client
    .from("app_settings" as never)
    .select("value")
    .eq("key", key)
    .maybeSingle() as { data: { value: string } | null };

  return data?.value ?? DEFAULTS[key] ?? "";
}

export async function setSetting(key: string, value: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;

  await supabase.client
    .from("app_settings" as never)
    .upsert({ key, value, updated_at: new Date().toISOString() } as never, {
      onConflict: "key",
    });
}

export async function getDispatchMode(): Promise<DispatchMode> {
  const v = await getSetting("dispatch_mode");
  return v === "document_complete" ? "document_complete" : "item_ready";
}
