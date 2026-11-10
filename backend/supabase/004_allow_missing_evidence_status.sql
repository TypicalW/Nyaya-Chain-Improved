-- Preserve the existing integrity statuses and add Missing. Adding the new
-- validated constraint before dropping the old one keeps the transition
-- atomic and ensures existing rows satisfy the new allowed set.
begin;

alter table public.evidence
  add constraint evidence_verification_status_check_with_missing
  check (verification_status in ('Pending', 'Verified', 'Tampered', 'Missing'));

alter table public.evidence
  drop constraint evidence_verification_status_check;

alter table public.evidence
  rename constraint evidence_verification_status_check_with_missing
  to evidence_verification_status_check;

commit;
