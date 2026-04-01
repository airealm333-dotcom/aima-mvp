/**
 * Integration smoke test: D3 client match + D4 contact resolution (JSON-RPC, same as intake).
 *
 * Usage (from aima-mvp root):
 *   npm run test-d3-d4
 *
 * Requires .env.local: ODOO_MATCH_ENABLED=true and ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY.
 * Optional: TEST_D3_RECIPIENT_NAME (default "TEST COMPANY PTE. LTD.").
 * Optional Vitest: set ODOO_MATCH_E2E=true to run src/lib/odoo-d3-d4.integration.test.ts via npm test.
 */

import { resolve } from "node:path";
import { config } from "dotenv";
import {
  authenticateOdooForMatch,
  buildClientMatchInputs,
  loadOdooMatchConfigFromEnv,
  resolveOdooRecipientContact,
  runOdooClientMatch,
} from "../src/lib/odoo-client-match";

config({ path: resolve(process.cwd(), ".env.local") });

async function main(): Promise<void> {
  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) {
    console.error(
      "[FAIL] Odoo match config missing. Set ODOO_MATCH_ENABLED=true and ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY in .env.local",
    );
    process.exit(1);
  }

  const recipientName =
    process.env.TEST_D3_RECIPIENT_NAME?.trim() || "TEST COMPANY PTE. LTD.";
  const inputs = buildClientMatchInputs({ recipient_name: recipientName }, "");

  console.log("=== D3 CLIENT MATCHING ===", { recipientName, inputs });

  const { client, uid } = await authenticateOdooForMatch(cfg);
  const matchResult = await runOdooClientMatch(client, uid, cfg, inputs);

  console.log("Match result:", {
    status: matchResult.status,
    partnerId: matchResult.partnerId,
    method: matchResult.method,
    score: matchResult.score,
    candidates: matchResult.candidates?.slice(0, 5),
  });

  if (matchResult.status !== "matched" || matchResult.partnerId == null) {
    console.log(
      "[INFO] D3 did not return a single matched partner; skipping D4.",
    );
    console.log("[OK] Flow finished (no uncaught errors).");
    process.exit(0);
  }

  console.log("=== D4 CONTACT LOOKUP ===", {
    partnerId: matchResult.partnerId,
  });

  const contactResult = await resolveOdooRecipientContact({
    client,
    uid,
    cfg,
    partnerId: matchResult.partnerId,
  });

  console.log("Contact result:", {
    email: contactResult.email || "(none)",
    resolutionMethod: contactResult.resolutionMethod,
    contactId: contactResult.contactId,
  });

  if (contactResult.resolutionMethod === "not_found" || !contactResult.email) {
    console.log(
      "[INFO] D4 did not resolve a recipient email (partner may have no contact email in Odoo).",
    );
  }

  console.log("[OK] D3/D4 flow completed (no uncaught errors).");
  process.exit(0);
}

main().catch((err) => {
  console.error("[FAIL] Uncaught error:", err);
  process.exit(1);
});
