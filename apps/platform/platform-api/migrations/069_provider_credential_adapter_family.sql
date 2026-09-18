alter table genio_one_provider_credential_profile_revisions
  drop constraint if exists genio_one_provider_credential_profile_revis_provider_type_check;

alter table genio_one_provider_credential_profile_revisions
  rename column provider_type to adapter_family;

update genio_one_provider_credential_profile_revisions
   set adapter_family = case
     when adapter_family = 'GCP_VERTEX_AI' then 'GCP'
     else 'GENERIC'
   end;

alter table genio_one_provider_credential_profile_revisions
  add constraint genio_one_provider_credential_adapter_family_check
  check (adapter_family in ('GENERIC', 'GCP'));
