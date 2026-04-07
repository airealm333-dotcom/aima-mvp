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
};

export type DispatchResult = {
  index: number;
  name: string;
  status: "sent" | "skipped" | "error";
  error?: string;
};

function buildEmailBody(item: DispatchItem, drid: string): string {
  const line = (label: string, value: string | number | null | undefined) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:4px 0;color:#111827;">${value ?? "—"}</td></tr>`;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;font-size:14px;color:#111827;margin:0;padding:24px;">
  <h2 style="margin:0 0 4px;font-size:18px;">${item.name || "—"}</h2>
  <p style="margin:0 0 20px;color:#6b7280;font-size:12px;">Document: ${drid} &nbsp;·&nbsp; Pages: ${item.page_range}</p>

  <table style="border-collapse:collapse;width:100%;max-width:560px;">
    ${line("Client Name", item.name)}
    ${line("UEN", item.UEN === "Null" ? "—" : item.UEN)}
    ${line("Document Type", item.document_type || item.classification)}
    ${line("Pages", item.page_range)}
    ${line("Confidence", item.confidence != null ? `${Math.round(item.confidence)}%` : null)}
    <tr><td colspan="2" style="padding:8px 0;"><hr style="border:none;border-top:1px solid #e5e7eb;"></td></tr>
    ${line("Client Email", item.odoo_contact_email)}
    ${line("Contact Resolution", item.odoo_resolution_method)}
    <tr><td colspan="2" style="padding:8px 0;"><hr style="border:none;border-top:1px solid #e5e7eb;"></td></tr>
    ${line("Accounting Manager", item.odoo_accounting_manager_name)}
    ${line("Accounting Manager Email", item.odoo_accounting_manager_email)}
    <tr><td colspan="2" style="padding:8px 0;"><hr style="border:none;border-top:1px solid #e5e7eb;"></td></tr>
    ${line("Odoo Partner ID", item.odoo_partner_id)}
    ${line("Odoo Match Status", item.odoo_match_status)}
    ${line("Odoo Match Method", item.odoo_match_method)}
    ${line("Odoo Match Score", item.odoo_match_score != null ? String(item.odoo_match_score) : null)}
  </table>

  <p style="margin:24px 0 0;font-size:11px;color:#9ca3af;">
    Sent by AIMA · ${new Date().toUTCString()}
  </p>
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

      const subject = `[AIMA] ${live.name || `Item ${live.index + 1}`} — ${effectiveDrid}`;
      const htmlBody = buildEmailBody(live, effectiveDrid);
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
