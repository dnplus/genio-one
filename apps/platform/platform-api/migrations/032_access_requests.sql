create table if not exists genio_one_access_requests (
  tenant_id text not null,
  access_request_id text not null,
  requester_subject_id text not null,
  target_subject_id text not null,
  acting_client_id text,
  resource_id text not null,
  capability_id text not null,
  owner_organization_id text not null,
  justification text not null,
  requested_valid_for integer not null,
  configuration_revision text,
  approval_workflow_version text,
  state text not null default 'PENDING',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  resolved_at timestamptz,
  resolution_reason text,
  decided_by_subject_id text,
  entitlement_id text,
  primary key (tenant_id, access_request_id),
  foreign key (tenant_id, requester_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, target_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, resource_id)
    references genio_one_resources (tenant_id, resource_id),
  foreign key (tenant_id, owner_organization_id)
    references genio_one_organizations (tenant_id, organization_id),
  check (state in ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED', 'EXPIRED')),
  check (requested_valid_for > 0),
  check (length(trim(justification)) > 0)
);

create unique index if not exists genio_one_access_requests_one_pending_idx
  on genio_one_access_requests (tenant_id, target_subject_id, resource_id, capability_id)
  where state = 'PENDING';

create index if not exists genio_one_access_requests_owner_idx
  on genio_one_access_requests (tenant_id, owner_organization_id, created_at desc);
