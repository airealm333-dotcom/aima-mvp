import { NextResponse } from "next/server";
import { authenticateOdooForMatch, loadOdooMatchConfigFromEnv } from "@/lib/odoo-client-match";

export const runtime = "nodejs";

/**
 * Diagnostic: list res.partner fields matching a filter.
 * Use ?q=uen or ?q=legal or ?q=trading to check if specific fields exist.
 * Returns { fields: [{ name, type, string }] } of matching fields.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();

  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Odoo not configured" }, { status: 503 });

  try {
    const { client, uid } = await authenticateOdooForMatch(cfg);

    const result = (await client.executeKw(
      uid,
      "res.partner",
      "fields_get",
      [],
      { attributes: ["string", "type", "required"] },
    )) as Record<string, { string?: string; type?: string; required?: boolean }>;

    const entries = Object.entries(result).map(([name, meta]) => ({
      name,
      type: meta.type ?? "",
      label: meta.string ?? "",
    }));

    const filtered = q
      ? entries.filter(
          (f) =>
            f.name.toLowerCase().includes(q) ||
            f.label.toLowerCase().includes(q),
        )
      : entries;

    filtered.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      totalFields: entries.length,
      matched: filtered.length,
      fields: filtered,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
