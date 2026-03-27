import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
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
  const doc = await supabase.client
    .from("documents")
    .select("id, file_path, drid")
    .eq("id", id)
    .single();

  type DocRow = { id: string; file_path: string | null; drid: string | null };
  const row = doc.data as DocRow | null;

  if (doc.error || !row) {
    return NextResponse.json(
      { error: "DOCUMENT_NOT_FOUND", detail: doc.error?.message },
      { status: 404 },
    );
  }

  const filePath = row.file_path?.trim();
  if (!filePath) {
    return NextResponse.json(
      { error: "DOCUMENT_FILE_PATH_MISSING" },
      { status: 400 },
    );
  }

  const signed = await supabase.client.storage
    .from(supabase.storageBucket)
    .createSignedUrl(filePath, 120);

  if (signed.error || !signed.data?.signedUrl) {
    return NextResponse.json(
      { error: "FAILED_TO_CREATE_SIGNED_URL", detail: signed.error?.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    url: signed.data.signedUrl,
    drid: row.drid,
    expiresInSeconds: 120,
  });
}
