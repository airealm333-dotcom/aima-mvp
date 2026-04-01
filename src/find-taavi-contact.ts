/**
 * Odoo XML-RPC: search Taavi contacts and print parent_id details.
 *
 * Usage (from aima-mvp root):
 *   npm run find-taavi-contact
 */

import { resolve } from "node:path";
import { config } from "dotenv";
import Odoo from "odoo-xmlrpc";

config({ path: resolve(process.cwd(), ".env.local") });

type OdooXmlRpcClient = {
  connect: (callback: (err: unknown) => void) => void;
  execute_kw: (
    model: string,
    method: string,
    params: unknown[],
    callback: (err: unknown, result: unknown) => void,
  ) => void;
};

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function findTaaviContact(): void {
  const url = requireEnv("ODOO_URL");
  const db = requireEnv("ODOO_DB");
  const username = requireEnv("ODOO_USERNAME");
  const password = requireEnv("ODOO_API_KEY");

  const odoo = new Odoo({
    url,
    db,
    username,
    password,
  }) as OdooXmlRpcClient;

  odoo.connect((err) => {
    if (err) {
      console.error("[FAIL] Connection failed:", err);
      process.exit(1);
    }
    console.log("[OK] Connected to Odoo");

    const domain = [["name", "ilike", "Taavi"]];
    const params = [
      [domain],
      { fields: ["id", "name", "email", "parent_id", "x_ro_mail_recipient"] },
    ];

    odoo.execute_kw(
      "res.partner",
      "search_read",
      params,
      (searchErr, result) => {
        if (searchErr) {
          console.error("[FAIL] Error searching Taavi contacts:", searchErr);
          process.exit(1);
        }
        console.log("[OK] Taavi contacts:");
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      },
    );
  });
}

findTaaviContact();
