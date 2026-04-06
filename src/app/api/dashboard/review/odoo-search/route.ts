import { NextResponse } from "next/server";
import { authenticateOdooForMatch, loadOdooMatchConfigFromEnv } from "@/lib/odoo-client-match";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  const idParam = searchParams.get("id");

  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Odoo not configured" }, { status: 503 });

  try {
    const { client, uid } = await authenticateOdooForMatch(cfg);

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
    const domain = [
      "|", "|", "|",
      ["name", "ilike", like],
      [cfg.fieldUen, "ilike", like],
      [cfg.fieldLegal, "ilike", like],
      [cfg.fieldTrading, "ilike", like],
    ];

    const rows = await client.searchReadPartners(
      uid,
      domain,
      ["id", "name", cfg.fieldUen, cfg.fieldLegal, "email"],
      30,
    );

    const partners = rows.map((r) => ({
      id: r.id as number,
      name: (r.name as string) ?? "",
      uen: (r[cfg.fieldUen] as string | null) ?? null,
      legalName: (r[cfg.fieldLegal] as string | null) ?? null,
      email: (r.email as string | null) ?? null,
    }));

    return NextResponse.json({ partners });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
