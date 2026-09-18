-- Durable review/build state for atomic Resource publication.
--
-- The immutable snapshot is captured before review. Approval claims one build
-- attempt while the Resource remains DRAFT; only the final transaction that
-- persists the signed projection may publish both Resource and endpoint.

alter table genio_one_publications
  add column publication_snapshot jsonb not null default '{}'::jsonb,
  add column publication_build_state text not null default 'IDLE',
  add column build_attempt_id text,
  add column last_error_code text,
  add column projection_digest text;

alter table genio_one_publications
  add constraint genio_one_publications_snapshot_object_check
    check (jsonb_typeof(publication_snapshot) = 'object'),
  add constraint genio_one_publications_build_state_check
    check (publication_build_state in ('IDLE', 'PENDING_REVIEW', 'BUILDING', 'FAILED', 'READY')),
  add constraint genio_one_publications_attempt_state_check
    check (
      (publication_build_state in ('BUILDING', 'FAILED', 'READY') and build_attempt_id is not null)
      or
      (publication_build_state in ('IDLE', 'PENDING_REVIEW') and build_attempt_id is null)
    );

create table genio_one_publication_build_attempts (
  tenant_id text not null,
  publication_id text not null,
  attempt_id text not null,
  request_id text not null,
  snapshot_digest text not null,
  state text not null,
  projection_digest text,
  failure_code text,
  claimed_by text not null,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, publication_id, attempt_id),
  foreign key (tenant_id, publication_id)
    references genio_one_publications (tenant_id, publication_id),
  check (state in ('BUILDING', 'FAILED', 'READY')),
  check (length(trim(request_id)) > 0),
  check (length(trim(snapshot_digest)) > 0),
  check (length(trim(claimed_by)) > 0)
);

create unique index genio_one_publication_one_building_attempt_idx
  on genio_one_publication_build_attempts (tenant_id, publication_id)
  where state = 'BUILDING';
