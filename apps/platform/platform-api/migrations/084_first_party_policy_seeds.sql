create table if not exists genio_one_first_party_policy_seeds (
  tenant_id text not null,
  policy_id text not null,
  policy_revision integer not null default 1,
  seed boolean not null default true,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, policy_id),
  check (policy_id = 'one-policy.first-party.bot-default'),
  check (policy_revision = 1),
  check (seed)
);

create index if not exists genio_one_first_party_policy_seeds_enabled_idx
  on genio_one_first_party_policy_seeds (tenant_id, enabled);
