This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## AIMA MVP (Intake → OCR → D2 classification)

This repo includes an MVP intake flow through OCR and **D2 document classification** (rules-first, optional Anthropic LLM). Odoo and later workflow steps are out of scope.

- **Primary (SOP):** Gmail messages in an **Unprocessed** label are polled on a schedule. First PDF/image attachment is stored in Supabase, OCR runs, `documents.gmail_message_id` is set, then the message is moved to **Processed**.
- **Automation:** (1) Optional in-process poll while the server runs: set `GMAIL_AUTOPOLL_INTERVAL_MS` (e.g. `300000` for 5 minutes) — see `src/instrumentation.ts`. (2) On Vercel: `vercel.json` runs `/api/cron/intake-email` every 5 minutes; set `CRON_SECRET` in the project so Vercel sends `Authorization: Bearer …`. (3) Manual or OS cron: `POST`/`GET` `/api/cron/intake-email` with `CRON_SECRET`.
- **Optional testing:** Manual upload form at `src/app/page.tsx` (disable in production with `NEXT_PUBLIC_MANUAL_INTAKE_ENABLED=false`). **PDFs** use the same **logical split** pipeline as Gmail (`splitPdfIntoLogicalSections`); multiple segments return a `split: true` JSON payload with a `documents` array and show multiple **Results** cards. Set `MANUAL_UPLOAD_PDF_SPLIT=false` to ingest each uploaded PDF as a single document.
- API: `src/app/api/intake/route.ts` (multipart), `src/app/api/cron/intake-email/route.ts` (email poll).
- OCR via Google Vision API (with `pdf-parse` PDF fallback).
- Supabase storage + table writes + audit log.
- Mapped to your schema: `mail_items`, `documents`, `audit_logs`

### Setup

1. Copy `.env.example` to `.env.local` inside `aima-mvp`.
2. Set Supabase values.
3. Optionally set `SUPABASE_MAIL_BUCKET` if your storage bucket name is different.
4. Set `GOOGLE_VISION_CREDENTIALS_JSON` (required for Vision OCR).
5. Configure async PDF OCR buckets:
   - `GOOGLE_VISION_GCS_INPUT_BUCKET`
   - `GOOGLE_VISION_GCS_OUTPUT_BUCKET`
   - optional `GOOGLE_VISION_GCS_PREFIX` (default `vision-ocr`)
6. Optionally set `GOOGLE_VISION_STRICT=true` to fail fast when Vision/GCS OCR is unavailable.
7. **Supabase — classification columns:** Run the SQL in the [Supabase: documents classification columns](#supabase-documents-classification-columns) section (or paste [`sql/documents_classification_columns.sql`](sql/documents_classification_columns.sql)) in the Supabase SQL editor so intake can set `D2_CLASSIFIED` and store classification fields.
8. Configure Gmail intake (see `.env.example`): `CRON_SECRET` (required for the HTTP cron route and for Vercel Cron) plus either OAuth client + refresh token **or** Workspace service account + delegated user. Create Gmail labels matching `GMAIL_INTAKE_LABEL_UNPROCESSED` / `GMAIL_INTAKE_LABEL_PROCESSED` (or let the first poll create them).
9. Optional Anthropic LLMs (same `ANTHROPIC_API_KEY`):
   - **Classification (D2):** `CLASSIFICATION_USE_LLM=true`, optionally `CLASSIFICATION_LLM_THRESHOLD` (default `90` — rules confidence must be below this to call the model).
   - **Entity extraction (D2.5):** `ENTITY_EXTRACTION_USE_LLM=true` to merge structured fields into `universal_info` / `legal_entities` / `invoice_entities` after rule extraction. Set **`ANTHROPIC_ENTITY_MODEL`** to the same model ID as classification if you rely on Sonnet 4.x (entity extraction uses a separate env var from `ANTHROPIC_CLASSIFICATION_MODEL`). Optional: `ENTITY_EXTRACTION_OCR_MAX_CHARS`, `ENTITY_EXTRACTION_LLM_OVERRIDE`. See `.env.example`. Audit actions `ENTITY_LLM_NO_EXTRACTABLE_FIELDS` / `ENTITY_LLM_EXTRACTION_FAILED` help debug empty or invalid JSON responses.
10. Optional: set `GMAIL_AUTOPOLL_INTERVAL_MS=300000` in `.env.local` to poll Gmail every 5 minutes automatically while `npm run dev` or `npm run start` is running (do not rely on this on Vercel; use the included `vercel.json` cron instead).
11. Run `npm run dev`.

### Supabase: documents classification columns

Apply once (adjust schema name if not `public`):

```sql
alter table public.documents
  add column if not exists classification_label text,
  add column if not exists classification_confidence integer,
  add column if not exists classification_method text,
  add column if not exists classification_rationale text;

comment on column public.documents.classification_label is 'SOP-aligned category: IRAS, ACRA, MOM, BANK_FINANCIAL, LEGAL, UTILITY_PROPERTY, GENERAL, UNKNOWN';
comment on column public.documents.classification_confidence is '0–100';
comment on column public.documents.classification_method is 'rules | llm | rules_then_llm';
```

Intake sets `documents.status` to **`D2_CLASSIFIED`** after a successful classification write. Allowed label values are enforced in application code (`src/lib/document-classify.ts`).

### Supabase: D2.5 entity tables (`universal_info`, `legal_entities`, `invoice_entities`)

The app stores extracted fields in **three typed tables** keyed to `documents(id)` (replacing the legacy `document_entities` model).

**New projects (no legacy `document_entities`):**

1. Apply [`sql/create_universal_legal_invoice_tables.sql`](sql/create_universal_legal_invoice_tables.sql) once.
2. **Existing DBs** created before party columns: apply [`sql/universal_info_party_columns.sql`](sql/universal_info_party_columns.sql) once (adds `organization_name`, `contact_person_name`). New installs from step 1 already include these columns.
3. Optional reporting view (one row per document): [`sql/document_entities_reporting_view.sql`](sql/document_entities_reporting_view.sql) (re-run after party columns if you use the merged view).

**Party fields:** `recipient_name` / `sender_name` are **directional** (to/from on the piece). `organization_name` and `contact_person_name` are **semantic** (client company and named individual when extractable).

**Existing databases that still have `public.document_entities`:**

1. Apply [`sql/create_universal_legal_invoice_tables.sql`](sql/create_universal_legal_invoice_tables.sql).
2. Apply [`sql/universal_info_party_columns.sql`](sql/universal_info_party_columns.sql) if your `universal_info` predates those columns.
3. Deploy this version of the app (it reads/writes the new tables only).
4. Optionally backfill historical rows from `document_entities` manually or re-ingest.
5. Apply [`sql/drop_document_entities_legacy.sql`](sql/drop_document_entities_legacy.sql) to drop the old table and recreate the merged view (re-run the reporting view script after drop if needed).

**Legacy scripts (obsolete after cutover):** `documents_entity_extraction.sql`, `documents_entity_physical_columns.sql`, `documents_entity_claimant_respondent.sql`, `documents_entity_ect_extended.sql` — do **not** apply on new installs; keep only for reference or old DB migration.

### Email subject format (optional)

If the subject contains both IDs, they are used on the first insert attempt:

`ROSMAILYYYYMMDDXXX | ROSDOCYYYYMMDDROSMAILYYYYMMDDXXXYY | Physical Mail Scan`

If either ID is missing, MRID/DRID are auto-generated like manual upload.

### Cron and automatic polling

**Vercel:** This repo includes [`vercel.json`](vercel.json), which schedules `GET /api/cron/intake-email` every 5 minutes. Add the same `CRON_SECRET` you use locally to the Vercel project environment variables; Vercel sends it as `Authorization: Bearer <CRON_SECRET>` on cron invocations.

**Local dev / self-hosted Node:** Set `GMAIL_AUTOPOLL_INTERVAL_MS` (milliseconds) in `.env.local` so the server polls Gmail in the background via [`src/instrumentation.ts`](src/instrumentation.ts). Polling stops when you stop the dev server.

**Manual or Windows Task Scheduler:** Example (PowerShell) hitting local dev:

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/cron/intake-email" `
  -Method POST `
  -Headers @{ Authorization = "Bearer YOUR_CRON_SECRET" }
```

On Windows, you can create a scheduled task that runs every 5 minutes and executes `curl.exe` or the PowerShell snippet above (adjust host/port if needed).

### Troubleshooting: recent documents 500 and Gmail labels

- **`GET /api/documents/recent` returns 500** mentioning `classification_*` columns: apply [`sql/documents_classification_columns.sql`](sql/documents_classification_columns.sql) in the Supabase SQL editor. Without those columns, intake fails at the D2 classification update, so **Gmail is never moved to Processed** even though earlier rows may exist.
- **Gmail API “Insufficient Permission” / labels never change after a successful intake:** the token must allow **`https://www.googleapis.com/auth/gmail.modify`**. For OAuth, re-authorize with that scope; for Workspace service accounts, enable domain-wide delegation for the same scope. Details: [`src/lib/gmail-client.ts`](src/lib/gmail-client.ts). With `GMAIL_AUTOPOLL_INTERVAL_MS` set, check the console for `[gmail-autopoll] error:` and `details:` lines.

### Verifying D2 after applying the classification SQL

1. **`GET /api/documents/recent`** returns HTTP 200 (not 500). Example: `curl.exe -s -o NUL -w "%{http_code}" http://localhost:3000/api/documents/recent`
2. **Manual upload** (`POST /api/intake`): success JSON includes `status.document: "D2_CLASSIFIED"` and `classification` (label, confidence, method, rationale). On failure, the UI shows `error` and `detail` together when both are present.
3. **Supabase**: `documents` row has `status = D2_CLASSIFIED` and populated `classification_*` columns; **`audit_logs`** has a row with `action = CLASSIFICATION_COMPLETED` for that document’s `entity_id`.

### Expected table columns

The API currently inserts these fields:

- `mail_items`: `id`, `mrid`, `received_at`, `sender`, `addressee`, `envelope_condition`, `mie_name`, `status`
- `documents`: `id`, `drid`, `mail_item_id`, `gmail_message_id`, `file_path`, `sha256_hash`, `ocr_text`, `status`, `classification_label`, `classification_confidence`, `classification_method`, `classification_rationale`
- `universal_info`: one row per document (`document_id`, `drid`, `mrid`, `full_text`, envelope fields, `document_type`, paths, page counts, etc.)
- `legal_entities`: optional row per document (ECT / legal / tax-style columns)
- `invoice_entities`: optional row per document (invoice / bill-style columns)
- `audit_logs`: `entity_type`, `entity_id`, `action`, `actor`, `metadata` (includes `OCR_COMPLETED`, `OCR_COMPLETED_LOW_COVERAGE`, `CLASSIFICATION_COMPLETED`, etc.)

Current scope includes intake, OCR, and **D2 classification** on `documents` (`D2_CLASSIFIED`). Client matching, consolidation, outbound email, and Odoo are not yet implemented.

### OCR provider behavior

- Provider order is: Google Vision async PDF OCR -> `pdf-parse` (PDF fallback only when strict mode is off).
- For images (`.png`, `.jpg`, `.jpeg`, `.webp`), OCR uses Google Vision.
- For PDFs, OCR uploads to `GOOGLE_VISION_GCS_INPUT_BUCKET`, runs Vision `asyncBatchAnnotateFiles`, and reads results from `GOOGLE_VISION_GCS_OUTPUT_BUCKET`.
- The Vision service account needs storage permissions to read/write those buckets (`Storage Object Admin` or equivalent scoped permissions).
- For PDFs, OCR falls back to `pdf-parse` only when `GOOGLE_VISION_STRICT=false`.
- If `GOOGLE_VISION_STRICT=true`, OCR fails immediately when Vision is misconfigured/unavailable.
- Split safety behavior: if OCR page coverage is partial (e.g., `ocr_page_mismatch:5/20`) or OCR returns no usable text, split falls back to single-document ingestion with review-required signals.

### Verify full-page OCR coverage

After ingesting a multi-page PDF:

1. Check `documents.split_reason`:
   - Healthy OCR/split runs should not show `ocr_page_mismatch:*`.
   - If `ocr_page_mismatch:X/Y` appears, Vision returned partial pages.
2. Confirm `documents.multi_invoice_suspected` behavior:
   - `true` with mismatch/no-text indicates safe single+review fallback.
3. Review server logs for OCR errors:
   - Bucket permission issues
   - Missing `GOOGLE_VISION_GCS_*` env vars

### Verify D2.5 entity extraction

After ingesting a document:

1. Ensure `/api/documents/recent` returns the flattened `entity_*` fields (best-effort).
2. In Supabase, confirm rows exist:

```sql
select document_id, drid, document_type, sender_name, recipient_name
from public.universal_info
order by created_at desc
limit 20;
```

```sql
select document_id, case_number, claimant_name, respondent_name
from public.legal_entities
order by created_at desc
limit 20;
```

```sql
select document_id, bill_number, total_amount_due, currency
from public.invoice_entities
order by created_at desc
limit 20;
```
