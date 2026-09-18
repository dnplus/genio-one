create table if not exists genio_one_demo_installations (
  tenant_id text primary key,
  organization_id text,
  installation text not null,
  resource_ids text[] not null default '{}',
  item_errors text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (installation in ('SKIPPED', 'INSTALLED')),
  check ((installation = 'SKIPPED' and organization_id is null) or installation = 'INSTALLED')
);
