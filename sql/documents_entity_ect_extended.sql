-- ECT claim forms: emails, respondent contact, Section C employment fields.
-- Apply after documents_entity_claimant_respondent.sql

alter table public.document_entities
  add column if not exists claimant_email text,
  add column if not exists respondent_email text,
  add column if not exists respondent_contact_name text,
  add column if not exists employment_start_date date,
  add column if not exists employment_end_date date,
  add column if not exists employment_status text,
  add column if not exists occupation text,
  add column if not exists basic_salary_monthly numeric(18,2);

create index if not exists idx_document_entities_claimant_email
  on public.document_entities (claimant_email);

create index if not exists idx_document_entities_respondent_email
  on public.document_entities (respondent_email);
