create table if not exists genio_one_use_cases (
  tenant_id text not null,
  organization_id text not null,
  use_case_id text not null,
  display_name text not null,
  state text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, organization_id, use_case_id),
  foreign key (tenant_id, organization_id) references genio_one_organizations (tenant_id, organization_id),
  check (state in ('ACTIVE', 'DISABLED')),
  check (length(trim(display_name)) > 0)
);

create table if not exists genio_one_usage_policy_revisions (
  tenant_id text not null,
  usage_policy_id text not null,
  revision bigint not null,
  owner_organization_id text not null,
  accounting_key_id text not null,
  selectors jsonb not null,
  limits jsonb not null,
  state text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, usage_policy_id, revision),
  foreign key (tenant_id, owner_organization_id) references genio_one_organizations (tenant_id, organization_id),
  check (revision > 0),
  check (state in ('DRAFT', 'ACTIVE', 'RETIRED')),
  check (jsonb_typeof(selectors) = 'object'),
  check (jsonb_typeof(limits) = 'object'),
  check (length(trim(accounting_key_id)) > 0)
);

create table if not exists genio_one_canonical_invocation_accounting (
  tenant_id text not null,
  invocation_id text not null,
  correlation_id text not null,
  subject_id text not null,
  consumer_organization_id text not null,
  resource_owner_organization_id text not null,
  resource_id text not null,
  capability_id text not null,
  use_case_id text not null,
  usage_policy_revisions jsonb not null,
  release_revision text not null,
  accounting_key_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, invocation_id),
  unique (tenant_id, correlation_id, accounting_key_id),
  check (jsonb_typeof(usage_policy_revisions) = 'array')
);

create table if not exists genio_one_usage_quantities (
  tenant_id text not null,
  quantity_id text not null,
  invocation_id text not null,
  quantity numeric not null,
  unit text not null,
  trusted_source text not null,
  observed_at timestamptz not null,
  primary key (tenant_id, quantity_id),
  foreign key (tenant_id, invocation_id) references genio_one_canonical_invocation_accounting (tenant_id, invocation_id),
  check (quantity >= 0)
);

create table if not exists genio_one_canonical_charges (
  tenant_id text not null,
  charge_id text not null,
  invocation_id text not null,
  correlation_id text not null,
  accounting_key_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, charge_id),
  unique (tenant_id, invocation_id, correlation_id, accounting_key_id),
  foreign key (tenant_id, invocation_id) references genio_one_canonical_invocation_accounting (tenant_id, invocation_id)
);

create table if not exists genio_one_cost_valuations (
  tenant_id text not null,
  valuation_id text not null,
  charge_id text not null,
  status text not null,
  currency text not null,
  amount_micros bigint not null,
  pricing_source text not null,
  pricing_version text not null,
  valued_at timestamptz not null,
  primary key (tenant_id, valuation_id),
  foreign key (tenant_id, charge_id) references genio_one_canonical_charges (tenant_id, charge_id),
  check (status in ('ESTIMATED', 'ACTUAL')),
  check (amount_micros >= 0),
  check (length(currency) = 3)
);
