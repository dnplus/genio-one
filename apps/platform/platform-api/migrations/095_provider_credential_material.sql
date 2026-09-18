alter table genio_one_provider_credential_profile_revisions
  add column if not exists credential_ciphertext text;
