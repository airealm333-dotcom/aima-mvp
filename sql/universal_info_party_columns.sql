-- Add semantic party fields to universal_info (apply once on existing DBs).
-- recipient_name / sender_name = directional (to/from on the mail piece).
-- organization_name = client company / legal entity when identifiable.
-- contact_person_name = natural person when explicitly labeled (Attn, signatory, etc.).

alter table public.universal_info
  add column if not exists organization_name text,
  add column if not exists contact_person_name text;

comment on column public.universal_info.organization_name is
  'Client company or legal entity the mail concerns (registered-office context).';
comment on column public.universal_info.contact_person_name is
  'Named individual when clearly indicated in OCR; null if unclear.';
