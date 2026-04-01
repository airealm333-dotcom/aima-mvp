/**
 * Odoo XML-RPC: create child contact under Industria with mail recipient flag.
 *
 * Usage (from aima-mvp root):
 *   npm run add-industria-contact
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

function addIndustriaContact(): void {
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
    console.log("[OK] Connected");

    const contactData = {
      name: "Taavi Kusima",
      email: "taavi@industria.one",
      parent_id: 349,
      type: "contact",
      x_ro_mail_recipient: true,
    };

    odoo.execute_kw(
      "res.partner",
      "create",
      [[contactData]],
      (createErr, id) => {
        if (createErr) {
          console.error("[FAIL] Create failed:", createErr);
          process.exit(1);
        }
        console.log("[OK] Contact created with ID:", id);
        console.log("[OK] Email: taavi@industria.one");
        console.log("[OK] x_ro_mail_recipient: true");
        process.exit(0);
      },
    );
  });
}

addIndustriaContact();
