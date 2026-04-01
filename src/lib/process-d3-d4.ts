import { runIntakeOdooMatchAfterEntities } from "@/lib/intake-odoo-match";
import { loadOdooMatchConfigFromEnv } from "@/lib/odoo-client-match";

type LooseDb = {
  // biome-ignore lint/suspicious/noExplicitAny: Supabase untyped chain
  from: (table: string) => any;
};

const ENTITY_MATCH_COLUMNS =
  "recipient_uen, recipient_name, organization_name, respondent_name, account_name, contact_person_name";

/**
 * After `document_entities` upsert: log, re-load match fields from Supabase, run SOP D3/D4
 * (same behavior as `runIntakeOdooMatchAfterEntities`). Uses `fallbackEntitiesRow` when the row
 * is missing (e.g. upsert failed) so matching still sees in-memory extraction output.
 */
export async function processClientMatching(
  db: LooseDb,
  documentId: string,
  context: {
    drid: string;
    mrid: string;
    reviewRequired: boolean;
    ocrText: string;
    fallbackEntitiesRow?: Record<string, unknown> | null;
  },
) {
  console.log("=== STARTING D3/D4 MATCHING ===", documentId);

  if (!loadOdooMatchConfigFromEnv()) {
    console.log(
      "[D3/D4] Odoo match disabled or ODOO_* incomplete (ODOO_MATCH_ENABLED=true and URL/DB/user/key required).",
      documentId,
    );
    return null;
  }

  const res = await db
    .from("document_entities")
    .select(ENTITY_MATCH_COLUMNS)
    .eq("document_id", documentId)
    .maybeSingle();

  const fromDb = (res.data as Record<string, unknown> | null) ?? null;
  const entitiesRow = {
    ...(context.fallbackEntitiesRow ?? {}),
    ...(fromDb ?? {}),
  };

  const summary = await runIntakeOdooMatchAfterEntities({
    db,
    documentId,
    drid: context.drid,
    mrid: context.mrid,
    reviewRequired: context.reviewRequired,
    ocrText: context.ocrText,
    entitiesRow,
  });

  if (summary?.reason === "review_required") {
    console.log(
      "[D3/D4] Skipped: classification requires D3 review before Odoo match.",
      documentId,
    );
  } else if (summary != null) {
    console.log("=== D3/D4 MATCHING FINISHED ===", documentId, {
      attempted: summary.attempted,
      status: summary.status,
      partnerId: summary.partnerId,
      method: summary.method,
      score: summary.score,
    });
  }

  return summary;
}
