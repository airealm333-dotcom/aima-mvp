import { NextResponse } from "next/server";
import { runEmailIntakePoll } from "@/lib/gmail-queue";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Trigger one intake poll tick from the dashboard (no auth required beyond Supabase). */
export async function POST() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "SUPABASE_CONFIG_MISSING" }, { status: 500 });
  }

  try {
    const result = await runEmailIntakePoll(supabase);
    return NextResponse.json(result);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "INTAKE_POLL_FAILED", detail }, { status: 500 });
  }
}
