import { NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/app-settings";

export const runtime = "nodejs";

const ALLOWED_KEYS = ["dispatch_mode"] as const;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key || !ALLOWED_KEYS.includes(key as never)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }
  const value = await getSetting(key);
  return NextResponse.json({ key, value });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({})) as { key?: string; value?: string };
  const { key, value } = body;
  if (!key || !ALLOWED_KEYS.includes(key as never)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }
  if (typeof value !== "string") {
    return NextResponse.json({ error: "value must be a string" }, { status: 400 });
  }
  await setSetting(key, value);
  return NextResponse.json({ ok: true, key, value });
}
