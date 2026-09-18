update genio_one_resource_connections connection
   set revoke_requested_after_release_revision = coalesce((
         select max(command.head_revision)
           from genio_one_platform_runtime_aggregate_commands command
           join genio_one_platform_runtime_registrations registration
             on registration.tenant_id = command.tenant_id
            and registration.runtime_kind = command.runtime_kind
            and registration.runtime_id = command.runtime_id
            and registration.status = 'ACTIVE'
           join lateral (
             select publication.gateway_id
               from genio_one_publications publication
              where publication.tenant_id = connection.tenant_id
                and publication.resource_id = connection.resource_id
                and publication.publication_state = 'PUBLISHED'
                and publication.updated_at <= connection.updated_at
              order by publication.endpoint_revision desc
              limit 1
           ) publication on publication.gateway_id = registration.target_id
          where command.tenant_id = connection.tenant_id
            and command.runtime_kind = 'GATEWAY'
            and command.created_at <= connection.updated_at
       ), 0)
 where connection.lifecycle = 'REVOKE_PENDING';
