-- Split metadata for multi-attachment and multi-invoice intake
alter table public.documents
  add column if not exists split_parent_ref text,
  add column if not exists split_index integer,
  add column if not exists split_total integer,
  add column if not exists split_method text,
  add column if not exists split_confidence integer,
  add column if not exists multi_invoice_suspected boolean not null default false;

create index if not exists idx_documents_split_parent_ref
  on public.documents (split_parent_ref);

create index if not exists idx_documents_multi_invoice_suspected
  on public.documents (multi_invoice_suspected);
