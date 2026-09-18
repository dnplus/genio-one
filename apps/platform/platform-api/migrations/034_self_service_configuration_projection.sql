create table if not exists genio_one_self_service_configuration_projections (
  tenant_id text primary key,
  revision text not null,
  projected_at timestamptz not null default now(),
  foreign key (tenant_id, revision)
    references genio_one_tenant_configuration_revisions (tenant_id, revision)
);

insert into genio_one_self_service_configuration_projections
  (tenant_id, revision, projected_at)
select distinct on (tenant_id)
  tenant_id,
  revision,
  coalesce(projection_last_reconciled_at, published_at, created_at)
from genio_one_tenant_configuration_revisions
where state = 'PUBLISHED' and projection_status <> 'FAILED'
order by tenant_id, created_at desc, revision desc
on conflict (tenant_id) do nothing;

update genio_one_tenant_configuration_revisions revision
   set observed_revision = revision.revision,
       projection_status = 'CONVERGED',
       projection_drift = false,
       projection_last_error = null,
       projection_last_reconciled_at = projection.projected_at
  from genio_one_self_service_configuration_projections projection
 where revision.tenant_id = projection.tenant_id
   and revision.revision = projection.revision
   and revision.state = 'PUBLISHED'
   and revision.projection_status = 'PENDING';
