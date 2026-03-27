import { NextResponse } from "next/server";
import fetch from "node-fetch";

import { getSupabaseRuntimeConfigOrNull } from "@/lib/config";

export const runtime = "nodejs";

export async function GET() {
  const config = getSupabaseRuntimeConfigOrNull();
  if (!config) {
    return NextResponse.json(
      {
        error: "SUPABASE_CONFIG_MISSING",
        detail:
          "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.",
      },
      { status: 500 },
    );
  }

  const url = `${config.url}/rest/v1/documents?select=id&limit=1`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
    });

    const bodyText = await res.text();

    return NextResponse.json({
      supabaseUrlLoaded: true,
      requestStatus: res.status,
      serviceRoleKeyLen: config.serviceRoleKey.length,
      responseBodyHead: bodyText.slice(0, 200),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Unknown error";
    const cause = e instanceof Error && e.cause ? String(e.cause) : "No cause";
    return NextResponse.json(
      {
        supabaseUrlLoaded: true,
        requestStatus: null,
        responseBodyHead: null,
        error: "SUPABASE_DIRECT_FETCH_FAILED",
        detail,
        cause,
        serviceRoleKeyLen: config.serviceRoleKey.length,
        serviceRoleKeyHasWhitespace: /\s/.test(config.serviceRoleKey),
      },
      { status: 500 },
    );
  }
}
