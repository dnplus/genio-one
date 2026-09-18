-- Generalize the first model-only Entitlement projection into the canonical
-- Subject -> Resource Capability grant. Public Model remains an optional LLM
-- constraint instead of the target identity of every Entitlement.

alter table genio_one_model_entitlements
  add column if not exists resource_id text,
  add column if not exists capability_id text;

update genio_one_model_entitlements entitlement
   set resource_id = model.resource_id,
       capability_id = 'model.invoke'
  from genio_one_public_models model
 where entitlement.tenant_id = model.tenant_id
   and entitlement.public_model_id = model.model_id
   and (entitlement.resource_id is null or entitlement.capability_id is null);

alter table genio_one_model_entitlements
  alter column resource_id set not null,
  alter column capability_id set not null,
  alter column public_model_id drop not null;

alter table genio_one_model_entitlements
  add constraint genio_one_entitlements_resource_fk
  foreign key (tenant_id, resource_id)
  references genio_one_resources (tenant_id, resource_id);

create index if not exists genio_one_entitlements_capability_idx
  on genio_one_model_entitlements
    (tenant_id, resource_id, capability_id, state, starts_at, expires_at);
