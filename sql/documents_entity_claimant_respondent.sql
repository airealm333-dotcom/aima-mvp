-- D2.5 ECT / Employment Claims Tribunal claim forms:
-- claimant = employee/individual; respondent = employer/company.

alter table public.document_entities
  add column if not exists claimant_name text,
  add column if not exists respondent_name text;

create index if not exists idx_document_entities_claimant_name
  on public.document_entities (claimant_name);

create index if not exists idx_document_entities_respondent_name
  on public.document_entities (respondent_name);

