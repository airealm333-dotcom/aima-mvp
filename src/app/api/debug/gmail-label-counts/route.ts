import { NextResponse } from "next/server";
import { getGmailClientOrNull } from "@/lib/gmail-client";

export const runtime = "nodejs";

type LabelCount = {
  id: string;
  name: string;
  messagesTotal: number;
  messagesUnread: number;
};

export async function GET() {
  const gmail = getGmailClientOrNull();
  if (!gmail) {
    return NextResponse.json(
      { error: "GMAIL_NOT_CONFIGURED" },
      { status: 500 },
    );
  }

  const userId = process.env.GMAIL_INTAKE_USER_ID?.trim() || "me";
  const unprocessedName =
    process.env.GMAIL_INTAKE_LABEL_UNPROCESSED?.trim() || "Unprocessed";
  const processedName =
    process.env.GMAIL_INTAKE_LABEL_PROCESSED?.trim() || "Processed";

  try {
    const list = await gmail.users.labels.list({ userId });
    const labels = list.data.labels ?? [];

    const pick = (labelName: string): LabelCount | null => {
      const found = labels.find(
        (l) => (l.name ?? "").toLowerCase() === labelName.toLowerCase(),
      );
      if (!found?.id || !found.name) return null;
      return {
        id: found.id,
        name: found.name,
        messagesTotal: found.messagesTotal ?? 0,
        messagesUnread: found.messagesUnread ?? 0,
      };
    };

    return NextResponse.json({
      userId,
      unprocessed: pick(unprocessedName),
      processed: pick(processedName),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "GMAIL_LABEL_COUNT_FAILED", detail },
      { status: 500 },
    );
  }
}
