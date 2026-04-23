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

    // Build the `fields` list from the base columns + whichever custom fields
    // are actually configured. Skip null/empty ones so Odoo doesn't reject the query.
    const readFields = ["id", "name", "email", "vat", cfg.fieldUen, "l10n_sg_unique_entity_number"];
    if (cfg.fieldLegal) readFields.push(cfg.fieldLegal);
    if (cfg.fieldTrading) readFields.push(cfg.fieldTrading);
    const fields = [...new Set(readFields.filter((v): v is string => Boolean(v)))];

    // Single partner lookup by ID
    if (idParam) {
      const id = Number(idParam);
      if (!Number.isFinite(id)) return NextResponse.json({ partner: null });
      const rows = await client.searchReadPartners(
        uid,
        [["id", "=", id]],
        fields,
        1,
      );
      const r = rows[0];
      if (!r) return NextResponse.json({ partner: null });
      return NextResponse.json({
        partner: {
          id: r.id as number,
          name: (r.name as string) ?? "",
          uen:
            (r[cfg.fieldUen] as string | null) ??
            (r.l10n_sg_unique_entity_number as string | null) ??
            (r.vat as string | null) ??
            null,
          legalName: cfg.fieldLegal ? ((r[cfg.fieldLegal] as string | null) ?? null) : null,
          email: (r.email as string | null) ?? null,
        },
      });
    }

    if (!q) return NextResponse.json({ partners: [] });

    const like = `%${q}%`;
    // Build domain from only the real fields. Skip null custom fields (not installed).
    const branches: unknown[] = [
      ["name", "ilike", like],
      [cfg.fieldUen, "ilike", like],
      ["l10n_sg_unique_entity_number", "ilike", like],
      ["vat", "ilike", like],
    ];
    if (cfg.fieldLegal) branches.push([cfg.fieldLegal, "ilike", like]);
    if (cfg.fieldTrading) branches.push([cfg.fieldTrading, "ilike", like]);

    // Odoo prefix-OR: N leaves require N-1 leading `'|'`
    const domain: unknown[] = [];
    for (let i = 0; i < branches.length - 1; i += 1) domain.push("|");
    for (const b of branches) domain.push(b);

    const rows = await client.searchReadPartners(uid, domain, fields, 30);

    console.log(`[odoo-search] q="${q}" matched ${rows.length} partners`);

    const partners = rows.map((r) => ({
      id: r.id as number,
      name: (r.name as string) ?? "",
      uen:
        (r[cfg.fieldUen] as string | null) ??
        (r.l10n_sg_unique_entity_number as string | null) ??
        (r.vat as string | null) ??
        null,
      legalName: cfg.fieldLegal ? ((r[cfg.fieldLegal] as string | null) ?? null) : null,
      email: (r.email as string | null) ?? null,
    }));

    return NextResponse.json({ partners });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const data = (e as { data?: unknown }).data;
    const code = (e as { code?: number }).code;
    console.error(
      `[odoo-search] error (q="${q}" id=${idParam}) code=${code ?? "?"} msg="${msg}"`,
    );
    if (data) {
      console.error(`[odoo-search] error data:`, JSON.stringify(data, null, 2).slice(0, 2000));
    }
    return NextResponse.json({ error: msg, code, data }, { status: 500 });
  }
}
