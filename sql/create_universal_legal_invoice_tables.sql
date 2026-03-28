-- D2.5 replacement for document_entities: three typed tables keyed to documents(id).
-- Apply AFTER public.documents exists. Run BEFORE app cutover from document_entities.
-- Requires: pgcrypto (gen_random_uuid).

create extension if not exists pgcrypto;

-- 1:1 enrichment per intake document (plus drid/mrid for convenience).
create table if not exists public.universal_info (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  drid text not null,
  mrid text not null,
  full_text text,
  recipient_name text,
  recipient_uen text,
  recipient_address text,
  sender_name text,
  sender_address text,
  document_date date,
  reference_number text,
  document_type text not null default 'UNKNOWN',
  document_subtype text,
  subject_line text,
  action_required boolean not null default false,
  deadline_date date,
  priority text not null default 'MEDIUM',
  page_start integer,
  page_end integer,
  page_count integer,
  pdf_path text,
  original_pdf_path text,
  classification_confidence integer,
  match_confidence integer,
  status text not null default 'D2_CLASSIFIED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint universal_info_document_id_key unique (document_id),
  constraint universal_info_drid_key unique (drid)
);

create index if not exists idx_universal_info_document_id
  on public.universal_info (document_id);

create or replace function public.universal_info_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists universal_info_updated_at on public.universal_info;
create trigger universal_info_updated_at
  before update on public.universal_info
  for each row execute function public.universal_info_set_updated_at();

comment on table public.universal_info is 'Per-document universal/envelope fields (1:1 with documents).';

-- Optional legal / tribunal / tax-shaped fields (0..1 per document).
create table if not exists public.legal_entities (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  case_number text,
  court_name text,
  claimant_name text,
  claimant_address text,
  claimant_contact text,
  claimant_email text,
  respondent_name text,
  respondent_address text,
  respondent_contact text,
  respondent_email text,
  claim_type text,
  claim_amount decimal(15,2),
  claim_summary text,
  hearing_date timestamptz,
  hearing_location text,
  hearing_type text,
  crc_number text,
  online_access_code text,
  online_portal_url text,
  tax_reference text,
  year_of_assessment text,
  tax_amount decimal(15,2),
  surcharge_amount decimal(15,2),
  strike_off_date date,
  acra_reference text,
  employment_start_date date,
  employment_end_date date,
  dismissal_date date,
  basic_salary decimal(15,2),
  occupation text,
  legal_statute text,
  created_at timestamptz not null default now(),
  constraint legal_entities_document_id_key unique (document_id)
);

create index if not exists idx_legal_entities_document_id
  on public.legal_entities (document_id);

comment on table public.legal_entities is 'Legal / ECT / tax / ACRA-style fields (0..1 per document).';

-- Invoice / utility / demand-shaped fields (0..1 per document).
create table if not exists public.invoice_entities (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  account_number text,
  account_name text,
  bill_number text,
  bill_date date,
  due_date date,
  service_period_start date,
  service_period_end date,
  currency text not null default 'SGD',
  previous_balance decimal(15,2),
  payment_received decimal(15,2),
  current_charges decimal(15,2),
  gst_amount decimal(15,2),
  total_amount_due decimal(15,2),
  payment_code text,
  giro_reference text,
  paynow_reference text,
  demand_amount decimal(15,2),
  demand_currency text,
  demand_deadline date,
  interest_rate decimal(5,2),
  service_type text,
  mobile_number text,
  plan_name text,
  bank_name text,
  d_and_t_reference text,
  audit_period text,
  created_at timestamptz not null default now(),
  constraint invoice_entities_document_id_key unique (document_id)
);

create index if not exists idx_invoice_entities_document_id
  on public.invoice_entities (document_id);

comment on table public.invoice_entities is 'Invoice / bill / utility-style fields (0..1 per document).';
