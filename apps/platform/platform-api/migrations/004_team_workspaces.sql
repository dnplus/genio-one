create table genio_one_team_workspaces (
  tenant_id text not null,
  workspace_id text not null,
  organization_id text not null,
  display_name text not null,
  reader_access_group_id text not null,
  contributor_access_group_id text not null,
  maintainer_access_group_id text not null,
  created_at bigint not null,
  created_by text not null,
  constraint genio_one_team_workspaces_pkey primary key (tenant_id, workspace_id),
  constraint genio_one_team_workspaces_name_unique unique (tenant_id, display_name),
  constraint genio_one_team_workspaces_organization_fkey foreign key (tenant_id, organization_id)
    references genio_one_organizations (tenant_id, organization_id),
  constraint genio_one_team_workspaces_roles_distinct check (
    reader_access_group_id <> contributor_access_group_id
    and reader_access_group_id <> maintainer_access_group_id
    and contributor_access_group_id <> maintainer_access_group_id
  ),
  constraint genio_one_team_workspaces_name_check check (length(btrim(display_name)) > 0)
);

update genio_one_distillation_markers as marker
  set workspace_id = null
  where marker.workspace_id is not null
    and not exists (
      select 1 from genio_one_team_workspaces as workspace
      where workspace.tenant_id = marker.tenant_id
        and workspace.workspace_id = marker.workspace_id
    );

update genio_one_knowledge_candidates as candidate
  set workspace_id = null
  where candidate.workspace_id is not null
    and not exists (
      select 1 from genio_one_team_workspaces as workspace
      where workspace.tenant_id = candidate.tenant_id
        and workspace.workspace_id = candidate.workspace_id
    );
