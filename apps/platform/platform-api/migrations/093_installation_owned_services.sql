alter table genio_one_resources
  add column if not exists installation_owned boolean not null default false,
  add column if not exists service_kind text;

alter table genio_one_resources
  drop constraint if exists genio_one_resources_service_kind_check,
  drop constraint if exists genio_one_resources_installation_owned_check;

alter table genio_one_resources
  add constraint genio_one_resources_service_kind_check
  check (service_kind is null or service_kind in ('SERVICENOW_CSM', 'MAIL2000', 'DISCOVERY', 'GENIO_BOT')),
  add constraint genio_one_resources_installation_owned_check
  check (not installation_owned or service_kind is not null);

create unique index if not exists genio_one_resources_installation_service_unique
  on genio_one_resources (tenant_id, service_kind)
  where installation_owned and service_kind is not null;

create or replace function genio_one_guard_installation_owned_resource()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.installation_owned then
      raise exception 'INSTALLATION_OWNED_RESOURCE_CANNOT_DELETE' using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if old.installation_owned then
    if new.resource_id is distinct from old.resource_id
      or new.kind is distinct from old.kind
      or new.owner_organization_id is distinct from old.owner_organization_id
      or new.service_kind is distinct from old.service_kind
      or new.installation_owned is distinct from old.installation_owned
      or new.enforcement_point_id is distinct from old.enforcement_point_id
      or new.environment_id is distinct from old.environment_id
      or new.authentication_strategy is distinct from old.authentication_strategy
      or (new.lifecycle is distinct from old.lifecycle
        and not (old.lifecycle = 'DRAFT' and new.lifecycle = 'PUBLISHED')) then
      raise exception 'INSTALLATION_OWNED_RESOURCE_IDENTITY' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists genio_one_guard_installation_owned_resource on genio_one_resources;
create trigger genio_one_guard_installation_owned_resource
before update or delete on genio_one_resources
for each row execute function genio_one_guard_installation_owned_resource();
