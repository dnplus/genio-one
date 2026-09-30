create table genio_one_posthog_integrations (
  tenant_id text primary key,
  enabled boolean not null default false,
  host text,
  project_id bigint,
  project_token text,
  configured_by_subject_id text,
  configured_at timestamptz,
  constraint genio_one_posthog_integrations_host_check
    check (host is null or host in ('https://us.i.posthog.com', 'https://eu.i.posthog.com')),
  constraint genio_one_posthog_integrations_project_id_check
    check (project_id is null or project_id > 0),
  constraint genio_one_posthog_integrations_project_token_check
    check (project_token is null or project_token ~ '^phc_[A-Za-z0-9_-]+$'),
  constraint genio_one_posthog_integrations_enabled_binding_check
    check (not enabled or (host is not null and project_id is not null and project_token is not null))
);
