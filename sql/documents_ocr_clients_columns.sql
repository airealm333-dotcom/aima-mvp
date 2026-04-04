-- OCR → clients pipeline persistence (dashboard: Processing / Processed buckets).
-- Run in Supabase SQL editor after public.documents exists.

alter table public.documents
  add column if not exists ocr_clients_status text,
  add column if not exists ocr_clients_completed_at timestamptz,
  add column if not exists ocr_clients_ocr_summary jsonb,
  add column if not exists ocr_clients_items jsonb,
  add column if not exists ocr_clients_error text;

create index if not exists documents_ocr_clients_status_idx
  on public.documents (ocr_clients_status);

comment on column public.documents.ocr_clients_status is
  'null=not run | processing | completed | failed';
comment on column public.documents.ocr_clients_items is
  'JSON array: { index, name, UEN, document_type, page_range, pageStart, pageEnd, split_path, pdfError }';
