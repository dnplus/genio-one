lock table genio_one_distillation_markers, genio_one_knowledge_candidates, genio_one_team_workspaces
  in share row exclusive mode;

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

alter table genio_one_distillation_markers
  add constraint genio_one_distillation_markers_workspace_fkey
  foreign key (tenant_id, workspace_id)
  references genio_one_team_workspaces (tenant_id, workspace_id);

alter table genio_one_knowledge_candidates
  add constraint genio_one_knowledge_candidates_workspace_fkey
  foreign key (tenant_id, workspace_id)
  references genio_one_team_workspaces (tenant_id, workspace_id);
