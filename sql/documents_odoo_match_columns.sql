-- SOP D3 client matching (Odoo res.partner) — separate from classification D3 review statuses.
-- Run once in Supabase SQL Editor after public.documents exists.

alter table public.documents
  add column if not exists odoo_partner_id bigint,
  add column if not exists odoo_match_status text,
  add column if not exists odoo_match_score integer,
  add column if not exists odoo_match_method text,
  add column if not exists odoo_match_candidates jsonb,
  add column if not exists odoo_match_attempted_at timestamptz;

create index if not exists documents_odoo_partner_id_idx
  on public.documents (odoo_partner_id)
  where odoo_partner_id is not null;

create index if not exists documents_odoo_match_status_idx
  on public.documents (odoo_match_status);

comment on column public.documents.odoo_partner_id is 'Odoo res.partner id when SOP D3 match succeeded';
comment on column public.documents.odoo_match_status is 'SOP D3: matched | ambiguous | no_match | skipped | error (RPC/pipeline failure)';
comment on column public.documents.odoo_match_score is 'Best fuzzy/normalized match score 0–100 when applicable';
comment on column public.documents.odoo_match_method is 'uen_exact | legal_exact | fuzzy_name | skipped | error';
comment on column public.documents.odoo_match_candidates is 'Trimmed JSON list of {id, score, name} for audit/review';
comment on column public.documents.odoo_match_attempted_at is 'Last automatic Odoo match attempt timestamp';
