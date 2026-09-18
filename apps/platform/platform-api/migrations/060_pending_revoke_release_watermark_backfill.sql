update genio_one_resource_connections connection
   set revoke_requested_after_release_revision = coalesce((
         select max(command.head_revision)
           from genio_one_platform_runtime_aggregate_commands command
           join genio_one_gateway_registrations registration
             on registration.tenant_id = command.tenant_id
            and registration.runtime_id = command.runtime_id
            and registration.state = 'ACTIVE'
          where command.tenant_id = connection.tenant_id
            and command.runtime_kind = 'GATEWAY'
       ), 0)
 where connection.lifecycle = 'REVOKE_PENDING'
   and connection.revoke_requested_after_release_revision is null;

alter table genio_one_resource_connections
  add constraint genio_one_resource_connections_pending_revoke_watermark_required
  check (lifecycle <> 'REVOKE_PENDING' or revoke_requested_after_release_revision is not null);
