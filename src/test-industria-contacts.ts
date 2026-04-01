/**
 * Odoo XML-RPC: connect and list Industria child contacts.
 *
 * Usage (from aima-mvp root):
 *   npm run test-industria-contacts
 *
 * Optional env override:
 *   TEST_ODOO_PARENT_ID (default 349)
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

function checkIndustriaContacts(): void {
  const url = requireEnv("ODOO_URL");
  const db = requireEnv("ODOO_DB");
  const username = requireEnv("ODOO_USERNAME");
  const password = requireEnv("ODOO_API_KEY");
  const parentId = Number(process.env.TEST_ODOO_PARENT_ID ?? "349");

  if (!Number.isFinite(parentId) || parentId <= 0) {
    console.error("Invalid TEST_ODOO_PARENT_ID (must be a positive number).");
    process.exit(1);
  }

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

    const domain = [["parent_id", "=", parentId]];
    const params = [
      [domain],
      { fields: ["id", "name", "email", "x_ro_mail_recipient"] },
    ];

    odoo.execute_kw(
      "res.partner",
      "search_read",
      params,
      (searchErr, result) => {
        if (searchErr) {
          console.error("[FAIL] Error reading Industria contacts:", searchErr);
          process.exit(1);
        }
        console.log(`[OK] Industria contacts (parent_id=${parentId}):`);
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      },
    );
  });
}

checkIndustriaContacts();
