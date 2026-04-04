-- Queue rows for Gmail messages in the Unprocessed label (dashboard + sequential intake).
-- Run in Supabase SQL editor.

create table if not exists public.gmail_intake_queue (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,
  subject text,
  subject_mrid text,
  subject_drid text,
  snippet text,
  internal_date_ms bigint,
  attachment_filename text,
  attachment_mime text,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'ingested', 'skipped', 'failed')),
  error_message text,
  processing_started_at timestamptz,
  ingested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists gmail_intake_queue_status_internal_date_idx
  on public.gmail_intake_queue (status, internal_date_ms);

comment on table public.gmail_intake_queue is
  'Gmail Unprocessed messages mirrored for dashboard; intake processes one queued row at a time.';
