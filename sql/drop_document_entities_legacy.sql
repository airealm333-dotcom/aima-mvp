-- Run ONLY after the app is deployed and no longer reads/writes public.document_entities.
-- Order: drop dependent view first, then legacy table.
-- After this, re-apply sql/document_entities_reporting_view.sql so document_entities_merged exists again.

drop view if exists public.document_entities_merged;

drop table if exists public.document_entities;
