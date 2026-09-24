create index genio_one_knowledge_candidates_workspace_page_idx
  on genio_one_knowledge_candidates (tenant_id, workspace_id, created_at desc, knowledge_id asc)
  where workspace_id is not null;
