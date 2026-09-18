alter table genio_one_application_api_credentials
  add column if not exists predecessor_credential_id text,
  add column if not exists operation_correlation_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'genio_one_application_api_credentials_predecessor_fk'
  ) then
    alter table genio_one_application_api_credentials
      add constraint genio_one_application_api_credentials_predecessor_fk
      foreign key (tenant_id, predecessor_credential_id)
      references genio_one_application_api_credentials (tenant_id, credential_id);
  end if;
end
$$;

create unique index if not exists genio_one_application_api_credentials_operation_idx
  on genio_one_application_api_credentials
    (tenant_id, application_id, operation_correlation_id)
  where operation_correlation_id is not null;

create index if not exists genio_one_application_api_credentials_retirement_idx
  on genio_one_application_api_credentials
    (tenant_id, valid_until, credential_id)
  where state = 'RETIRED' and external_subject_id is not null;
