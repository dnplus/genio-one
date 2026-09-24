create index genio_one_knowledge_candidates_owner_page_idx
  on genio_one_knowledge_candidates (tenant_id, owner_subject_id, created_at desc, knowledge_id asc);

create index genio_one_distillation_markers_owner_page_idx
  on genio_one_distillation_markers (tenant_id, owner_subject_id, created_at desc, marker_id asc);
