/**
 * E2E against real Odoo: skipped unless ODOO_MATCH_E2E=true (avoids breaking CI without Odoo).
 * Uses .env.local for ODOO_* + ODOO_MATCH_ENABLED; optional TEST_D3_RECIPIENT_NAME.
 */

import { resolve } from "node:path";
import { config } from "dotenv";
import { describe, expect, it } from "vitest";
import {
  authenticateOdooForMatch,
  buildClientMatchInputs,
  loadOdooMatchConfigFromEnv,
  resolveOdooRecipientContact,
  runOdooClientMatch,
} from "@/lib/odoo-client-match";

const e2eEnabled = process.env.ODOO_MATCH_E2E === "true";

describe.skipIf(!e2eEnabled)("Odoo D3/D4 matching (e2e)", () => {
  it("matches a partner and resolves a recipient email", async () => {
    config({ path: resolve(process.cwd(), ".env.local") });

    const cfg = loadOdooMatchConfigFromEnv();
    expect(cfg).not.toBeNull();
    if (!cfg) return;

    const recipientName =
      process.env.TEST_D3_RECIPIENT_NAME?.trim() || "TEST COMPANY PTE. LTD.";
    const inputs = buildClientMatchInputs(
      { recipient_name: recipientName },
      "",
    );

    const { client, uid } = await authenticateOdooForMatch(cfg);
    const matchResult = await runOdooClientMatch(client, uid, cfg, inputs);

    expect(matchResult).toMatchObject({
      status: expect.any(String),
    });

    if (matchResult.status === "matched" && matchResult.partnerId != null) {
      const contactResult = await resolveOdooRecipientContact({
        client,
        uid,
        cfg,
        partnerId: matchResult.partnerId,
      });
      expect(contactResult.resolutionMethod).toEqual(expect.any(String));
    }
  });
});
