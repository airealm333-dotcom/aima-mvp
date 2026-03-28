-- Optional reporting view: one row per document (universal + legal + invoice).
-- Apply after create_universal_legal_invoice_tables.sql.
-- Replaces the old view that joined public.document_entities.

create or replace view public.document_entities_merged as
select
  d.id as document_id,
  u.sender_name,
  u.recipient_name,
  u.reference_number,
  u.document_date,
  u.document_type,
  u.full_text,
  u.drid,
  u.mrid,
  u.pdf_path,
  u.classification_confidence,
  u.status as universal_status,
  inv.bill_number,
  inv.bill_date,
  inv.due_date,
  inv.currency,
  inv.total_amount_due,
  inv.gst_amount,
  inv.account_name,
  leg.case_number,
  leg.claimant_name,
  leg.respondent_name,
  leg.claimant_email,
  leg.respondent_email,
  leg.employment_start_date,
  leg.employment_end_date,
  leg.occupation,
  leg.basic_salary
from public.documents d
left join public.universal_info u on u.document_id = d.id
left join public.invoice_entities inv on inv.document_id = d.id
left join public.legal_entities leg on leg.document_id = d.id;

comment on view public.document_entities_merged is
  'Merged universal_info + invoice_entities + legal_entities per document for reporting.';
