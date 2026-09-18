-- Immutable Gateway-level policy releases for aggregate runtime delivery.
--
-- A release is the complete active projection set for one tenant/gateway,
-- together with the authorization and processor artifacts consumed by the
-- local sidecars.  Per-runtime manifests bind the same common release to a
-- concrete runtime.  The head is an explicit CAS pointer; no query infers
-- active state from MAX(revision).

alter table genio_one_gateway_projections
  add constraint genio_one_gateway_projections_release_reference_key
  unique (tenant_id, projection_id, publication_id, revision, digest);

create table genio_one_gateway_policy_releases (
  tenant_id text not null,
  release_id text not null,
  gateway_id text not null,
  policy_artifact_revision text not null,
  policy_version text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  content_digest text not null,
  projection_set_digest text not null,
  authorization_bundle bytea not null,
  authorization_sha256 text not null,
  authorization_key_id text not null,
  processor_policy bytea not null,
  processor_sha256 text not null,
  processor_key_id text not null,
  enforcement_verification_keys bytea not null,
  enforcement_verification_keys_sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, release_id),
  unique (tenant_id, gateway_id, release_id),
  check (length(trim(tenant_id)) > 0),
  check (length(trim(release_id)) > 0),
  check (length(trim(gateway_id)) > 0),
  check (length(trim(policy_artifact_revision)) > 0),
  check (length(trim(policy_version)) > 0),
  check (expires_at > issued_at),
  check (content_digest ~ '^[a-f0-9]{64}$'),
  check (projection_set_digest ~ '^[a-f0-9]{64}$'),
  check (octet_length(authorization_bundle) > 0),
  check (authorization_sha256 ~ '^[a-f0-9]{64}$'),
  check (length(trim(authorization_key_id)) > 0),
  check (octet_length(processor_policy) > 0),
  check (processor_sha256 ~ '^[a-f0-9]{64}$'),
  check (length(trim(processor_key_id)) > 0),
  check (octet_length(enforcement_verification_keys) > 0),
  check (enforcement_verification_keys_sha256 ~ '^[a-f0-9]{64}$')
);

create table genio_one_gateway_policy_release_projections (
  tenant_id text not null,
  release_id text not null,
  publication_id text not null,
  projection_id text not null,
  projection_revision bigint not null,
  projection_digest text not null,
  primary key (tenant_id, release_id, publication_id),
  unique (tenant_id, release_id, projection_id),
  foreign key (tenant_id, release_id)
    references genio_one_gateway_policy_releases (tenant_id, release_id)
    on delete restrict,
  foreign key (
    tenant_id, projection_id, publication_id, projection_revision, projection_digest
  ) references genio_one_gateway_projections (
    tenant_id, projection_id, publication_id, revision, digest
  ),
  check (length(trim(publication_id)) > 0),
  check (length(trim(projection_id)) > 0),
  check (projection_revision > 0),
  check (projection_digest ~ '^[a-f0-9]{64}$')
);

create index genio_one_gateway_policy_release_projections_projection_idx
  on genio_one_gateway_policy_release_projections
    (tenant_id, projection_id, release_id);

create table genio_one_gateway_policy_release_manifests (
  tenant_id text not null,
  release_id text not null,
  runtime_id text not null,
  gateway_id text not null,
  manifest jsonb not null,
  manifest_jws bytea not null,
  manifest_sha256 text not null,
  manifest_key_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, release_id, runtime_id),
  foreign key (tenant_id, gateway_id, release_id)
    references genio_one_gateway_policy_releases
      (tenant_id, gateway_id, release_id)
    on delete restrict,
  check (length(trim(runtime_id)) > 0),
  check (jsonb_typeof(manifest) = 'object'),
  check (octet_length(manifest_jws) > 0),
  check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  check (length(trim(manifest_key_id)) > 0)
);

create table genio_one_gateway_policy_release_heads (
  tenant_id text not null,
  gateway_id text not null,
  release_id text not null,
  content_digest text not null,
  head_revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, gateway_id),
  foreign key (tenant_id, gateway_id, release_id)
    references genio_one_gateway_policy_releases
      (tenant_id, gateway_id, release_id)
    on delete restrict,
  check (content_digest ~ '^[a-f0-9]{64}$'),
  check (head_revision > 0)
);
