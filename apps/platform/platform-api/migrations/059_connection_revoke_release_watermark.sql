alter table genio_one_resource_connections
  add column if not exists revoke_requested_after_release_revision bigint;

alter table genio_one_resource_connections
  add constraint genio_one_resource_connections_revoke_release_watermark_nonnegative
  check (revoke_requested_after_release_revision is null or revoke_requested_after_release_revision >= 0);
