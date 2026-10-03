CREATE TABLE genio_one_shared_memories (
    tenant_id text NOT NULL,
    memory_id text NOT NULL,
    scope text NOT NULL,
    scope_target_key text NOT NULL,
    owner_subject_id text,
    team_id text,
    organization_id text,
    memory_key text NOT NULL,
    kind text NOT NULL,
    context_kind text NOT NULL,
    context_id text,
    context_key text NOT NULL,
    content text NOT NULL,
    assertion_origin text NOT NULL,
    source_actor_subject_id text NOT NULL,
    source_client_id text NOT NULL,
    source_agent_id text,
    source_agent_grant_id text,
    source_reference_id text,
    revision bigint NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT genio_one_shared_memories_pkey PRIMARY KEY (tenant_id, memory_id),
    CONSTRAINT genio_one_shared_memories_scope_check CHECK (((scope = 'PERSONAL') AND (owner_subject_id IS NOT NULL) AND (team_id IS NULL) AND (organization_id IS NULL)) OR ((scope = 'TEAM') AND (owner_subject_id IS NULL) AND (team_id IS NOT NULL) AND (organization_id IS NOT NULL)) OR ((scope = 'ORGANIZATION') AND (owner_subject_id IS NULL) AND (team_id IS NULL) AND (organization_id IS NOT NULL))),
    CONSTRAINT genio_one_shared_memories_kind_check CHECK (kind = ANY (ARRAY['preference'::text, 'fact'::text, 'decision'::text])),
    CONSTRAINT genio_one_shared_memories_context_check CHECK (((context_kind = 'GLOBAL') AND (context_id IS NULL)) OR ((context_kind = ANY (ARRAY['PROJECT'::text, 'CONTEXT'::text])) AND (context_id IS NOT NULL))),
    CONSTRAINT genio_one_shared_memories_assertion_origin_check CHECK (assertion_origin = ANY (ARRAY['USER_EXPLICIT'::text, 'AGENT_INFERRED'::text])),
    CONSTRAINT genio_one_shared_memories_content_check CHECK ((length(content) <= 12000) AND (length(TRIM(BOTH FROM content)) > 0)),
    CONSTRAINT genio_one_shared_memories_key_check CHECK (length(TRIM(BOTH FROM memory_key)) > 0),
    CONSTRAINT genio_one_shared_memories_revision_check CHECK (revision > 0),
    CONSTRAINT genio_one_shared_memories_timestamps_check CHECK ((created_at >= 0) AND (updated_at >= created_at)),
    CONSTRAINT genio_one_shared_memories_identity_key UNIQUE (tenant_id, scope_target_key, memory_key, kind, context_key)
);

CREATE INDEX genio_one_shared_memories_scope_page_idx
    ON genio_one_shared_memories (tenant_id, scope_target_key, updated_at DESC, memory_id ASC);

CREATE TABLE genio_one_shared_memory_mutations (
    tenant_id text NOT NULL,
    mutation_id text NOT NULL,
    scope_target_key text NOT NULL,
    memory_id text NOT NULL,
    scope text NOT NULL,
    owner_subject_id text,
    actor_subject_id text NOT NULL,
    client_id text NOT NULL,
    agent_id text,
    agent_grant_id text,
    operation text NOT NULL,
    previous_revision bigint NOT NULL,
    revision bigint NOT NULL,
    assertion_origin text NOT NULL,
    occurred_at bigint NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    CONSTRAINT genio_one_shared_memory_mutations_pkey PRIMARY KEY (tenant_id, mutation_id),
    CONSTRAINT genio_one_shared_memory_mutations_operation_check CHECK (operation = ANY (ARRAY['CREATED'::text, 'REPLACED'::text, 'DELETED'::text])),
    CONSTRAINT genio_one_shared_memory_mutations_scope_check CHECK (((scope = 'PERSONAL') AND (owner_subject_id IS NOT NULL)) OR ((scope = ANY (ARRAY['TEAM'::text, 'ORGANIZATION'::text])) AND (owner_subject_id IS NULL))),
    CONSTRAINT genio_one_shared_memory_mutations_assertion_origin_check CHECK (assertion_origin = ANY (ARRAY['USER_EXPLICIT'::text, 'AGENT_INFERRED'::text])),
    CONSTRAINT genio_one_shared_memory_mutations_revision_check CHECK ((previous_revision >= 0) AND (revision > 0)),
    CONSTRAINT genio_one_shared_memory_mutations_occurred_at_check CHECK (occurred_at >= 0),
    CONSTRAINT genio_one_shared_memory_mutations_idempotency_key_check CHECK (length(TRIM(BOTH FROM idempotency_key)) > 0),
    CONSTRAINT genio_one_shared_memory_mutations_request_digest_check CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    CONSTRAINT genio_one_shared_memory_mutations_idempotency_unique UNIQUE (tenant_id, scope_target_key, idempotency_key)
);

CREATE INDEX genio_one_shared_memory_mutations_memory_idx
    ON genio_one_shared_memory_mutations (tenant_id, memory_id, occurred_at DESC);

CREATE TABLE genio_one_personal_memory_agent_grants (
    tenant_id text NOT NULL,
    owner_subject_id text NOT NULL,
    agent_id text NOT NULL,
    grant_id text NOT NULL,
    enabled_at bigint NOT NULL,
    revoked_at bigint,
    CONSTRAINT genio_one_personal_memory_agent_grants_pkey PRIMARY KEY (tenant_id, owner_subject_id, agent_id),
    CONSTRAINT genio_one_personal_memory_agent_grants_grant_unique UNIQUE (tenant_id, grant_id),
    CONSTRAINT genio_one_personal_memory_agent_grants_timestamps_check CHECK ((enabled_at >= 0) AND ((revoked_at IS NULL) OR (revoked_at >= enabled_at)))
);

CREATE INDEX genio_one_personal_memory_agent_grants_active_idx
    ON genio_one_personal_memory_agent_grants (tenant_id, owner_subject_id, agent_id)
    WHERE revoked_at IS NULL;
