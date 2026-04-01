-- Reporting view backed by consolidated public.document_entities.

create or replace view public.document_entities_merged as
select
  d.id as document_id,
  e.sender_name,
  e.recipient_name,
  e.organization_name,
  e.contact_person_name,
  e.reference_number,
  e.document_date,
  e.document_type,
  e.full_text,
  e.drid,
  e.mrid,
  e.pdf_path,
  e.classification_confidence,
  e.status as universal_status,
  null::text as bill_number,
  null::date as bill_date,
  null::date as due_date,
  null::text as currency,
  null::numeric as total_amount_due,
  null::numeric as gst_amount,
  e.account_name,
  null::text as case_number,
  e.claimant_name,
  e.respondent_name,
  e.claimant_email,
  e.respondent_email,
  null::date as employment_start_date,
  null::date as employment_end_date,
  null::text as occupation,
  null::numeric as basic_salary
from public.documents d
left join public.document_entities e on e.document_id = d.id;

comment on view public.document_entities_merged is
  'Merged reporting view sourced from consolidated document_entities.';
