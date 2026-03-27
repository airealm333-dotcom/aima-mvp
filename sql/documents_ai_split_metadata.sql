-- AI split metadata for logical-section segmentation
alter table public.documents
  add column if not exists split_section_type text,
  add column if not exists split_reason text,
  add column if not exists split_model text;

create index if not exists idx_documents_split_section_type
  on public.documents (split_section_type);
