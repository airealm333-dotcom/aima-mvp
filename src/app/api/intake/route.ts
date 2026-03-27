import { NextResponse } from "next/server";
import { processIntakeDocument } from "@/lib/intake-process";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

function parsePositiveInt(value: FormDataEntryValue | null, fallback: number) {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export async function POST(request: Request) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json(
        {
          error: "SUPABASE_CONFIG_MISSING",
          detail:
            "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.",
        },
        { status: 500 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const sender =
      typeof formData.get("sender") === "string"
        ? (formData.get("sender") as string)
        : null;
    const addressee =
      typeof formData.get("addressee") === "string"
        ? (formData.get("addressee") as string)
        : null;
    const mieName =
      typeof formData.get("mieName") === "string"
        ? (formData.get("mieName") as string)
        : null;
    const envelopeConditionRaw =
      typeof formData.get("envelopeCondition") === "string"
        ? (formData.get("envelopeCondition") as string)
        : "";
    const envelopeCondition = envelopeConditionRaw.trim() || "sealed";

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing file in form-data field 'file'." },
        { status: 400 },
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const result = await processIntakeDocument({
      supabase,
      buffer,
      contentType: file.type,
      fileName: file.name,
      source: "manual_upload",
      gmailMessageId: null,
      sender,
      addressee,
      mieName,
      envelopeCondition,
      requestedMailSequence: parsePositiveInt(formData.get("mailSequence"), 0),
      requestedDocSequence: parsePositiveInt(formData.get("docSequence"), 0),
    });

    return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json(
      { error: "INTAKE_FAILED", detail },
      { status: 500 },
    );
  }
}
