-- Apply once in Supabase SQL Editor (adjust schema if not public).
-- Adds D3 review workflow fields for classification validation.

alter table public.documents
  add column if not exists review_status text,
  add column if not exists review_required boolean not null default false,
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text,
  add column if not exists classification_label_original text;

create index if not exists documents_review_required_idx
  on public.documents (review_required);

create index if not exists documents_review_status_idx
  on public.documents (review_status);

create index if not exists documents_created_at_idx
  on public.documents (created_at desc);
