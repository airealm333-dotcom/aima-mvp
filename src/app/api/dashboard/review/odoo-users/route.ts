import { NextResponse } from "next/server";
import { authenticateOdooForMatch, loadOdooMatchConfigFromEnv } from "@/lib/odoo-client-match";

export const runtime = "nodejs";

/**
 * Lists Odoo internal users (res.users) for the accounting manager dropdown.
 * Only returns non-shared (internal) users, filterable by ?q=<name|email>.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();

  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Odoo not configured" }, { status: 503 });

  try {
    const { client, uid } = await authenticateOdooForMatch(cfg);

    const domain: unknown[] = [["share", "=", false], ["active", "=", true]];
    if (q) {
      const like = `%${q}%`;
      domain.push("|", ["name", "ilike", like], ["login", "ilike", like]);
    }

    const rows = await client.searchRead(
      uid,
      "res.users",
      domain,
      ["id", "name", "login"],
      200,
    );

    const users = rows.map((r) => ({
      id: r.id as number,
      name: (r.name as string) ?? "",
      email: (r.login as string) ?? "",
    }));

    return NextResponse.json({ users });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
