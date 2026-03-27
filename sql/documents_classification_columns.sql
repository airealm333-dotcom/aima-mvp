-- Apply once in Supabase SQL Editor (adjust schema if not public).
-- Required for D2 classification writes and GET /api/documents/recent.

alter table public.documents
  add column if not exists classification_label text,
  add column if not exists classification_confidence integer,
  add column if not exists classification_method text,
  add column if not exists classification_rationale text;

comment on column public.documents.classification_label is 'SOP-aligned category: IRAS, ACRA, MOM, BANK_FINANCIAL, LEGAL, UTILITY_PROPERTY, GENERAL, UNKNOWN';
comment on column public.documents.classification_confidence is '0–100';
comment on column public.documents.classification_method is 'rules | llm | rules_then_llm';
