/**
 * Odoo XML-RPC: read Taavi contact details by exact partner id.
 *
 * Usage (from aima-mvp root):
 *   npm run check-taavi-email
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

function checkTaaviEmail(): void {
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

    const params = [
      [[2828]],
      { fields: ["id", "name", "email", "parent_id", "x_ro_mail_recipient"] },
    ];

    odoo.execute_kw("res.partner", "read", params, (readErr, result) => {
      if (readErr) {
        console.error("[FAIL] Error reading Taavi details:", readErr);
        process.exit(1);
      }
      console.log("[OK] Taavi details:");
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    });
  });
}

checkTaaviEmail();
