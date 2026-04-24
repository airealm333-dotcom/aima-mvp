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

    // Debug mode: dump all important fields of a partner by name match or by id
    if (debug) {
      const domain: unknown[] = idParam
        ? [["id", "=", Number(idParam)]]
        : q
          ? [["name", "ilike", `%${q}%`]]
          : [];
      if (domain.length === 0) {
        return NextResponse.json({ error: "Provide ?q=<name> or ?id=<n>" }, { status: 400 });
      }

      // Fetch ALL field names first via fields_get, then read them all.
      // This reveals any custom x_*/l10n_*/spade_* fields added by extension modules.
      const fieldsMeta = (await client.executeKw(
        uid,
        "res.partner",
        "fields_get",
        [],
        { attributes: ["type"] },
      )) as Record<string, { type?: string }>;

      // Skip field types that are expensive or break search_read in Odoo 19:
      // - binary (images/files — huge payload)
      // - one2many (can be heavy reverse relations)
      // - json / html (sometimes break on special chars)
      // Keep: char, text, boolean, integer, float, date, datetime, selection,
      //       many2one, many2many, reference (these are the interesting ones)
      const keepTypes = new Set([
        "char",
        "text",
        "boolean",
        "integer",
        "float",
        "monetary",
        "date",
        "datetime",
        "selection",
        "many2one",
        "many2many",
        "reference",
      ]);
      const debugFields = Object.entries(fieldsMeta)
        .filter(([, meta]) => keepTypes.has(meta.type ?? ""))
        .map(([name]) => name);

      const rows = (await client.executeKw(
        uid,
        "res.partner",
        "search_read",
        [domain],
        { fields: debugFields, limit: 5, context: { active_test: false } },
      )) as Record<string, unknown>[];

      // Also resolve referenced contacts (customer_contact_ids / signing_authority_ids) with their emails
      const refIds = new Set<number>();
      for (const r of rows) {
        for (const key of ["customer_contact_ids", "signing_authority_ids", "child_ids"] as const) {
          const v = r[key];
          if (Array.isArray(v)) {
            for (const id of v) if (typeof id === "number") refIds.add(id);
          }
        }
      }
      const referenced =
        refIds.size > 0
          ? ((await client.executeKw(
              uid,
              "res.partner",
              "search_read",
              [[["id", "in", [...refIds]]]],
              {
                fields: ["id", "name", "email", "parent_id", "is_company", "active"],
                limit: 200,
                context: { active_test: false },
              },
            )) as Record<string, unknown>[])
          : [];

      return NextResponse.json({ debug: true, count: rows.length, partners: rows, referenced_contacts: referenced });
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
