import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type Item = { index: number; split_path?: string | null };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_CONFIG_MISSING" },
      { status: 500 },
    );
  }

  const { id: documentId, index: indexStr } = await params;
  const idx = Number.parseInt(indexStr, 10);
  if (!Number.isFinite(idx) || idx < 0) {
    return NextResponse.json({ error: "INVALID_INDEX" }, { status: 400 });
  }

  const docRes = await supabase.client
    .from("documents")
    .select("ocr_clients_items")
    .eq("id", documentId)
    .maybeSingle();

  if (docRes.error || !docRes.data) {
    return NextResponse.json({ error: "DOCUMENT_NOT_FOUND" }, { status: 404 });
  }

  const items = (docRes.data as { ocr_clients_items: unknown })
    .ocr_clients_items;
  if (!Array.isArray(items)) {
    return NextResponse.json({ error: "NO_SPLITS" }, { status: 404 });
  }

  const row = items.find((x: Item) => x.index === idx) as Item | undefined;
  const path = row?.split_path;
  if (!path || typeof path !== "string") {
    return NextResponse.json({ error: "SPLIT_NOT_FOUND" }, { status: 404 });
  }

  const signed = await supabase.client.storage
    .from(supabase.storageBucket)
    .createSignedUrl(path, 3600);

  if (signed.error || !signed.data?.signedUrl) {
    return NextResponse.json(
      { error: "SIGNED_URL_FAILED", detail: signed.error?.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: signed.data.signedUrl });
}
