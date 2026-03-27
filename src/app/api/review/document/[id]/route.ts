import { NextResponse } from "next/server";
import { CLASSIFICATION_LABELS } from "@/lib/document-classify";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type ActionPayload = {
  action: "approve" | "correct" | "needs_rescan";
  reviewer: string;
  note?: string;
  correctedLabel?: string;
  correctedRationale?: string;
};

function isClassificationLabel(label: string): boolean {
  return CLASSIFICATION_LABELS.includes(
    label as (typeof CLASSIFICATION_LABELS)[number],
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_CONFIG_MISSING" },
      { status: 500 },
    );
  }

  const { id } = await params;
  const payload = (await request.json()) as ActionPayload;
  const reviewer = payload.reviewer?.trim();
  if (!reviewer) {
    return NextResponse.json({ error: "REVIEWER_REQUIRED" }, { status: 400 });
  }

  const existing = (await supabase.client
    .from("documents")
    .select(
      "id, drid, classification_label, classification_confidence, classification_method, classification_rationale, review_status, status",
    )
    .eq("id", id)
    .single()) as unknown as {
    data: {
      drid: string | null;
      classification_label: string | null;
      review_status: string | null;
    } | null;
    error: { message?: string } | null;
  };

  if (existing.error || !existing.data) {
    return NextResponse.json(
      { error: "DOCUMENT_NOT_FOUND", detail: existing.error?.message },
      { status: 404 },
    );
  }

  const existingRow = existing.data;

  const now = new Date().toISOString();
  const basePatch = {
    reviewed_by: reviewer,
    reviewed_at: now,
    review_note: payload.note?.trim() || null,
    review_required: false,
  };

  if (payload.action === "approve") {
    const update = await supabase.client
      .from("documents")
      .update({
        ...basePatch,
        review_status: "approved",
        status: "D3_APPROVED",
      } as never)
      .eq("id", id)
      .select("id")
      .single();

    if (update.error) {
      return NextResponse.json(
        { error: "FAILED_TO_APPROVE", detail: update.error.message },
        { status: 500 },
      );
    }

    await supabase.client.from("audit_logs").insert({
      entity_type: "document",
      entity_id: id,
      action: "D3_REVIEW_APPROVED",
      actor: reviewer,
      metadata: {
        drid: existingRow.drid,
        previousReviewStatus: existingRow.review_status,
      },
    } as never);
    return NextResponse.json({ ok: true });
  }

  if (payload.action === "correct") {
    const correctedLabel = payload.correctedLabel?.trim();
    if (!correctedLabel || !isClassificationLabel(correctedLabel)) {
      return NextResponse.json(
        { error: "VALID_CORRECTED_LABEL_REQUIRED" },
        { status: 400 },
      );
    }
    if (!payload.note?.trim()) {
      return NextResponse.json(
        { error: "REVIEW_NOTE_REQUIRED_FOR_CORRECTION" },
        { status: 400 },
      );
    }
    const update = await supabase.client
      .from("documents")
      .update({
        ...basePatch,
        review_status: "corrected",
        status: "D3_CORRECTED",
        classification_label_original: existingRow.classification_label,
        classification_label: correctedLabel,
        classification_rationale:
          payload.correctedRationale?.trim() ||
          `Manually corrected by ${reviewer}. ${payload.note.trim()}`,
      } as never)
      .eq("id", id)
      .select("id")
      .single();

    if (update.error) {
      return NextResponse.json(
        { error: "FAILED_TO_CORRECT", detail: update.error.message },
        { status: 500 },
      );
    }

    await supabase.client.from("audit_logs").insert({
      entity_type: "document",
      entity_id: id,
      action: "D3_REVIEW_CORRECTED",
      actor: reviewer,
      metadata: {
        drid: existingRow.drid,
        fromLabel: existingRow.classification_label,
        toLabel: correctedLabel,
        note: payload.note?.trim(),
      },
    } as never);
    return NextResponse.json({ ok: true });
  }

  if (payload.action === "needs_rescan") {
    const update = await supabase.client
      .from("documents")
      .update({
        ...basePatch,
        review_status: "needs_rescan",
        status: "D3_NEEDS_RESCAN",
      } as never)
      .eq("id", id)
      .select("id")
      .single();

    if (update.error) {
      return NextResponse.json(
        { error: "FAILED_TO_MARK_RESCAN", detail: update.error.message },
        { status: 500 },
      );
    }

    await supabase.client.from("audit_logs").insert({
      entity_type: "document",
      entity_id: id,
      action: "D3_REVIEW_NEEDS_RESCAN",
      actor: reviewer,
      metadata: {
        drid: existingRow.drid,
        note: payload.note?.trim() || null,
      },
    } as never);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
}
