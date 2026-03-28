-- Removes user triggers on public.documents whose definition mentions document_entities.
-- Typical cause of "empty" rows: AFTER INSERT on documents -> INSERT INTO document_entities (document_id).
-- Safe to run if the app only uses universal_info / legal_entities / invoice_entities (see intake-process.ts).
-- Review output in document_entities_legacy_audit.sql first if unsure.

do $$
declare
  r record;
begin
  for r in
    select t.tgname
    from pg_trigger t
    where t.tgrelid = 'public.documents'::regclass
      and not t.tgisinternal
      and pg_get_triggerdef(t.oid) ilike '%document_entities%'
  loop
    execute format('drop trigger if exists %I on public.documents', r.tgname);
    raise notice 'Dropped trigger % on public.documents', r.tgname;
  end loop;
end $$;
