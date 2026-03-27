import { NextResponse } from "next/server";
import { runEmailIntakePoll } from "@/lib/gmail-intake";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

function authorizeCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization");
  const xCron = request.headers.get("x-cron-secret");
  const bearer =
    auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const token = bearer || xCron?.trim();
  return token === secret;
}

export async function POST(request: Request) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      {
        error: "SUPABASE_CONFIG_MISSING",
        detail:
          "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.",
      },
      { status: 500 },
    );
  }

  try {
    const result = await runEmailIntakePoll(supabase);
    return NextResponse.json(result);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Email intake poll failed.";
    return NextResponse.json({ error: "EMAIL_POLL_FAILED", detail }, { status: 500 });
  }
}

/** Some schedulers only support GET; same auth rules as POST. */
export async function GET(request: Request) {
  return POST(request);
}
