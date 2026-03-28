-- Run ONLY after the app is deployed and no longer reads/writes public.document_entities.
-- Recommended order (Supabase SQL editor):
--   1) Optional: sql/document_entities_legacy_audit.sql (inspect triggers/functions).
--   2) sql/drop_document_entities_triggers_on_documents.sql (stops auto-inserts from public.documents).
--   3) This file: drop dependent view, then legacy table.
--   4) sql/document_entities_reporting_view.sql — recreates public.document_entities_merged from the three typed tables.
--
-- If new rows still appeared with only document_id set, a trigger on documents was the usual cause.

drop view if exists public.document_entities_merged;

drop table if exists public.document_entities;
