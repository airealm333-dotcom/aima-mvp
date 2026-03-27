-- Apply once in Supabase SQL Editor (adjust schema if not public).
-- Tracks duplicate submissions by content hash while preserving each intake row.

alter table public.documents
  add column if not exists is_duplicate boolean not null default false,
  add column if not exists duplicate_of_document_id uuid null,
  add column if not exists duplicate_reason text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_duplicate_of_document_id_fkey'
  ) then
    alter table public.documents
      add constraint documents_duplicate_of_document_id_fkey
      foreign key (duplicate_of_document_id) references public.documents(id);
  end if;
end $$;

create index if not exists documents_sha256_hash_idx
  on public.documents (sha256_hash);
