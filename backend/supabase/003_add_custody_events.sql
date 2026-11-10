create table if not exists public.custody_events (
  id uuid primary key default gen_random_uuid(),
  fir_id uuid not null references public.firs(id) on delete restrict,
  evidence_id uuid,
  event_type text not null,
  source text not null default 'System',
  actor_label text not null default 'System',
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now()
);

create index if not exists custody_events_fir_occurred_at_idx
  on public.custody_events (fir_id, occurred_at asc);

create index if not exists custody_events_evidence_id_idx
  on public.custody_events (evidence_id);

alter table public.custody_events enable row level security;

create or replace function public.prevent_custody_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Custody events are append-only and cannot be changed';
end;
$$;

drop trigger if exists custody_events_immutable on public.custody_events;
create trigger custody_events_immutable
before update or delete on public.custody_events
for each row execute function public.prevent_custody_event_mutation();

-- Create clearly labelled historical entries for records that existed before
-- custody instrumentation was introduced. These are inferred, not live events.
insert into public.custody_events (fir_id, event_type, source, actor_label, summary, metadata, occurred_at)
select id, 'FIR_REGISTERED', 'Historical record', 'System', 'FIR registered',
  jsonb_build_object('firNumber', fir_number, 'historical', true), created_at
from public.firs f
where not exists (
  select 1 from public.custody_events c
  where c.fir_id = f.id and c.event_type = 'FIR_REGISTERED' and c.source = 'Historical record'
);

insert into public.custody_events (fir_id, evidence_id, event_type, source, actor_label, summary, metadata, occurred_at)
select e.fir_id, e.id, 'EVIDENCE_UPLOADED', 'Historical record', 'System',
  'Evidence uploaded: ' || e.file_name,
  jsonb_build_object('fileName', e.file_name, 'fileHash', e.file_hash, 'historical', true), e.uploaded_at
from public.evidence e
where not exists (
  select 1 from public.custody_events c
  where c.evidence_id = e.id and c.event_type = 'EVIDENCE_UPLOADED' and c.source = 'Historical record'
);

insert into public.custody_events (fir_id, evidence_id, event_type, source, actor_label, summary, metadata, occurred_at)
select e.fir_id, e.id, 'BLOCKCHAIN_REGISTERED', 'Historical record', 'Blockchain',
  'Evidence anchored on blockchain: ' || e.file_name,
  jsonb_build_object('fileName', e.file_name, 'transactionHash', e.blockchain_tx_hash, 'historical', true), e.uploaded_at
from public.evidence e
where e.blockchain_tx_hash is not null
  and not exists (
    select 1 from public.custody_events c
    where c.evidence_id = e.id and c.event_type = 'BLOCKCHAIN_REGISTERED' and c.source = 'Historical record'
  );
