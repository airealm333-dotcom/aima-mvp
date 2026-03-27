import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      {
        error: "SUPABASE_CONFIG_MISSING",
        detail:
          "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.",
      },
      { status: 500 },
    );
  }

  try {
    const { data, error } = await supabase.client
      .from("exceptions")
      .select(
        "id, drid, type, status, root_cause, suggested_action, created_at",
      )
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      return NextResponse.json(
        {
          error: "FAILED_TO_FETCH_OPEN_EXCEPTIONS",
          detail: error.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ items: data ?? [] });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "SUPABASE_QUERY_FAILED", detail },
      { status: 500 },
    );
  }
}
