-- Adds routing/dispatch lifecycle columns to consolidated document_entities.
-- Safe to run multiple times.

alter table public.document_entities
  add column if not exists recipient_address text,
  add column if not exists subject_line text,
  add column if not exists match_confidence integer,
  add column if not exists odoo_partner_id bigint,
  add column if not exists odoo_contact_email text,
  add column if not exists dispatch_date timestamptz,
  add column if not exists email_message_id text,
  add column if not exists attachment_hash text;

create index if not exists idx_document_entities_attachment_hash
  on public.document_entities (attachment_hash);

create index if not exists idx_document_entities_odoo_partner_id
  on public.document_entities (odoo_partner_id);

create index if not exists idx_document_entities_dispatch_date
  on public.document_entities (dispatch_date);

create index if not exists idx_document_entities_email_message_id
  on public.document_entities (email_message_id);

comment on column public.document_entities.recipient_address is
  'Extracted recipient/client address for fallback matching.';
comment on column public.document_entities.subject_line is
  'One-line document subject/summary used for dispatch body composition.';
comment on column public.document_entities.match_confidence is
  'D3 client matching confidence score (0-100).';
comment on column public.document_entities.odoo_partner_id is
  'Resolved Odoo res.partner id after D3 client matching.';
comment on column public.document_entities.odoo_contact_email is
  'Resolved recipient email from Odoo contact lookup (D4).';
comment on column public.document_entities.dispatch_date is
  'Dispatch timestamp when document is sent to client (D6).';
comment on column public.document_entities.email_message_id is
  'Outbound email message id used for dispatch tracking.';
comment on column public.document_entities.attachment_hash is
  'SHA256 hash used for deduplication and evidence.';
