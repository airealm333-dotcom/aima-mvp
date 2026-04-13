import { NextResponse } from "next/server";
import { authenticateOdooForMatch, loadOdooMatchConfigFromEnv } from "@/lib/odoo-client-match";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  const idParam = searchParams.get("id");
  const debug = searchParams.get("debug") === "1";

  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Odoo not configured" }, { status: 503 });

  try {
    const { client, uid } = await authenticateOdooForMatch(cfg);

    // Debug mode: dump all fields of a partner by name match
    if (debug && q) {
      const rows = (await client.executeKw(
        uid,
        "res.partner",
        "search_read",
        [[["name", "ilike", `%${q}%`]]],
        { fields: [], limit: 3 },
      )) as Record<string, unknown>[];
      return NextResponse.json({ debug: true, count: rows.length, partners: rows });
    }

    // Single partner lookup by ID
    if (idParam) {
      const id = Number(idParam);
      if (!Number.isFinite(id)) return NextResponse.json({ partner: null });
      const rows = await client.searchReadPartners(
        uid,
        [["id", "=", id]],
        ["id", "name", cfg.fieldUen, cfg.fieldLegal, "email"],
        1,
      );
      const r = rows[0];
      if (!r) return NextResponse.json({ partner: null });
      return NextResponse.json({
        partner: {
          id: r.id as number,
          name: (r.name as string) ?? "",
          uen: (r[cfg.fieldUen] as string | null) ?? null,
          legalName: (r[cfg.fieldLegal] as string | null) ?? null,
          email: (r.email as string | null) ?? null,
        },
      });
    }

    if (!q) return NextResponse.json({ partners: [] });

    const like = `%${q}%`;
    // Search across all common UEN/name fields, including Odoo's SG localization
    // field `l10n_sg_unique_entity_number` which is where the real UEN lives.
    const domain = [
      "|", "|", "|", "|", "|",
      ["name", "ilike", like],
      [cfg.fieldUen, "ilike", like],
      ["l10n_sg_unique_entity_number", "ilike", like],
      [cfg.fieldLegal, "ilike", like],
      [cfg.fieldTrading, "ilike", like],
      ["vat", "ilike", like],
    ];

    const rows = await client.searchReadPartners(
      uid,
      domain,
      ["id", "name", cfg.fieldUen, "l10n_sg_unique_entity_number", cfg.fieldLegal, "email", "vat"],
      30,
    );

    console.log(`[odoo-search] q="${q}" matched ${rows.length} partners`);

    const partners = rows.map((r) => ({
      id: r.id as number,
      name: (r.name as string) ?? "",
      uen:
        (r[cfg.fieldUen] as string | null) ??
        (r.l10n_sg_unique_entity_number as string | null) ??
        (r.vat as string | null) ??
        null,
      legalName: (r[cfg.fieldLegal] as string | null) ?? null,
      email: (r.email as string | null) ?? null,
    }));

    return NextResponse.json({ partners });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
