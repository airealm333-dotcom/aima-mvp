import { NextResponse } from "next/server";
import { authenticateOdooForMatch, loadOdooMatchConfigFromEnv } from "@/lib/odoo-client-match";

export const runtime = "nodejs";

/**
 * Quick Odoo health check: verifies config → auth → trivial query.
 * Reports timing of each step so you can tell if it's a config issue,
 * auth failure, or slow query.
 */
export async function GET() {
  const t0 = Date.now();

  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) {
    return NextResponse.json(
      {
        ok: false,
        stage: "config",
        error:
          "Odoo not configured. Check ODOO_MATCH_ENABLED, ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY.",
      },
      { status: 503 },
    );
  }

  const configInfo = {
    baseUrl: cfg.baseUrl,
    db: cfg.db,
    username: cfg.username,
    timeoutMs: cfg.timeoutMs,
    fieldUen: cfg.fieldUen,
    fieldLegal: cfg.fieldLegal,
    fieldTrading: cfg.fieldTrading,
  };

  let uid: number;
  let client;
  const authStart = Date.now();
  try {
    const r = await authenticateOdooForMatch(cfg);
    client = r.client;
    uid = r.uid;
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        stage: "auth",
        error: e instanceof Error ? e.message : String(e),
        config: configInfo,
        durationMs: Date.now() - t0,
      },
      { status: 502 },
    );
  }
  const authMs = Date.now() - authStart;

  const queryStart = Date.now();
  let partnerCount: number;
  try {
    const rows = await client.searchReadPartners(uid, [], ["id"], 1);
    partnerCount = rows.length;
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        stage: "query",
        error: e instanceof Error ? e.message : String(e),
        config: configInfo,
        uid,
        authMs,
        durationMs: Date.now() - t0,
      },
      { status: 502 },
    );
  }
  const queryMs = Date.now() - queryStart;

  return NextResponse.json({
    ok: true,
    stage: "ready",
    uid,
    sampleQueryReturnedRows: partnerCount,
    timing: {
      authMs,
      queryMs,
      totalMs: Date.now() - t0,
    },
    config: configInfo,
  });
}
