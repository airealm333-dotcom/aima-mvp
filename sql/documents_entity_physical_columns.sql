-- D2.5 expansion: physical columns for universal, invoice, and legal core fields
-- on top of entities_json payload.

alter table public.document_entities
  add column if not exists sender text,
  add column if not exists addressee text,
  add column if not exists reference_number text,
  add column if not exists document_date date,
  add column if not exists document_type text,
  add column if not exists invoice_number text,
  add column if not exists invoice_date date,
  add column if not exists due_date date,
  add column if not exists currency text,
  add column if not exists total_amount numeric(18,2),
  add column if not exists tax_amount numeric(18,2),
  add column if not exists vendor_name text,
  add column if not exists buyer_name text,
  add column if not exists case_number text,
  add column if not exists notice_date date,
  add column if not exists authority text,
  add column if not exists deadline date,
  add column if not exists reference_legal text;

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'document_entities_entity_type_check'
  ) then
    alter table public.document_entities
      drop constraint document_entities_entity_type_check;
  end if;
end $$;

alter table public.document_entities
  add constraint document_entities_entity_type_check
  check (entity_type in ('universal_minimal', 'invoice_core', 'legal_core'));

create index if not exists idx_document_entities_invoice_number
  on public.document_entities (invoice_number);

create index if not exists idx_document_entities_case_number
  on public.document_entities (case_number);

