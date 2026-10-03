lock table genio_one_team_workspaces, genio_one_access_groups in share row exclusive mode;

do $$
declare
  mismatch_count bigint;
begin
  select count(*)
    into mismatch_count
    from genio_one_team_workspaces as workspace
    left join genio_one_access_groups as reader
      on reader.tenant_id = workspace.tenant_id
      and reader.organization_id = workspace.organization_id
      and reader.access_group_id = workspace.reader_access_group_id
    left join genio_one_access_groups as contributor
      on contributor.tenant_id = workspace.tenant_id
      and contributor.organization_id = workspace.organization_id
      and contributor.access_group_id = workspace.contributor_access_group_id
    left join genio_one_access_groups as maintainer
      on maintainer.tenant_id = workspace.tenant_id
      and maintainer.organization_id = workspace.organization_id
      and maintainer.access_group_id = workspace.maintainer_access_group_id
    where reader.access_group_id is null
      or contributor.access_group_id is null
      or maintainer.access_group_id is null;
  if mismatch_count > 0 then
    raise exception 'Cannot add Team Workspace Access Group ownership constraints: % mismatched workspace bindings exist', mismatch_count;
  end if;
end $$;

alter table genio_one_access_groups
  add constraint genio_one_access_groups_organization_access_group_key
  unique (tenant_id, organization_id, access_group_id);

alter table genio_one_team_workspaces
  add constraint genio_one_team_workspaces_reader_access_group_fkey
  foreign key (tenant_id, organization_id, reader_access_group_id)
  references genio_one_access_groups (tenant_id, organization_id, access_group_id);

alter table genio_one_team_workspaces
  add constraint genio_one_team_workspaces_contributor_access_group_fkey
  foreign key (tenant_id, organization_id, contributor_access_group_id)
  references genio_one_access_groups (tenant_id, organization_id, access_group_id);

alter table genio_one_team_workspaces
  add constraint genio_one_team_workspaces_maintainer_access_group_fkey
  foreign key (tenant_id, organization_id, maintainer_access_group_id)
  references genio_one_access_groups (tenant_id, organization_id, access_group_id);
