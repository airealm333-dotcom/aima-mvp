/**
 * Sends one email per ocr_clients_items entry via the Gmail API (same OAuth
 * credentials used for intake). The split PDF is attached if available.
 *
 * Required env:
 *   DISPATCH_TO_EMAIL   — recipient address
 *   DISPATCH_FROM_NAME  — display name (default "AIMA Dispatch")
 *   GMAIL_OAUTH_*       — existing Gmail OAuth credentials
 */

import { getGmailClientOrNull } from "@/lib/gmail-client";
import type { SupabaseAdminBundle } from "@/lib/supabase-admin";

export type DispatchItem = {
  index: number;
  name: string;
  UEN: string;
  document_type: string;
  classification: string;
  confidence: number;
  page_range: string;
  split_path: string | null;
  odoo_match_status: string | null;
  odoo_partner_id: number | null;
  odoo_match_method: string | null;
  odoo_match_score: number | null;
  odoo_contact_email: string | null;
  odoo_resolution_method: string | null;
  odoo_accounting_manager_name: string | null;
  odoo_accounting_manager_email: string | null;
  dispatched_at: string | null;
  sender_name: string | null;
  sender_address: string | null;
  odoo_contact_name: string | null;
  document_date: string | null;
};

export type DispatchResult = {
  index: number;
  name: string;
  status: "sent" | "skipped" | "error";
  error?: string;
};

function buildEmailBody(item: DispatchItem): string {
  const clientName = item.name || "—";
  const senderLine = [item.sender_name, item.sender_address].filter(Boolean).join(", ") || "—";
  const accountManagerLine = [item.odoo_accounting_manager_name, item.odoo_accounting_manager_email].filter(Boolean).join(", ") || "—";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#111827;margin:0;padding:32px;max-width:640px;">

  <p style="margin:0 0 4px;"><strong>Account Manager:</strong> ${accountManagerLine}</p>
  <p style="margin:0 0 20px;"><strong>Client Email Id:</strong> ${item.odoo_contact_email ?? "—"}</p>

  <p style="margin:0 0 20px;">Dear ${item.odoo_contact_name || clientName},</p>

  <p style="margin:0 0 20px;line-height:1.6;">We have received physical correspondence addressed to your entity, details of which are set out below for your review and necessary action.</p>

  <p style="margin:0 0 8px;"><strong>Mail Details:</strong></p>
  <ul style="margin:0 0 20px;padding-left:20px;line-height:2;">
    <li><strong>Date of Receipt:</strong> ${item.document_date ?? "—"}</li>
    <li><strong>Sender:</strong> ${senderLine}</li>
    <li><strong>Addressee (as per envelope):</strong> ${clientName}</li>
    <li><strong>Summary of Contents:</strong> ${item.document_type || item.classification || "—"}</li>
  </ul>

  <p style="margin:0 0 8px;"><strong>Attachments:</strong></p>
  <p style="margin:0 0 20px;line-height:1.6;">Please find attached scanned copies of the original documents for your reference.</p>

  <p style="margin:0 0 8px;"><strong>Remarks:</strong></p>
  <p style="margin:0 0 20px;line-height:1.6;">If any specific handling instructions are required (e.g., filing, drafting responses, regulatory submissions), please let us know.</p>

  <p style="margin:0 0 0;line-height:1.6;">Kindly review the attached documents and advise us on the next steps.</p>

</body>
</html>`.trim();
}

/** Encode a raw RFC-2822 message as URL-safe base64 (required by Gmail API). */
function encodeMessage(raw: string): string {
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * RFC 2047 encoded-word encoding for email header values containing non-ASCII.
 * Passes pure ASCII strings through unchanged.
 */
function encodeHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildRawEmail(opts: {
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
  attachment?: { filename: string; data: Buffer; mimeType: string };
}): string {
  const boundary = `aima_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeaderValue(opts.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join("\r\n");

  const htmlPart = [
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(opts.htmlBody).toString("base64"),
  ].join("\r\n");

  let raw = `${headers}\r\n\r\n${htmlPart}\r\n`;

  if (opts.attachment) {
    const att = opts.attachment;
    const attPart = [
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      `Content-Transfer-Encoding: base64`,
      "",
      att.data.toString("base64"),
    ].join("\r\n");
    raw += `${attPart}\r\n`;
  }

  raw += `--${boundary}--`;
  return raw;
}

async function loadDispatchItems(
  supabase: SupabaseAdminBundle,
  documentId: string,
): Promise<{ drid: string; items: DispatchItem[] }> {
  const { data, error } = await supabase.client
    .from("documents")
    .select("drid, ocr_clients_items")
    .eq("id", documentId)
    .maybeSingle();

  if (error) {
    throw new Error(`dispatch load failed: ${error.message}`);
  }
  if (!data) {
    throw new Error("dispatch load failed: document not found");
  }

  const row = data as { drid: string; ocr_clients_items: unknown };
  const items = Array.isArray(row.ocr_clients_items)
    ? (row.ocr_clients_items as DispatchItem[])
    : [];

  return { drid: row.drid, items };
}

/** Re-read one item by index from DB (avoids stale snapshots and races). */
async function loadItemByIndex(
  supabase: SupabaseAdminBundle,
  documentId: string,
  index: number,
): Promise<DispatchItem | null> {
  const { items } = await loadDispatchItems(supabase, documentId);
  return items.find((it) => it.index === index) ?? null;
}

const STAMP_UPDATE_RETRIES = 4;

async function stampDispatchedAt(
  supabase: SupabaseAdminBundle,
  documentId: string,
  itemIndex: number,
  sentAt: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < STAMP_UPDATE_RETRIES; attempt++) {
    const { data: fresh, error: readErr } = await supabase.client
      .from("documents")
      .select("ocr_clients_items")
      .eq("id", documentId)
      .maybeSingle();

    if (readErr || !fresh) {
      console.error(
        `[dispatch] stamp read failed (attempt ${attempt + 1}):`,
        readErr?.message ?? "no row",
      );
      continue;
    }

    const allItems =
      (fresh as { ocr_clients_items: DispatchItem[] }).ocr_clients_items ?? [];
    const current = allItems.find((it) => it.index === itemIndex);
    if (current?.dispatched_at) {
      return true;
    }

    const updated = allItems.map((it) =>
      it.index === itemIndex && !it.dispatched_at
        ? { ...it, dispatched_at: sentAt }
        : it,
    );

    const { error: writeErr } = await supabase.client
      .from("documents")
      .update({ ocr_clients_items: updated } as never)
      .eq("id", documentId);

    if (!writeErr) {
      return true;
    }
    console.error(
      `[dispatch] stamp write failed (attempt ${attempt + 1}):`,
      writeErr.message,
    );
  }
  return false;
}

/**
 * Sends one email per matching ocr_clients_items row. Always loads the latest
 * items from the DB (the `items` argument is ignored) so pipeline timers and
 * concurrent requests cannot use stale `dispatched_at`. Re-checks the row
 * immediately before each Gmail send.
 */
export async function dispatchDocumentItems(
  supabase: SupabaseAdminBundle,
  documentId: string,
  drid: string,
  _itemsFromCallerIgnored: DispatchItem[],
  indices?: number[], // if given, only dispatch these item indices
): Promise<DispatchResult[]> {
  const toEmail = (process.env.DISPATCH_TO_EMAIL ?? "").trim();
  if (!toEmail) throw new Error("DISPATCH_TO_EMAIL is not configured");

  const fromName = (process.env.DISPATCH_FROM_NAME ?? "AIMA Dispatch").trim();
  const userId = process.env.GMAIL_INTAKE_USER_ID ?? "me";

  const gmail = getGmailClientOrNull();
  if (!gmail) throw new Error("Gmail client not configured (check GMAIL_OAUTH_* env vars)");

  // Resolve sender address from Gmail profile
  const profile = await gmail.users.getProfile({ userId });
  const fromEmail = profile.data.emailAddress ?? userId;
  const from = `${fromName} <${fromEmail}>`;

  const { drid: dbDrid, items: freshItems } = await loadDispatchItems(
    supabase,
    documentId,
  );
  const effectiveDrid = dbDrid || drid;

  const targetItems =
    indices !== undefined
      ? freshItems.filter((it) => indices.includes(it.index))
      : freshItems;

  const results: DispatchResult[] = [];

  for (const item of targetItems) {
    if (item.dispatched_at) {
      results.push({ index: item.index, name: item.name, status: "skipped" });
      continue;
    }

    try {
      const live = await loadItemByIndex(supabase, documentId, item.index);
      if (!live) {
        results.push({
          index: item.index,
          name: item.name,
          status: "error",
          error: "Item missing on pre-send read",
        });
        continue;
      }
      if (live.dispatched_at) {
        results.push({ index: item.index, name: item.name, status: "skipped" });
        continue;
      }

      let attachment: { filename: string; data: Buffer; mimeType: string } | undefined;

      if (live.split_path) {
        const dl = await supabase.client.storage
          .from(supabase.storageBucket)
          .download(live.split_path);

        if (!dl.error && dl.data) {
          const filename = `${effectiveDrid}-${(live.name || `item${live.index}`).replace(/[^a-zA-Z0-9_.-]/g, "_")}.pdf`;
          attachment = {
            filename,
            data: Buffer.from(await dl.data.arrayBuffer()),
            mimeType: "application/pdf",
          };
        }
      }

      const subject = `Incoming Mail Received`;
      const htmlBody = buildEmailBody(live);
      const rawEmail = buildRawEmail({ from, to: toEmail, subject, htmlBody, attachment });

      await gmail.users.messages.send({
        userId,
        requestBody: { raw: encodeMessage(rawEmail) },
      });

      const sentAt = new Date().toISOString();
      const stamped = await stampDispatchedAt(supabase, documentId, live.index, sentAt);
      if (!stamped) {
        console.error(
          `[dispatch] ${effectiveDrid} item ${live.index}: Gmail sent but dispatched_at stamp failed after retries`,
        );
      }

      results.push({ index: live.index, name: live.name, status: "sent" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ index: item.index, name: item.name, status: "error", error: msg });
    }
  }

  return results;
}
