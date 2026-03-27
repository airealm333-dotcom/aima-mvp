-- Optional: one row per document with universal_minimal, invoice_core, and legal_core
-- columns side by side (for SQL reporting / Supabase charts). Safe to re-run
-- (`create or replace`).

create or replace view public.document_entities_merged as
select
  d.id as document_id,
  um.sender,
  um.addressee,
  um.reference_number,
  um.document_date,
  um.document_type,
  inv.invoice_number,
  inv.invoice_date,
  inv.due_date,
  inv.currency,
  inv.total_amount,
  inv.tax_amount,
  inv.vendor_name,
  inv.buyer_name,
  leg.case_number,
  leg.notice_date,
  leg.authority,
  leg.deadline,
  leg.reference_legal,
  leg.claimant_name,
  leg.respondent_name,
  leg.claimant_email,
  leg.respondent_email,
  leg.respondent_contact_name,
  leg.employment_start_date,
  leg.employment_end_date,
  leg.employment_status,
  leg.occupation,
  leg.basic_salary_monthly,
  um.confidence as universal_confidence,
  inv.confidence as invoice_confidence,
  leg.confidence as legal_confidence
from public.documents d
left join public.document_entities um
  on um.document_id = d.id and um.entity_type = 'universal_minimal'
left join public.document_entities inv
  on inv.document_id = d.id and inv.entity_type = 'invoice_core'
left join public.document_entities leg
  on leg.document_id = d.id and leg.entity_type = 'legal_core';

comment on view public.document_entities_merged is
  'Optional pivot: merged D2.5 entity physical columns per document for reporting.';
