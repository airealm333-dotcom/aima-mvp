-- D2.5: Extracted business entities (OCR -> rule-first extractor)
-- Creates a flexible table to store structured fields extracted from each document.

create extension if not exists pgcrypto;

create table if not exists public.document_entities (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  entity_type text not null check (entity_type in ('universal_minimal', 'invoice_core')),
  entities_json jsonb not null default '{}'::jsonb,
  confidence integer not null default 0,
  method text not null default 'rules',
  created_at timestamptz not null default now(),

  -- Ensure we can upsert latest extraction per type.
  unique (document_id, entity_type)
);

create index if not exists idx_document_entities_document_id
  on public.document_entities (document_id);

create index if not exists idx_document_entities_entity_type
  on public.document_entities (entity_type);

