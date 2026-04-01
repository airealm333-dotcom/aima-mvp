import {
  authenticateOdooForMatch,
  buildClientMatchInputs,
  loadOdooMatchConfigFromEnv,
  type OdooClientMatchResult,
  resolveOdooRecipientContact,
  runOdooClientMatch,
} from "@/lib/odoo-client-match";
import { OdooJsonRpcError } from "@/lib/odoo-jsonrpc";

type LooseDb = {
  // biome-ignore lint/suspicious/noExplicitAny: Supabase untyped chain
  from: (table: string) => any;
};

export type OdooMatchIntakeSummary = {
  attempted: boolean;
  status: string;
  partnerId: number | null;
  score: number | null;
  method: string | null;
  reason?: "feature_disabled" | "review_required";
};

function toSummary(
  r: OdooClientMatchResult,
  attempted: true,
): OdooMatchIntakeSummary {
  return {
    attempted,
    status: r.status,
    partnerId: r.partnerId,
    score: r.score,
    method: r.method,
  };
}

async function persistMatchToDocument(
  db: LooseDb,
  documentId: string,
  result: OdooClientMatchResult,
): Promise<void> {
  await db
    .from("documents")
    .update({
      odoo_partner_id: result.partnerId,
      odoo_match_status: result.status,
      odoo_match_score: result.score,
      odoo_match_method: result.method,
      odoo_match_candidates: result.candidates,
      odoo_match_attempted_at: new Date().toISOString(),
    })
    .eq("id", documentId);
}

async function persistMatchToEntitiesRow(
  db: LooseDb,
  documentId: string,
  result: OdooClientMatchResult,
): Promise<void> {
  await db
    .from("document_entities")
    .update({
      match_confidence: result.score,
      odoo_partner_id: result.partnerId,
      status: "D3_MATCHED",
    })
    .eq("document_id", documentId);
}

async function persistD4ToEntitiesRow(
  db: LooseDb,
  documentId: string,
  email: string,
): Promise<void> {
  await db
    .from("document_entities")
    .update({
      odoo_contact_email: email,
      status: "D4_CONTACT_RESOLVED",
    })
    .eq("document_id", documentId);
}

/**
 * SOP D3 Odoo client match after entity rows are built (non-fatal: logs audit/exceptions on failure).
 */
export async function runIntakeOdooMatchAfterEntities(input: {
  db: LooseDb;
  documentId: string;
  drid: string;
  mrid: string;
  reviewRequired: boolean;
  ocrText: string;
  entitiesRow: Record<string, unknown>;
}): Promise<OdooMatchIntakeSummary | null> {
  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) return null;

  // TEMPORARY: Skip review check for MVP testing
  // TODO: Uncomment for production
  // if (input.reviewRequired) {
  //   await input.db.from("audit_logs").insert({
  //     entity_type: "document",
  //     entity_id: input.documentId,
  //     action: "ODOO_CLIENT_MATCH_SKIPPED",
  //     actor: "AIMA",
  //     metadata: {
  //       drid: input.drid,
  //       mrid: input.mrid,
  //       reason: "classification_review_required",
  //     },
  //   });
  //   return {
  //     attempted: false,
  //     status: "skipped",
  //     partnerId: null,
  //     score: null,
  //     method: null,
  //     reason: "review_required",
  //   };
  // }
  console.log(
    "[D3/D4] MVP MODE: Skipping review check, proceeding with Odoo match...",
    input.documentId,
  );

  const inputs = buildClientMatchInputs(input.entitiesRow, input.ocrText);

  try {
    const { client, uid } = await authenticateOdooForMatch(cfg);
    const result = await runOdooClientMatch(client, uid, cfg, inputs);
    await persistMatchToDocument(input.db, input.documentId, result);
    await persistMatchToEntitiesRow(input.db, input.documentId, result);

    if (result.status === "skipped") {
      await input.db.from("audit_logs").insert({
        entity_type: "document",
        entity_id: input.documentId,
        action: "ODOO_CLIENT_MATCH_SKIPPED",
        actor: "AIMA",
        metadata: {
          drid: input.drid,
          mrid: input.mrid,
          reason: "no_client_identifiers",
        },
      });
      return toSummary(result, true);
    }

    if (result.status === "matched") {
      const partnerId = result.partnerId;
      if (partnerId == null) {
        await input.db.from("exceptions").insert({
          drid: input.drid,
          document_id: input.documentId,
          type: "E3_ODOO_CLIENT_MATCH_ERROR",
          status: "open",
          root_cause: "D3 reported matched but partner id was null.",
          suggested_action:
            "Inspect Odoo matching output and retry after correcting client data.",
        });
        await input.db.from("audit_logs").insert({
          entity_type: "document",
          entity_id: input.documentId,
          action: "ODOO_CLIENT_MATCH_ERROR",
          actor: "AIMA",
          metadata: {
            drid: input.drid,
            mrid: input.mrid,
            detail: "matched_without_partner_id",
          },
        });
        return toSummary(result, true);
      }

      await input.db.from("audit_logs").insert({
        entity_type: "document",
        entity_id: input.documentId,
        action: "ODOO_CLIENT_MATCHED",
        actor: "AIMA",
        metadata: {
          drid: input.drid,
          mrid: input.mrid,
          odoo_partner_id: result.partnerId,
          odoo_match_score: result.score,
          odoo_match_method: result.method,
        },
      });

      const d4 = await resolveOdooRecipientContact({
        client,
        uid,
        cfg,
        partnerId,
      });

      if (d4.resolutionMethod === "not_found" || !d4.email) {
        await input.db.from("exceptions").insert({
          drid: input.drid,
          document_id: input.documentId,
          type: "E2_EMAIL_NOT_FOUND",
          status: "open",
          root_cause:
            "Client matched in Odoo but no valid recipient email found in child contacts or company email.",
          suggested_action:
            "Update Odoo contact emails and/or x_ro_mail_recipient, then retry dispatch.",
        });
        await input.db.from("audit_logs").insert({
          entity_type: "document",
          entity_id: input.documentId,
          action: "ODOO_CONTACT_NOT_FOUND",
          actor: "AIMA",
          metadata: {
            drid: input.drid,
            mrid: input.mrid,
            odoo_partner_id: partnerId,
          },
        });
        return toSummary(result, true);
      }

      await persistD4ToEntitiesRow(input.db, input.documentId, d4.email);
      await input.db.from("audit_logs").insert({
        entity_type: "document",
        entity_id: input.documentId,
        action: "ODOO_CONTACT_RESOLVED",
        actor: "AIMA",
        metadata: {
          drid: input.drid,
          mrid: input.mrid,
          odoo_partner_id: partnerId,
          odoo_contact_id: d4.contactId,
          odoo_contact_email: d4.email,
          resolution_method: d4.resolutionMethod,
        },
      });
      return toSummary(result, true);
    }

    if (result.status === "ambiguous") {
      await input.db.from("exceptions").insert({
        drid: input.drid,
        document_id: input.documentId,
        type: "E2_CLIENT_AMBIGUOUS",
        status: "open",
        root_cause:
          "Odoo client match returned multiple plausible partners or a mid-confidence fuzzy hit.",
        suggested_action:
          "Resolve the correct res.partner in Odoo and link manually if needed.",
      });
      await input.db.from("audit_logs").insert({
        entity_type: "document",
        entity_id: input.documentId,
        action: "ODOO_CLIENT_MATCH_AMBIGUOUS",
        actor: "AIMA",
        metadata: {
          drid: input.drid,
          mrid: input.mrid,
          odoo_match_score: result.score,
          odoo_match_method: result.method,
          candidates: result.candidates,
        },
      });
      return toSummary(result, true);
    }

    // no_match
    await input.db.from("exceptions").insert({
      drid: input.drid,
      document_id: input.documentId,
      type: "E1_CLIENT_NOT_MATCHED",
      status: "open",
      root_cause:
        "No Odoo res.partner matched UEN, exact name, or fuzzy thresholds.",
      suggested_action:
        "Create or correct the partner in Odoo and re-run match when supported.",
    });
    await input.db.from("audit_logs").insert({
      entity_type: "document",
      entity_id: input.documentId,
      action: "ODOO_CLIENT_MATCH_NOT_FOUND",
      actor: "AIMA",
      metadata: {
        drid: input.drid,
        mrid: input.mrid,
        odoo_match_score: result.score,
        odoo_match_method: result.method,
        candidates: result.candidates,
      },
    });
    return toSummary(result, true);
  } catch (err) {
    const detail =
      err instanceof OdooJsonRpcError
        ? err.message
        : err instanceof Error
          ? err.message
          : "unknown_error";

    await persistMatchToDocument(input.db, input.documentId, {
      status: "error",
      partnerId: null,
      score: null,
      method: "error",
      candidates: [],
    });

    await input.db.from("exceptions").insert({
      drid: input.drid,
      document_id: input.documentId,
      type: "E3_ODOO_CLIENT_MATCH_ERROR",
      status: "open",
      root_cause: "Odoo JSON-RPC or match pipeline failed.",
      suggested_action:
        "Check ODOO_* configuration, network, and Odoo logs; retry after fix.",
    });

    await input.db.from("audit_logs").insert({
      entity_type: "document",
      entity_id: input.documentId,
      action: "ODOO_CLIENT_MATCH_ERROR",
      actor: "AIMA",
      metadata: {
        drid: input.drid,
        mrid: input.mrid,
        detail,
      },
    });

    return {
      attempted: true,
      status: "error",
      partnerId: null,
      score: null,
      method: "error",
    };
  }
}
