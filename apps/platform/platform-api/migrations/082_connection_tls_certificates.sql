alter table genio_one_resource_connections
  add column if not exists certificate_mode text not null default 'SYSTEM_CA',
  add column if not exists certificate_pem text,
  add column if not exists certificate_fingerprint_sha256 text,
  add column if not exists certificate_subject text,
  add column if not exists certificate_issuer text,
  add column if not exists certificate_is_self_signed boolean not null default false,
  add column if not exists certificate_not_before timestamptz,
  add column if not exists certificate_not_after timestamptz;

alter table genio_one_resource_connections
  add constraint genio_one_connections_certificate_mode
  check (certificate_mode in ('SYSTEM_CA', 'CUSTOM_CA')),
  add constraint genio_one_connections_certificate_pem_length
  check (certificate_pem is null or length(certificate_pem) <= 131072),
  add constraint genio_one_connections_certificate_fingerprint
  check (certificate_fingerprint_sha256 is null or certificate_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  add constraint genio_one_connections_certificate_window
  check (certificate_not_before is null or certificate_not_after is null or certificate_not_after > certificate_not_before),
  add constraint genio_one_connections_certificate_shape
  check (
    (certificate_mode = 'SYSTEM_CA'
      and certificate_pem is null
      and certificate_fingerprint_sha256 is null
      and certificate_subject is null
      and certificate_issuer is null
      and certificate_is_self_signed = false
      and certificate_not_before is null
      and certificate_not_after is null)
    or
    (certificate_mode = 'CUSTOM_CA'
      and certificate_pem is not null
      and certificate_fingerprint_sha256 is not null
      and certificate_subject is not null
      and certificate_issuer is not null
      and certificate_not_before is not null
      and certificate_not_after is not null)
  );

create index if not exists genio_one_connections_certificate_expiry_idx
  on genio_one_resource_connections (tenant_id, certificate_not_after)
  where certificate_mode = 'CUSTOM_CA';
