import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const { searchParams } = new URL(req.url);
  const path = searchParams.get("path");

  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  let storagePath = path;

  // If no explicit path, use the document's file_path
  if (!storagePath) {
    const { data, error } = await supabase.client
      .from("documents")
      .select("file_path")
      .eq("id", documentId)
      .maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    storagePath = (data as { file_path: string }).file_path;
  }

  const { data: signed, error: signErr } = await supabase.client.storage
    .from(supabase.storageBucket)
    .createSignedUrl(storagePath, 300);

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: signErr?.message ?? "Failed to sign URL" }, { status: 500 });
  }

  return NextResponse.json({ url: signed.signedUrl, path: storagePath });
}
