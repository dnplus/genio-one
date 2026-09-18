create table if not exists genio_one_notification_subscriptions (
  tenant_id text not null,
  subscription_id text not null,
  subject_id text not null,
  notification_type text not null,
  channel text not null,
  enabled boolean not null default true,
  created_by_subject_id text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, subscription_id),
  unique (tenant_id, subject_id, notification_type, channel),
  foreign key (tenant_id, subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  foreign key (tenant_id, created_by_subject_id)
    references genio_one_subjects (tenant_id, subject_id),
  check (notification_type in (
    'ACCESS_REQUEST', 'ENTITLEMENT_EXPIRING',
    'RUNAWAY_INVOCATION_SUSPENDED', 'API_VERSION_LIFECYCLE', 'ALL'
  )),
  check (channel = 'IN_APP')
);

create index if not exists genio_one_notification_subscriptions_subject_idx
  on genio_one_notification_subscriptions (tenant_id, subject_id, updated_at desc);
