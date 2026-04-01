/**
 * Odoo XML-RPC: load env, connect, set test flags on res.partner records.
 *
 * Usage (from aima-mvp root):
 *   npm run test-odoo
 *
 * Optional env overrides:
 *   TEST_ODOO_COMPANY_PARTNER_ID (default 2827) - x_ro_service_active
 *   TEST_ODOO_CONTACT_PARTNER_ID (default 2183) - x_ro_mail_recipient
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

function buildWriteParams(
  ids: number[],
  values: Record<string, unknown>,
): unknown[] {
  const inParams: unknown[] = [];
  inParams.push(ids);
  inParams.push(values);
  return [inParams];
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function setupTestData(): void {
  const url = requireEnv("ODOO_URL");
  const db = requireEnv("ODOO_DB");
  const username = requireEnv("ODOO_USERNAME");
  const password = requireEnv("ODOO_API_KEY");

  const companyId = Number(process.env.TEST_ODOO_COMPANY_PARTNER_ID ?? "2827");
  const contactId = Number(process.env.TEST_ODOO_CONTACT_PARTNER_ID ?? "2183");

  if (!Number.isFinite(companyId) || !Number.isFinite(contactId)) {
    console.error(
      "Invalid TEST_ODOO_COMPANY_PARTNER_ID or TEST_ODOO_CONTACT_PARTNER_ID",
    );
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

    odoo.execute_kw(
      "res.partner",
      "write",
      buildWriteParams([companyId], { x_ro_service_active: true }),
      (writeErr) => {
        if (writeErr) {
          console.error("[FAIL] Company update failed:", writeErr);
          process.exit(1);
        }
        console.log(
          `[OK] Company (id=${companyId}): x_ro_service_active = true`,
        );

        odoo.execute_kw(
          "res.partner",
          "write",
          buildWriteParams([contactId], { x_ro_mail_recipient: true }),
          (writeErr2) => {
            if (writeErr2) {
              console.error("[FAIL] Contact update failed:", writeErr2);
              process.exit(1);
            }
            console.log(
              `[OK] Contact (id=${contactId}): x_ro_mail_recipient = true`,
            );
            process.exit(0);
          },
        );
      },
    );
  });
}

setupTestData();
