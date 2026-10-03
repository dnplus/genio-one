lock table genio_one_shared_memories, genio_one_shared_memory_mutations,
  genio_one_team_workspaces, genio_one_organizations in share row exclusive mode;

do $$
declare
  mismatch_count bigint;
begin
  select count(*)
    into mismatch_count
    from genio_one_shared_memories as memory
    left join genio_one_organizations as organization
      on organization.tenant_id = memory.tenant_id
      and organization.organization_id = memory.organization_id
    left join genio_one_team_workspaces as workspace
      on workspace.tenant_id = memory.tenant_id
      and workspace.organization_id = memory.organization_id
      and workspace.workspace_id = memory.team_id
   where ((memory.scope in ('TEAM', 'ORGANIZATION') and organization.organization_id is null)
       or (memory.scope = 'TEAM' and workspace.workspace_id is null)
       or (memory.scope_target_key::jsonb is distinct from jsonb_build_array(
         memory.scope,
         memory.owner_subject_id,
         memory.team_id,
         memory.organization_id
       )));
  if mismatch_count > 0 then
    raise exception 'Cannot add Shared Memory governance constraints: % mismatched shared memory targets exist', mismatch_count;
  end if;
end $$;

alter table genio_one_team_workspaces
  add constraint genio_one_team_workspaces_org_workspace_key
  unique (tenant_id, organization_id, workspace_id);

alter table genio_one_shared_memories
  add constraint genio_one_shared_memories_target_key_check
  check (scope_target_key::jsonb = jsonb_build_array(scope, owner_subject_id, team_id, organization_id)),
  add constraint genio_one_shared_memories_organization_fkey
  foreign key (tenant_id, organization_id)
  references genio_one_organizations (tenant_id, organization_id),
  add constraint genio_one_shared_memories_team_workspace_fkey
  foreign key (tenant_id, organization_id, team_id)
  references genio_one_team_workspaces (tenant_id, organization_id, workspace_id),
  add constraint genio_one_shared_memories_memory_target_key
  unique (tenant_id, memory_id, scope_target_key);

alter table genio_one_shared_memory_mutations
  add column team_id text,
  add column organization_id text;

update genio_one_shared_memory_mutations as mutation
   set team_id = memory.team_id,
       organization_id = memory.organization_id
  from genio_one_shared_memories as memory
 where memory.tenant_id = mutation.tenant_id
   and memory.memory_id = mutation.memory_id;

do $$
declare
  mutation_row record;
  target jsonb;
  target_scope text;
  target_owner_subject_id text;
  target_team_id text;
  target_organization_id text;
  mismatch_count bigint;
begin
  mismatch_count := 0;
  for mutation_row in
    select mutation_record.tenant_id,
           mutation_record.mutation_id,
           mutation_record.scope_target_key,
           mutation_record.scope,
           mutation_record.owner_subject_id,
           mutation_record.team_id,
           mutation_record.organization_id,
           memory.scope_target_key as memory_scope_target_key
      from genio_one_shared_memory_mutations as mutation_record
      left join genio_one_shared_memories as memory
        on memory.tenant_id = mutation_record.tenant_id
        and memory.memory_id = mutation_record.memory_id
  loop
    begin
      target := mutation_row.scope_target_key::jsonb;
    exception when others then
      raise exception 'Cannot preserve Shared Memory mutation target metadata: malformed scope target key for tenant %, mutation %', mutation_row.tenant_id, mutation_row.mutation_id;
    end;
    if length(trim(mutation_row.tenant_id)) = 0
      or length(mutation_row.tenant_id) > 256 then
      mismatch_count := mismatch_count + 1;
      continue;
    end if;
    if jsonb_typeof(target) <> 'array' then
      mismatch_count := mismatch_count + 1;
      continue;
    end if;
    if jsonb_array_length(target) <> 4 then
      mismatch_count := mismatch_count + 1;
      continue;
    end if;
    target_scope := target ->> 0;
    target_owner_subject_id := target ->> 1;
    target_team_id := target ->> 2;
    target_organization_id := target ->> 3;
    if target_scope is distinct from mutation_row.scope
      or (mutation_row.memory_scope_target_key is not null
        and mutation_row.memory_scope_target_key is distinct from mutation_row.scope_target_key) then
      mismatch_count := mismatch_count + 1;
      continue;
    end if;
    if mutation_row.scope = 'PERSONAL' then
      if jsonb_typeof(target -> 0) <> 'string'
        or jsonb_typeof(target -> 1) <> 'string'
        or jsonb_typeof(target -> 2) <> 'null'
        or jsonb_typeof(target -> 3) <> 'null'
        or length(trim(target_owner_subject_id)) = 0
        or length(target_owner_subject_id) > 256
        or target_owner_subject_id is distinct from mutation_row.owner_subject_id
        or mutation_row.team_id is not null
        or mutation_row.organization_id is not null then
        mismatch_count := mismatch_count + 1;
      end if;
    elsif mutation_row.scope = 'TEAM' then
      if jsonb_typeof(target -> 0) <> 'string'
        or jsonb_typeof(target -> 1) <> 'null'
        or jsonb_typeof(target -> 2) <> 'string'
        or jsonb_typeof(target -> 3) <> 'string'
        or length(trim(target_team_id)) = 0
        or length(target_team_id) > 256
        or length(trim(target_organization_id)) = 0
        or length(target_organization_id) > 256
        or mutation_row.owner_subject_id is not null
        or (mutation_row.team_id is not null and mutation_row.team_id is distinct from target_team_id)
        or (mutation_row.organization_id is not null and mutation_row.organization_id is distinct from target_organization_id) then
        mismatch_count := mismatch_count + 1;
      end if;
    elsif mutation_row.scope = 'ORGANIZATION' then
      if jsonb_typeof(target -> 0) <> 'string'
        or jsonb_typeof(target -> 1) <> 'null'
        or jsonb_typeof(target -> 2) <> 'null'
        or jsonb_typeof(target -> 3) <> 'string'
        or length(trim(target_organization_id)) = 0
        or length(target_organization_id) > 256
        or mutation_row.owner_subject_id is not null
        or mutation_row.team_id is not null
        or (mutation_row.organization_id is not null and mutation_row.organization_id is distinct from target_organization_id) then
        mismatch_count := mismatch_count + 1;
      end if;
    else
      mismatch_count := mismatch_count + 1;
    end if;
  end loop;
  if mismatch_count > 0 then
    raise exception 'Cannot preserve Shared Memory mutation target metadata: % mismatched mutations exist', mismatch_count;
  end if;
end $$;

update genio_one_shared_memory_mutations as mutation
   set team_id = case when mutation.scope = 'TEAM' then mutation.scope_target_key::jsonb ->> 2 else null end,
       organization_id = mutation.scope_target_key::jsonb ->> 3
 where (mutation.scope = 'TEAM' and (mutation.team_id is null or mutation.organization_id is null))
    or (mutation.scope = 'ORGANIZATION' and mutation.organization_id is null);

alter table genio_one_shared_memory_mutations
  drop constraint genio_one_shared_memory_mutations_scope_check;

alter table genio_one_shared_memory_mutations
  add constraint genio_one_shared_memory_mutations_scope_check
  check (((scope = 'PERSONAL') and (owner_subject_id is not null) and (team_id is null) and (organization_id is null))
    or ((scope = 'TEAM') and (owner_subject_id is null) and (team_id is not null) and (organization_id is not null))
    or ((scope = 'ORGANIZATION') and (owner_subject_id is null) and (team_id is null) and (organization_id is not null))),
  add constraint genio_one_shared_memory_mutations_target_key_check
  check (scope_target_key::jsonb = jsonb_build_array(scope, owner_subject_id, team_id, organization_id));

create table genio_one_shared_memory_correction_proposals (
  tenant_id text not null,
  proposal_id text not null,
  memory_id text not null,
  scope_target_key text not null,
  scope text not null,
  owner_subject_id text,
  team_id text,
  organization_id text,
  base_revision bigint not null,
  proposed_kind text not null,
  proposed_content text,
  source_actor_subject_id text not null,
  source_client_id text not null,
  source_agent_id text,
  source_agent_grant_id text,
  source_reference_id text,
  idempotency_key_digest text not null,
  request_digest text not null,
  status text not null,
  reviewer_subject_id text,
  created_at bigint not null,
  resolved_at bigint,
  constraint genio_one_memory_correction_proposals_pkey primary key (tenant_id, proposal_id),
  constraint genio_one_memory_correction_proposals_memory_target_fkey
    foreign key (tenant_id, memory_id, scope_target_key)
    references genio_one_shared_memories (tenant_id, memory_id, scope_target_key)
    on delete cascade,
  constraint genio_one_memory_correction_proposals_scope_check
    check (((scope = 'PERSONAL') and (owner_subject_id is not null) and (team_id is null) and (organization_id is null))
      or ((scope = 'TEAM') and (owner_subject_id is null) and (team_id is not null) and (organization_id is not null))
      or ((scope = 'ORGANIZATION') and (owner_subject_id is null) and (team_id is null) and (organization_id is not null))),
  constraint genio_one_memory_correction_proposals_target_key_check
    check (scope_target_key::jsonb = jsonb_build_array(scope, owner_subject_id, team_id, organization_id)),
  constraint genio_one_memory_correction_proposals_base_revision_check
    check (base_revision > 0),
  constraint genio_one_memory_correction_proposals_proposed_kind_check
    check (proposed_kind = any (array['preference'::text, 'fact'::text, 'decision'::text])),
  constraint genio_one_memory_correction_proposals_proposed_content_check
    check (proposed_content is null or (length(proposed_content) <= 12000 and length(trim(both from proposed_content)) > 0)),
  constraint genio_one_memory_correction_proposals_source_agent_grant_check
    check ((source_agent_id is null and source_agent_grant_id is null)
      or (source_agent_id is not null and source_agent_grant_id is not null)),
  constraint genio_one_memory_correction_proposals_idempotency_digest_check
    check (idempotency_key_digest ~ '^[a-f0-9]{64}$'),
  constraint genio_one_memory_correction_proposals_request_digest_check
    check (request_digest ~ '^[a-f0-9]{64}$'),
  constraint genio_one_memory_correction_proposals_status_check
    check (status = any (array['PENDING'::text, 'ACCEPTED'::text, 'REJECTED'::text, 'STALE'::text])),
  constraint genio_one_memory_correction_proposals_resolution_check
    check ((status = 'PENDING'
      and proposed_content is not null
      and reviewer_subject_id is null
      and resolved_at is null)
      or (status in ('ACCEPTED', 'REJECTED')
        and proposed_content is null
        and reviewer_subject_id is not null
        and resolved_at is not null
        and resolved_at >= created_at)
      or (status = 'STALE'
        and proposed_content is null
        and resolved_at is not null
        and resolved_at >= created_at)),
  constraint genio_one_memory_correction_proposals_created_at_check
    check (created_at >= 0),
  constraint genio_one_memory_correction_proposals_idempotency_digest_unique
    unique (tenant_id, scope_target_key, idempotency_key_digest)
);

create index genio_one_memory_correction_proposals_memory_idx
  on genio_one_shared_memory_correction_proposals (tenant_id, memory_id, created_at desc, proposal_id asc);
