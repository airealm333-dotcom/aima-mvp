-- After cutover + test ingest: confirm typed tables receive data (app does not use document_entities).
-- 1) Run after drop_document_entities_legacy.sql — legacy table should be gone.
-- 2) Ingest one document via the app, then re-run counts below.

select exists (
  select 1
  from information_schema.tables
  where table_schema = 'public'
    and table_name = 'document_entities'
) as legacy_document_entities_table_exists;

select count(*) as universal_info_rows from public.universal_info;
select count(*) as legal_entities_rows from public.legal_entities;
select count(*) as invoice_entities_rows from public.invoice_entities;
