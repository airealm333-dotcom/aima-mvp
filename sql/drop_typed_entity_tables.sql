-- Run only after cutover to public.document_entities is confirmed.
-- Drops typed legacy tables and replaces reporting view to use consolidated table.

drop view if exists public.document_entities_merged;

drop table if exists public.universal_info cascade;
drop table if exists public.legal_entities cascade;
drop table if exists public.invoice_entities cascade;
