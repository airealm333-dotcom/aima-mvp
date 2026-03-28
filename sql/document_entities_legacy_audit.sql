-- Read-only audit: find what still references public.document_entities (run in Supabase SQL editor).
-- Use before dropping the legacy table or triggers.

-- 1) Triggers on public.documents
select tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t
where t.tgrelid = 'public.documents'::regclass
  and not t.tgisinternal
order by tgname;

-- 2) Triggers on public.document_entities
select tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t
where t.tgrelid = 'public.document_entities'::regclass
  and not t.tgisinternal
order by tgname;

-- 3) Functions whose body mentions the table (may include harmless references)
select n.nspname as schema, p.proname as name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.prosrc ilike '%document_entities%'
  and n.nspname = 'public'
order by p.proname;
