-- Consolidated per-document entities table (single row per document).
-- Apply after public.documents exists.

create extension if not exists pgcrypto;

drop table if exists public.document_entities cascade;

create table if not exists public.document_entities (
  document_id uuid primary key references public.documents(id) on delete cascade,
  drid text not null,
  mrid text not null,
  full_text text,
  document_type text not null default 'UNKNOWN',
  classification_confidence integer,
  organization_name text,
  recipient_name text,
  recipient_address text,
  sender_name text,
  subject_line text,
  contact_person_name text,
  recipient_uen text,
  reference_number text,
  claimant_name text,
  claimant_email text,
  respondent_name text,
  respondent_email text,
  document_date date,
  deadline_date date,
  action_required boolean not null default false,
  account_name text,
  page_start integer,
  page_end integer,
  page_count integer,
  pdf_path text,
  original_pdf_path text,
  attachment_hash text,
  match_confidence integer,
  odoo_partner_id bigint,
  odoo_contact_email text,
  dispatch_date timestamptz,
  email_message_id text,
  priority text not null default 'MEDIUM',
  status text not null default 'D2_CLASSIFIED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_document_entities_recipient_uen
  on public.document_entities (recipient_uen);

create index if not exists idx_document_entities_organization_name
  on public.document_entities (organization_name);

create index if not exists idx_document_entities_document_type
  on public.document_entities (document_type);

create index if not exists idx_document_entities_attachment_hash
  on public.document_entities (attachment_hash);

create index if not exists idx_document_entities_odoo_partner_id
  on public.document_entities (odoo_partner_id);

create index if not exists idx_document_entities_dispatch_date
  on public.document_entities (dispatch_date);

create index if not exists idx_document_entities_email_message_id
  on public.document_entities (email_message_id);

create or replace function public.document_entities_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists document_entities_updated_at on public.document_entities;
create trigger document_entities_updated_at
  before update on public.document_entities
  for each row execute function public.document_entities_set_updated_at();

comment on table public.document_entities is
  'Single-row consolidated entities per document for SOP D2.5/D3/D4.';
