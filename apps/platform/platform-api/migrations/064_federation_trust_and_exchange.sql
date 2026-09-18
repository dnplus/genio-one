create table if not exists genio_one_federation_trust_revisions (
  tenant_id text not null,
  trust_id text not null,
  revision bigint not null check (revision > 0),
  application_id text not null,
  application_subject_id text not null,
  display_name text not null check (length(trim(display_name)) > 0),
  issuer text not null,
  jwks_uri text not null,
  audiences text[] not null check (cardinality(audiences) > 0),
  algorithms text[] not null check (cardinality(algorithms) > 0),
  external_subject_id text not null,
  required_claims jsonb not null default '[]'::jsonb,
  max_assertion_ttl_seconds integer not null check (max_assertion_ttl_seconds between 1 and 3600),
  created_by_subject_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, trust_id, revision),
  foreign key (tenant_id, application_id)
    references genio_one_applications (tenant_id, application_id),
  foreign key (tenant_id, application_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  check (jsonb_typeof(required_claims) = 'array')
);

create table if not exists genio_one_federation_trust_heads (
  tenant_id text not null,
  trust_id text not null,
  application_id text not null,
  current_revision bigint not null check (current_revision > 0),
  state text not null check (state in ('ACTIVE', 'REVOKED')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, trust_id),
  foreign key (tenant_id, trust_id, current_revision)
    references genio_one_federation_trust_revisions (tenant_id, trust_id, revision),
  foreign key (tenant_id, application_id)
    references genio_one_applications (tenant_id, application_id)
);

create index if not exists genio_one_federation_trust_application_idx
  on genio_one_federation_trust_heads (tenant_id, application_id, state, trust_id);

create table if not exists genio_one_federation_exchange_events (
  tenant_id text not null,
  exchange_id text not null,
  correlation_id text not null,
  trust_id text not null,
  trust_revision bigint not null,
  external_issuer text not null,
  external_subject_id text,
  application_id text not null,
  application_subject_id text not null,
  credential_id text,
  credential_generation bigint,
  resource_id text not null,
  capability_id text not null,
  audience text not null,
  scope text not null,
  outcome text not null check (outcome in ('ISSUED', 'REJECTED')),
  rejection_reason text,
  upstream_attempted boolean not null default false check (upstream_attempted = false),
  occurred_at timestamptz not null default now(),
  primary key (tenant_id, exchange_id),
  unique (tenant_id, correlation_id),
  foreign key (tenant_id, trust_id, trust_revision)
    references genio_one_federation_trust_revisions (tenant_id, trust_id, revision),
  check ((outcome = 'ISSUED' and rejection_reason is null and credential_id is not null and credential_generation is not null)
      or (outcome = 'REJECTED' and rejection_reason is not null))
);

create index if not exists genio_one_federation_exchange_application_idx
  on genio_one_federation_exchange_events (tenant_id, application_id, occurred_at desc);
