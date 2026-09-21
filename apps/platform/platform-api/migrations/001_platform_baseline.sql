SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE FUNCTION genio_one_guard_installation_owned_resource() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION genio_one_reject_authorization_audit_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'GENIO_ONE_AUTHORIZATION_AUDIT_APPEND_ONLY';
end;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE genio_one_access_group_revisions (
    tenant_id text NOT NULL,
    access_group_id text NOT NULL,
    revision bigint NOT NULL,
    value jsonb NOT NULL,
    CONSTRAINT genio_one_access_group_revisions_check CHECK (((((value ->> 'tenant_id'::text) = tenant_id) AND ((value ->> 'access_group_id'::text) = access_group_id) AND (((value ->> 'revision'::text))::bigint = revision)) IS TRUE)),
    CONSTRAINT genio_one_access_group_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT genio_one_access_group_revisions_value_check CHECK ((jsonb_typeof(value) = 'object'::text))
);

CREATE TABLE genio_one_access_groups (
    tenant_id text NOT NULL,
    access_group_id text NOT NULL,
    revision bigint NOT NULL,
    value jsonb NOT NULL,
    CONSTRAINT genio_one_access_groups_check CHECK (((((value ->> 'tenant_id'::text) = tenant_id) AND ((value ->> 'access_group_id'::text) = access_group_id) AND (((value ->> 'revision'::text))::bigint = revision)) IS TRUE)),
    CONSTRAINT genio_one_access_groups_revision_check CHECK ((revision > 0)),
    CONSTRAINT genio_one_access_groups_value_check CHECK ((jsonb_typeof(value) = 'object'::text))
);

CREATE TABLE genio_one_access_requests (
    tenant_id text NOT NULL,
    access_request_id text NOT NULL,
    requester_subject_id text NOT NULL,
    target_subject_id text NOT NULL,
    acting_client_id text,
    resource_id text NOT NULL,
    capability_id text NOT NULL,
    owner_organization_id text NOT NULL,
    justification text NOT NULL,
    requested_valid_for integer NOT NULL,
    configuration_revision text,
    approval_workflow_version text,
    state text DEFAULT 'PENDING'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    resolved_at timestamp with time zone,
    resolution_reason text,
    decided_by_subject_id text,
    entitlement_id text,
    CONSTRAINT genio_one_access_requests_justification_check CHECK ((length(TRIM(BOTH FROM justification)) > 0)),
    CONSTRAINT genio_one_access_requests_requested_valid_for_check CHECK ((requested_valid_for > 0)),
    CONSTRAINT genio_one_access_requests_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'DENIED'::text, 'CANCELLED'::text, 'EXPIRED'::text])))
);

CREATE TABLE genio_one_activity_outcome_attributions (
    tenant_id text NOT NULL,
    attribution_id text NOT NULL,
    correlation_id text NOT NULL,
    source text NOT NULL,
    outcome_reference text CONSTRAINT genio_one_activity_outcome_attributi_outcome_reference_not_null NOT NULL,
    value text NOT NULL,
    observed_at bigint NOT NULL,
    recorded_by_subject_id text CONSTRAINT genio_one_activity_outcome_attr_recorded_by_subject_id_not_null NOT NULL,
    recorded_at bigint NOT NULL,
    CONSTRAINT genio_one_activity_outcome_attributions_observed_at_check CHECK ((observed_at >= 0)),
    CONSTRAINT genio_one_activity_outcome_attributions_recorded_at_check CHECK ((recorded_at >= 0))
);

CREATE TABLE genio_one_agent_delegation_revisions (
    tenant_id text NOT NULL,
    delegation_id text NOT NULL,
    revision integer NOT NULL,
    principal_subject_id text CONSTRAINT genio_one_agent_delegation_revisi_principal_subject_id_not_null NOT NULL,
    agent_subject_id text NOT NULL,
    resource_id text NOT NULL,
    capability_ids text[] NOT NULL,
    acting_client_ids text[] NOT NULL,
    starts_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revocation_generation integer CONSTRAINT genio_one_agent_delegation_revis_revocation_generation_not_null NOT NULL,
    state text NOT NULL,
    created_by_subject_id text CONSTRAINT genio_one_agent_delegation_revis_created_by_subject_id_not_null NOT NULL,
    created_at bigint NOT NULL,
    CONSTRAINT genio_one_agent_delegation_revision_revocation_generation_check CHECK ((revocation_generation >= 0)),
    CONSTRAINT genio_one_agent_delegation_revisions_acting_client_ids_check CHECK ((cardinality(acting_client_ids) > 0)),
    CONSTRAINT genio_one_agent_delegation_revisions_capability_ids_check CHECK ((cardinality(capability_ids) > 0)),
    CONSTRAINT genio_one_agent_delegation_revisions_check CHECK ((principal_subject_id <> agent_subject_id)),
    CONSTRAINT genio_one_agent_delegation_revisions_check1 CHECK ((expires_at > starts_at)),
    CONSTRAINT genio_one_agent_delegation_revisions_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text])))
);

CREATE TABLE genio_one_application_api_credentials (
    tenant_id text NOT NULL,
    credential_id text NOT NULL,
    application_id text NOT NULL,
    application_subject_id text CONSTRAINT genio_one_application_api_crede_application_subject_id_not_null NOT NULL,
    resource_id text NOT NULL,
    capability_id text NOT NULL,
    generation integer NOT NULL,
    kind text NOT NULL,
    oauth_client_id text NOT NULL,
    oauth_issuer text NOT NULL,
    oauth_audience text NOT NULL,
    oauth_scope text NOT NULL,
    identity_provider_id text,
    external_subject_id text,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    valid_until timestamp with time zone,
    revoked_at timestamp with time zone,
    predecessor_credential_id text,
    operation_correlation_id text,
    CONSTRAINT genio_one_application_api_credentials_generation_check CHECK ((generation > 0)),
    CONSTRAINT genio_one_application_api_credentials_kind_check CHECK ((kind = 'OAUTH2'::text)),
    CONSTRAINT genio_one_application_api_credentials_oauth_audience_check CHECK ((length(TRIM(BOTH FROM oauth_audience)) > 0)),
    CONSTRAINT genio_one_application_api_credentials_oauth_client_id_check CHECK ((length(TRIM(BOTH FROM oauth_client_id)) > 0)),
    CONSTRAINT genio_one_application_api_credentials_oauth_issuer_check CHECK ((length(TRIM(BOTH FROM oauth_issuer)) > 0)),
    CONSTRAINT genio_one_application_api_credentials_oauth_scope_check CHECK ((length(TRIM(BOTH FROM oauth_scope)) > 0)),
    CONSTRAINT genio_one_application_api_credentials_state_check CHECK ((state = ANY (ARRAY['PROVISIONING'::text, 'ACTIVE'::text, 'RETIRED'::text, 'REVOKED'::text])))
);

CREATE TABLE genio_one_applications (
    tenant_id text NOT NULL,
    application_id text NOT NULL,
    subject_id text NOT NULL,
    display_name text NOT NULL,
    owner_organization_id text NOT NULL,
    registered_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_applications_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0))
);

CREATE TABLE genio_one_bot_policy_revisions (
    tenant_id text NOT NULL,
    policy_id text NOT NULL,
    policy_revision integer NOT NULL,
    rules jsonb NOT NULL,
    published_by text,
    published_at bigint NOT NULL
);

CREATE TABLE genio_one_canonical_charges (
    tenant_id text NOT NULL,
    charge_id text NOT NULL,
    invocation_id text NOT NULL,
    correlation_id text NOT NULL,
    accounting_key_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE genio_one_canonical_invocation_accounting (
    tenant_id text NOT NULL,
    invocation_id text CONSTRAINT genio_one_canonical_invocation_accountin_invocation_id_not_null NOT NULL,
    correlation_id text CONSTRAINT genio_one_canonical_invocation_accounti_correlation_id_not_null NOT NULL,
    subject_id text NOT NULL,
    consumer_organization_id text CONSTRAINT genio_one_canonical_invocatio_consumer_organization_id_not_null NOT NULL,
    resource_owner_organization_id text CONSTRAINT genio_one_canonical_invocat_resource_owner_organizatio_not_null NOT NULL,
    resource_id text NOT NULL,
    capability_id text CONSTRAINT genio_one_canonical_invocation_accountin_capability_id_not_null NOT NULL,
    use_case_id text NOT NULL,
    usage_policy_revisions jsonb CONSTRAINT genio_one_canonical_invocation__usage_policy_revisions_not_null NOT NULL,
    release_revision text CONSTRAINT genio_one_canonical_invocation_accoun_release_revision_not_null NOT NULL,
    accounting_key_id text CONSTRAINT genio_one_canonical_invocation_accou_accounting_key_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_canonical_invocation_acc_usage_policy_revisions_check CHECK ((jsonb_typeof(usage_policy_revisions) = 'array'::text))
);

CREATE TABLE genio_one_connection_model_mappings (
    tenant_id text NOT NULL,
    mapping_id text NOT NULL,
    public_model_id text NOT NULL,
    resource_id text NOT NULL,
    connection_id text NOT NULL,
    provider_model text NOT NULL,
    mapping_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_connection_model_mappings_mapping_revision_check CHECK ((mapping_revision > 0)),
    CONSTRAINT genio_one_connection_model_mappings_provider_model_check CHECK ((length(TRIM(BOTH FROM provider_model)) > 0))
);

CREATE TABLE genio_one_cost_valuations (
    tenant_id text NOT NULL,
    valuation_id text NOT NULL,
    charge_id text NOT NULL,
    status text NOT NULL,
    currency text NOT NULL,
    amount_micros bigint NOT NULL,
    pricing_source text NOT NULL,
    pricing_version text NOT NULL,
    valued_at timestamp with time zone NOT NULL,
    CONSTRAINT genio_one_cost_valuations_amount_micros_check CHECK ((amount_micros >= 0)),
    CONSTRAINT genio_one_cost_valuations_currency_check CHECK ((length(currency) = 3)),
    CONSTRAINT genio_one_cost_valuations_status_check CHECK ((status = ANY (ARRAY['ESTIMATED'::text, 'ACTUAL'::text])))
);

CREATE TABLE genio_one_demo_installations (
    tenant_id text NOT NULL,
    organization_id text,
    installation text NOT NULL,
    resource_ids text[] DEFAULT '{}'::text[] NOT NULL,
    item_errors text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_demo_installations_check CHECK ((((installation = 'SKIPPED'::text) AND (organization_id IS NULL)) OR (installation = 'INSTALLED'::text))),
    CONSTRAINT genio_one_demo_installations_installation_check CHECK ((installation = ANY (ARRAY['SKIPPED'::text, 'INSTALLED'::text])))
);

CREATE TABLE genio_one_endpoint_activities (
    tenant_id text NOT NULL,
    activity_id text NOT NULL,
    correlation_id text NOT NULL,
    kind text NOT NULL,
    subject_id text NOT NULL,
    device_id text NOT NULL,
    destination_host text NOT NULL,
    resource_id text NOT NULL,
    resource_class text NOT NULL,
    client_status text NOT NULL,
    acting_client_id text,
    route text NOT NULL,
    routing_policy_rule_id text,
    applied_state_revision text NOT NULL,
    applied_policy_version text NOT NULL,
    request_count bigint NOT NULL,
    bytes_sent bigint NOT NULL,
    bytes_received bigint NOT NULL,
    observed_at bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_endpoint_activities_bytes_received_check CHECK ((bytes_received >= 0)),
    CONSTRAINT genio_one_endpoint_activities_bytes_sent_check CHECK ((bytes_sent >= 0)),
    CONSTRAINT genio_one_endpoint_activities_check CHECK ((((client_status = 'UNKNOWN'::text) AND (acting_client_id IS NULL)) OR ((client_status = 'VERIFIED'::text) AND (length(TRIM(BOTH FROM acting_client_id)) > 0)))),
    CONSTRAINT genio_one_endpoint_activities_client_status_check CHECK ((client_status = ANY (ARRAY['UNKNOWN'::text, 'VERIFIED'::text]))),
    CONSTRAINT genio_one_endpoint_activities_kind_check CHECK ((kind = ANY (ARRAY['DISCOVERY'::text, 'USAGE'::text]))),
    CONSTRAINT genio_one_endpoint_activities_observed_at_check CHECK ((observed_at >= 0)),
    CONSTRAINT genio_one_endpoint_activities_request_count_check CHECK ((request_count > 0)),
    CONSTRAINT genio_one_endpoint_activities_resource_class_check CHECK ((resource_class = ANY (ARRAY['KNOWN'::text, 'UNCLASSIFIED'::text]))),
    CONSTRAINT genio_one_endpoint_activities_route_check CHECK ((route = ANY (ARRAY['DIRECT'::text, 'MANAGED'::text, 'BLOCK'::text])))
);

CREATE TABLE genio_one_endpoint_credentials (
    credential_id text NOT NULL,
    tenant_id text NOT NULL,
    device_id text NOT NULL,
    subject_id text NOT NULL,
    kind text NOT NULL,
    token_hash text NOT NULL,
    expires_at bigint NOT NULL,
    consumed_at bigint,
    revoked_at bigint,
    correlation_id text,
    CONSTRAINT genio_one_endpoint_credentials_check CHECK (((kind = 'BOOTSTRAP'::text) OR (consumed_at IS NULL))),
    CONSTRAINT genio_one_endpoint_credentials_expires_at_check CHECK ((expires_at >= 0)),
    CONSTRAINT genio_one_endpoint_credentials_kind_check CHECK ((kind = ANY (ARRAY['BOOTSTRAP'::text, 'RUNTIME'::text])))
);

CREATE TABLE genio_one_endpoint_devices (
    tenant_id text NOT NULL,
    device_id text NOT NULL,
    subject_id text NOT NULL,
    lifecycle_state text NOT NULL,
    enrolled_at bigint NOT NULL,
    last_seen_at bigint NOT NULL,
    endpoint_version text NOT NULL,
    applied_state_revision text,
    applied_policy_version text,
    health text NOT NULL,
    reported_at bigint NOT NULL,
    revocation_reason text,
    CONSTRAINT genio_one_endpoint_devices_check CHECK (((applied_state_revision IS NULL) = (applied_policy_version IS NULL))),
    CONSTRAINT genio_one_endpoint_devices_check1 CHECK ((last_seen_at >= enrolled_at)),
    CONSTRAINT genio_one_endpoint_devices_check2 CHECK ((reported_at >= enrolled_at)),
    CONSTRAINT genio_one_endpoint_devices_check3 CHECK ((((lifecycle_state = 'ACTIVE'::text) AND (revocation_reason IS NULL)) OR ((lifecycle_state = 'REVOKED'::text) AND (length(TRIM(BOTH FROM revocation_reason)) > 0)))),
    CONSTRAINT genio_one_endpoint_devices_enrolled_at_check CHECK ((enrolled_at >= 0)),
    CONSTRAINT genio_one_endpoint_devices_health_check CHECK ((health = ANY (ARRAY['UNKNOWN'::text, 'HEALTHY'::text, 'DEGRADED'::text]))),
    CONSTRAINT genio_one_endpoint_devices_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text])))
);

CREATE TABLE genio_one_endpoint_lifecycle_events (
    event_id bigint NOT NULL,
    tenant_id text NOT NULL,
    device_id text NOT NULL,
    subject_id text NOT NULL,
    correlation_id text NOT NULL,
    kind text NOT NULL,
    reason text,
    at bigint NOT NULL,
    CONSTRAINT genio_one_endpoint_lifecycle_events_at_check CHECK ((at >= 0)),
    CONSTRAINT genio_one_endpoint_lifecycle_events_check CHECK ((((kind = 'ENROLLED'::text) AND (reason IS NULL)) OR ((kind = 'REVOKED'::text) AND (length(TRIM(BOTH FROM reason)) > 0)))),
    CONSTRAINT genio_one_endpoint_lifecycle_events_kind_check CHECK ((kind = ANY (ARRAY['ENROLLED'::text, 'REVOKED'::text])))
);

ALTER TABLE genio_one_endpoint_lifecycle_events ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME genio_one_endpoint_lifecycle_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE genio_one_enforcement_chain_revisions (
    tenant_id text NOT NULL,
    resource_id text NOT NULL,
    capability_id text NOT NULL,
    one_policy_revision bigint CONSTRAINT genio_one_enforcement_chain_revisi_one_policy_revision_not_null NOT NULL,
    eligible_connection_ids jsonb CONSTRAINT genio_one_enforcement_chain_re_eligible_connection_ids_not_null NOT NULL,
    chain jsonb NOT NULL,
    chain_digest text NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_by_subject_id text,
    reviewed_by_subject_id text,
    rollback_source_one_policy_revision bigint,
    CONSTRAINT genio_one_enforcement_chain_revi_eligible_connection_ids_check1 CHECK ((jsonb_array_length(eligible_connection_ids) > 0)),
    CONSTRAINT genio_one_enforcement_chain_revis_eligible_connection_ids_check CHECK ((jsonb_typeof(eligible_connection_ids) = 'array'::text)),
    CONSTRAINT genio_one_enforcement_chain_revisions_chain_check CHECK ((jsonb_typeof(chain) = 'object'::text)),
    CONSTRAINT genio_one_enforcement_chain_revisions_chain_digest_check CHECK ((length(TRIM(BOTH FROM chain_digest)) > 0)),
    CONSTRAINT genio_one_enforcement_chain_revisions_one_policy_revision_check CHECK ((one_policy_revision > 0)),
    CONSTRAINT genio_one_enforcement_chain_revisions_rollback_source_check CHECK (((rollback_source_one_policy_revision IS NULL) OR (rollback_source_one_policy_revision > 0))),
    CONSTRAINT genio_one_enforcement_chain_revisions_row_revision_check CHECK ((row_revision > 0))
);

CREATE TABLE genio_one_execution_grant_request_revisions (
    tenant_id text NOT NULL,
    request_id text NOT NULL,
    revision integer NOT NULL,
    subject_id text NOT NULL,
    acting_client_id text CONSTRAINT genio_one_execution_grant_request_rev_acting_client_id_not_null NOT NULL,
    resource_id text CONSTRAINT genio_one_execution_grant_request_revision_resource_id_not_null NOT NULL,
    capability_id text CONSTRAINT genio_one_execution_grant_request_revisi_capability_id_not_null NOT NULL,
    action_digest text CONSTRAINT genio_one_execution_grant_request_revisi_action_digest_not_null NOT NULL,
    requested_expires_at bigint CONSTRAINT genio_one_execution_grant_request_requested_expires_at_not_null NOT NULL,
    state text NOT NULL,
    created_by_subject_id text CONSTRAINT genio_one_execution_grant_reques_created_by_subject_id_not_null NOT NULL,
    created_at bigint NOT NULL,
    decided_by_subject_id text,
    decided_at bigint,
    decision_reason text,
    execution_grant_id text,
    CONSTRAINT genio_one_execution_grant_request_revisions_action_digest_check CHECK ((action_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_execution_grant_request_revisions_check CHECK ((requested_expires_at > created_at)),
    CONSTRAINT genio_one_execution_grant_request_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT genio_one_execution_grant_request_revisions_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'DENIED'::text])))
);

CREATE TABLE genio_one_execution_grants (
    tenant_id text NOT NULL,
    execution_grant_id text NOT NULL,
    request_id text NOT NULL,
    subject_id text NOT NULL,
    acting_client_id text NOT NULL,
    resource_id text NOT NULL,
    capability_id text NOT NULL,
    action_digest text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    issued_by_subject_id text NOT NULL,
    CONSTRAINT genio_one_execution_grants_action_digest_check CHECK ((action_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_execution_grants_check CHECK ((expires_at > issued_at))
);

CREATE TABLE genio_one_external_identity_bindings (
    tenant_id text NOT NULL,
    provider_id text NOT NULL,
    external_subject_id text CONSTRAINT genio_one_external_identity_bindin_external_subject_id_not_null NOT NULL,
    subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_external_identity_bindings_external_subject_id_check CHECK ((length(TRIM(BOTH FROM external_subject_id)) > 0)),
    CONSTRAINT genio_one_external_identity_bindings_provider_id_check CHECK ((length(TRIM(BOTH FROM provider_id)) > 0))
);

CREATE TABLE genio_one_federation_assertion_uses (
    tenant_id text NOT NULL,
    trust_id text NOT NULL,
    trust_revision bigint NOT NULL,
    assertion_jti_sha256 text CONSTRAINT genio_one_federation_assertion_us_assertion_jti_sha256_not_null NOT NULL,
    correlation_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_federation_assertion_uses_assertion_jti_sha256_check CHECK ((assertion_jti_sha256 ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE genio_one_federation_exchange_events (
    tenant_id text NOT NULL,
    exchange_id text NOT NULL,
    correlation_id text NOT NULL,
    trust_id text NOT NULL,
    trust_revision bigint NOT NULL,
    external_issuer text NOT NULL,
    external_subject_id text,
    application_id text NOT NULL,
    application_subject_id text CONSTRAINT genio_one_federation_exchange_e_application_subject_id_not_null NOT NULL,
    credential_id text,
    credential_generation bigint,
    resource_id text NOT NULL,
    capability_id text NOT NULL,
    audience text NOT NULL,
    scope text NOT NULL,
    outcome text NOT NULL,
    rejection_reason text,
    upstream_attempted boolean DEFAULT false CONSTRAINT genio_one_federation_exchange_event_upstream_attempted_not_null NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_federation_exchange_events_check CHECK ((((outcome = 'ISSUED'::text) AND (rejection_reason IS NULL) AND (credential_id IS NOT NULL) AND (credential_generation IS NOT NULL)) OR ((outcome = 'REJECTED'::text) AND (rejection_reason IS NOT NULL)))),
    CONSTRAINT genio_one_federation_exchange_events_outcome_check CHECK ((outcome = ANY (ARRAY['ISSUED'::text, 'REJECTED'::text]))),
    CONSTRAINT genio_one_federation_exchange_events_upstream_attempted_check CHECK ((upstream_attempted = false))
);

CREATE TABLE genio_one_federation_trust_heads (
    tenant_id text NOT NULL,
    trust_id text NOT NULL,
    application_id text NOT NULL,
    current_revision bigint NOT NULL,
    state text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_federation_trust_heads_current_revision_check CHECK ((current_revision > 0)),
    CONSTRAINT genio_one_federation_trust_heads_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text])))
);

CREATE TABLE genio_one_federation_trust_revisions (
    tenant_id text NOT NULL,
    trust_id text NOT NULL,
    revision bigint NOT NULL,
    application_id text NOT NULL,
    application_subject_id text CONSTRAINT genio_one_federation_trust_revi_application_subject_id_not_null NOT NULL,
    display_name text NOT NULL,
    issuer text NOT NULL,
    jwks_uri text NOT NULL,
    audiences text[] NOT NULL,
    algorithms text[] NOT NULL,
    external_subject_id text CONSTRAINT genio_one_federation_trust_revisio_external_subject_id_not_null NOT NULL,
    required_claims jsonb DEFAULT '[]'::jsonb NOT NULL,
    max_assertion_ttl_seconds integer CONSTRAINT genio_one_federation_trust_r_max_assertion_ttl_seconds_not_null NOT NULL,
    created_by_subject_id text CONSTRAINT genio_one_federation_trust_revis_created_by_subject_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_federation_trust_revi_max_assertion_ttl_seconds_check CHECK (((max_assertion_ttl_seconds >= 1) AND (max_assertion_ttl_seconds <= 3600))),
    CONSTRAINT genio_one_federation_trust_revisions_algorithms_check CHECK ((cardinality(algorithms) > 0)),
    CONSTRAINT genio_one_federation_trust_revisions_audiences_check CHECK ((cardinality(audiences) > 0)),
    CONSTRAINT genio_one_federation_trust_revisions_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_federation_trust_revisions_required_claims_check CHECK ((jsonb_typeof(required_claims) = 'array'::text)),
    CONSTRAINT genio_one_federation_trust_revisions_revision_check CHECK ((revision > 0))
);

CREATE TABLE genio_one_first_party_policy_seeds (
    tenant_id text NOT NULL,
    policy_id text NOT NULL,
    policy_revision integer DEFAULT 1 NOT NULL,
    seed boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rules jsonb DEFAULT '{"allowed_roles": ["TENANT_ADMINISTRATOR"], "allowed_subject_ids": []}'::jsonb NOT NULL,
    CONSTRAINT genio_one_first_party_policy_seeds_policy_id_check CHECK ((policy_id = 'one-policy.first-party.bot-default'::text)),
    CONSTRAINT genio_one_first_party_policy_seeds_positive_revision CHECK ((policy_revision >= 1)),
    CONSTRAINT genio_one_first_party_policy_seeds_seed_check CHECK (seed)
);

CREATE TABLE genio_one_gateway_activities (
    tenant_id text NOT NULL,
    correlation_id text NOT NULL,
    resource_id text NOT NULL,
    capability_id text,
    application_id text,
    subject_id text,
    acting_client_id text,
    entitlement_id text,
    enforcement_point_id text NOT NULL,
    route text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    status_code integer NOT NULL,
    outcome text NOT NULL,
    error_code text,
    latency_millis bigint,
    upstream_attempted boolean NOT NULL,
    detail_availability text NOT NULL,
    detail_ref text,
    detail_expires_at bigint,
    occurred_at bigint NOT NULL,
    requested_model_id text,
    effective_model_id text,
    provider_id text,
    connection_id text,
    input_tokens bigint,
    output_tokens bigint,
    total_tokens bigint,
    cost_estimation_status text DEFAULT 'NOT_APPLICABLE'::text NOT NULL,
    estimated_cost_currency text,
    estimated_cost_micros bigint,
    pricing_source text,
    pricing_version text,
    route_mode text,
    route_lease_id text,
    route_lease_reused boolean,
    routing_policy_id text,
    routing_revision bigint,
    candidate_set_digest text,
    mcp_method text,
    mcp_tool text,
    mcp_backend text,
    downstream_identity_mode text,
    processor_bundle_revision text,
    processor_request_steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    processor_response_steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    candidate_connection_ids text[] DEFAULT '{}'::text[] NOT NULL,
    release_id text,
    release_head_revision bigint,
    usage_admission_id text,
    usage_admission_disposition text DEFAULT 'NOT_APPLICABLE'::text CONSTRAINT genio_one_gateway_activitie_usage_admission_dispositio_not_null NOT NULL,
    usage_admission_reason text,
    consumer_organization_id text,
    resource_owner_organization_id text,
    use_case_id text,
    provider_credential_profile_id text,
    provider_credential_profile_revision bigint,
    provider_credential_strategy_digest text,
    data_classifications jsonb DEFAULT '[]'::jsonb NOT NULL,
    session_id text,
    CONSTRAINT genio_one_gateway_activities_data_classifications_check CHECK ((jsonb_typeof(data_classifications) = 'array'::text)),
    CONSTRAINT genio_one_gateway_activities_detail_availability_check CHECK ((detail_availability = ANY (ARRAY['AVAILABLE'::text, 'EXPIRED'::text, 'NOT_CAPTURED'::text]))),
    CONSTRAINT genio_one_gateway_activities_downstream_identity_mode_check CHECK (((downstream_identity_mode IS NULL) OR (downstream_identity_mode = ANY (ARRAY['NONE'::text, 'SERVICE'::text, 'USER_PASSTHROUGH'::text, 'USER_OAUTH'::text])))),
    CONSTRAINT genio_one_gateway_activities_estimated_cost_check CHECK (((cost_estimation_status = ANY (ARRAY['ESTIMATED'::text, 'UNPRICED'::text, 'NOT_APPLICABLE'::text])) AND ((estimated_cost_micros IS NULL) OR (estimated_cost_micros >= 0)) AND (((cost_estimation_status = 'ESTIMATED'::text) AND (estimated_cost_currency IS NOT NULL) AND (estimated_cost_micros IS NOT NULL) AND (pricing_source IS NOT NULL) AND (pricing_version IS NOT NULL)) OR ((cost_estimation_status <> 'ESTIMATED'::text) AND (estimated_cost_currency IS NULL) AND (estimated_cost_micros IS NULL))))),
    CONSTRAINT genio_one_gateway_activities_latency_millis_check CHECK (((latency_millis IS NULL) OR (latency_millis >= 0))),
    CONSTRAINT genio_one_gateway_activities_occurred_at_check CHECK ((occurred_at >= 0)),
    CONSTRAINT genio_one_gateway_activities_outcome_check CHECK ((outcome = ANY (ARRAY['COMPLETED'::text, 'RATE_LIMITED'::text, 'UNAUTHENTICATED'::text, 'DENIED'::text, 'BLOCKED'::text, 'FAILED'::text]))),
    CONSTRAINT genio_one_gateway_activities_processor_steps_check CHECK (((jsonb_typeof(processor_request_steps) = 'array'::text) AND (jsonb_typeof(processor_response_steps) = 'array'::text))),
    CONSTRAINT genio_one_gateway_activities_route_check CHECK ((route = 'MANAGED'::text)),
    CONSTRAINT genio_one_gateway_activities_routing_evidence_check CHECK ((((route_mode IS NULL) OR (route_mode = ANY (ARRAY['DETERMINISTIC'::text, 'SESSION_LEASE'::text]))) AND ((routing_revision IS NULL) OR (routing_revision >= 1)) AND ((candidate_set_digest IS NULL) OR (candidate_set_digest ~ '^[a-f0-9]{64}$'::text)) AND ((route_mode <> 'SESSION_LEASE'::text) OR ((route_lease_id IS NOT NULL) AND (route_lease_reused IS NOT NULL) AND (routing_policy_id IS NOT NULL) AND (routing_revision IS NOT NULL) AND (candidate_set_digest IS NOT NULL))))),
    CONSTRAINT genio_one_gateway_activities_status_code_check CHECK (((status_code >= 100) AND (status_code <= 599))),
    CONSTRAINT genio_one_gateway_activities_usage_admission_disposition_check CHECK ((usage_admission_disposition = ANY (ARRAY['ADMIT'::text, 'REJECT'::text, 'NOT_APPLICABLE'::text]))),
    CONSTRAINT genio_one_gateway_activities_usage_admission_reason_check CHECK (((usage_admission_reason IS NULL) OR (usage_admission_reason = ANY (ARRAY['QUOTA_EXHAUSTED'::text, 'CONCURRENCY_EXHAUSTED'::text, 'CREDIT_EXHAUSTED'::text, 'COST_BUDGET_EXHAUSTED'::text, 'UNPRICED_USAGE'::text, 'STORE_UNAVAILABLE'::text])))),
    CONSTRAINT genio_one_gateway_activities_usage_facts_check CHECK ((((input_tokens IS NULL) OR (input_tokens >= 0)) AND ((output_tokens IS NULL) OR (output_tokens >= 0)) AND ((total_tokens IS NULL) OR (total_tokens >= 0)))),
    CONSTRAINT genio_one_gateway_activity_provider_credential_binding_check CHECK ((((provider_credential_profile_id IS NULL) AND (provider_credential_profile_revision IS NULL) AND (provider_credential_strategy_digest IS NULL)) OR ((length(TRIM(BOTH FROM provider_credential_profile_id)) > 0) AND (provider_credential_profile_revision > 0) AND (provider_credential_strategy_digest ~ '^[a-f0-9]{64}$'::text))))
);

CREATE TABLE genio_one_gateway_authorization_audit_events (
    tenant_id text NOT NULL,
    audit_event_id text CONSTRAINT genio_one_gateway_authorization_audit_e_audit_event_id_not_null NOT NULL,
    correlation_id text CONSTRAINT genio_one_gateway_authorization_audit_e_correlation_id_not_null NOT NULL,
    occurred_at bigint CONSTRAINT genio_one_gateway_authorization_audit_even_occurred_at_not_null NOT NULL,
    event jsonb NOT NULL,
    CONSTRAINT genio_one_gateway_authorization_audit_events_object_check CHECK ((jsonb_typeof(event) = 'object'::text)),
    CONSTRAINT genio_one_gateway_authorization_audit_events_occurred_at_check CHECK ((occurred_at >= 0))
);

CREATE TABLE genio_one_gateway_diagnostic_settings (
    tenant_id text NOT NULL,
    gateway_id text NOT NULL,
    capture_message_content boolean DEFAULT false CONSTRAINT genio_one_gateway_diagnostic_s_capture_message_content_not_null NOT NULL,
    updated_by_subject_id text CONSTRAINT genio_one_gateway_diagnostic_set_updated_by_subject_id_not_null NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_gateway_diagnostic_settings_row_revision_check CHECK ((row_revision > 0))
);

CREATE TABLE genio_one_gateway_policy_release_heads (
    tenant_id text NOT NULL,
    gateway_id text NOT NULL,
    release_id text NOT NULL,
    content_digest text NOT NULL,
    head_revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_gateway_policy_release_heads_content_digest_check CHECK ((content_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_release_heads_head_revision_check CHECK ((head_revision > 0))
);

CREATE TABLE genio_one_gateway_policy_release_manifests (
    tenant_id text NOT NULL,
    release_id text NOT NULL,
    runtime_id text NOT NULL,
    gateway_id text NOT NULL,
    manifest jsonb NOT NULL,
    manifest_jws bytea CONSTRAINT genio_one_gateway_policy_release_manifest_manifest_jws_not_null NOT NULL,
    manifest_sha256 text CONSTRAINT genio_one_gateway_policy_release_manif_manifest_sha256_not_null NOT NULL,
    manifest_key_id text CONSTRAINT genio_one_gateway_policy_release_manif_manifest_key_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_gateway_policy_release_manifest_manifest_key_id_check CHECK ((length(TRIM(BOTH FROM manifest_key_id)) > 0)),
    CONSTRAINT genio_one_gateway_policy_release_manifest_manifest_sha256_check CHECK ((manifest_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_release_manifests_manifest_check CHECK ((jsonb_typeof(manifest) = 'object'::text)),
    CONSTRAINT genio_one_gateway_policy_release_manifests_manifest_jws_check CHECK ((octet_length(manifest_jws) > 0)),
    CONSTRAINT genio_one_gateway_policy_release_manifests_runtime_id_check CHECK ((length(TRIM(BOTH FROM runtime_id)) > 0))
);

CREATE TABLE genio_one_gateway_policy_release_projections (
    tenant_id text NOT NULL,
    release_id text CONSTRAINT genio_one_gateway_policy_release_projection_release_id_not_null NOT NULL,
    publication_id text CONSTRAINT genio_one_gateway_policy_release_projec_publication_id_not_null NOT NULL,
    projection_id text CONSTRAINT genio_one_gateway_policy_release_project_projection_id_not_null NOT NULL,
    projection_revision bigint CONSTRAINT genio_one_gateway_policy_release_p_projection_revision_not_null NOT NULL,
    projection_digest text CONSTRAINT genio_one_gateway_policy_release_pro_projection_digest_not_null NOT NULL,
    CONSTRAINT genio_one_gateway_policy_release_proj_projection_revision_check CHECK ((projection_revision > 0)),
    CONSTRAINT genio_one_gateway_policy_release_projec_projection_digest_check CHECK ((projection_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_release_projectio_publication_id_check CHECK ((length(TRIM(BOTH FROM publication_id)) > 0)),
    CONSTRAINT genio_one_gateway_policy_release_projection_projection_id_check CHECK ((length(TRIM(BOTH FROM projection_id)) > 0))
);

CREATE TABLE genio_one_gateway_policy_releases (
    tenant_id text NOT NULL,
    release_id text NOT NULL,
    gateway_id text NOT NULL,
    policy_artifact_revision text CONSTRAINT genio_one_gateway_policy_rele_policy_artifact_revision_not_null NOT NULL,
    policy_version text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    content_digest text NOT NULL,
    projection_set_digest text CONSTRAINT genio_one_gateway_policy_release_projection_set_digest_not_null NOT NULL,
    authorization_bundle bytea NOT NULL,
    authorization_sha256 text NOT NULL,
    authorization_key_id text NOT NULL,
    processor_policy bytea NOT NULL,
    processor_sha256 text NOT NULL,
    processor_key_id text NOT NULL,
    enforcement_verification_keys bytea CONSTRAINT genio_one_gateway_policy_re_enforcement_verification_k_not_null NOT NULL,
    enforcement_verification_keys_sha256 text CONSTRAINT genio_one_gateway_policy_r_enforcement_verification_k_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    gateway_routing_artifact bytea CONSTRAINT genio_one_gateway_policy_rele_gateway_routing_artifact_not_null NOT NULL,
    gateway_routing_artifact_sha256 text CONSTRAINT genio_one_gateway_policy_re_gateway_routing_artifact_s_not_null NOT NULL,
    gateway_routing_artifact_key_id text CONSTRAINT genio_one_gateway_policy_re_gateway_routing_artifact_k_not_null NOT NULL,
    CONSTRAINT genio_one_gateway_policy_rel_enforcement_verification_ke_check1 CHECK ((enforcement_verification_keys_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_rel_enforcement_verification_key_check CHECK ((octet_length(enforcement_verification_keys) > 0)),
    CONSTRAINT genio_one_gateway_policy_release_policy_artifact_revision_check CHECK ((length(TRIM(BOTH FROM policy_artifact_revision)) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_authorization_bundle_check CHECK ((octet_length(authorization_bundle) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_authorization_key_id_check CHECK ((length(TRIM(BOTH FROM authorization_key_id)) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_authorization_sha256_check CHECK ((authorization_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_releases_check CHECK ((expires_at > issued_at)),
    CONSTRAINT genio_one_gateway_policy_releases_content_digest_check CHECK ((content_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_releases_gateway_id_check CHECK ((length(TRIM(BOTH FROM gateway_id)) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_policy_version_check CHECK ((length(TRIM(BOTH FROM policy_version)) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_processor_key_id_check CHECK ((length(TRIM(BOTH FROM processor_key_id)) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_processor_policy_check CHECK ((octet_length(processor_policy) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_processor_sha256_check CHECK ((processor_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_releases_projection_set_digest_check CHECK ((projection_set_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_releases_release_id_check CHECK ((length(TRIM(BOTH FROM release_id)) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_routing_artifact_key_id_check CHECK ((length(TRIM(BOTH FROM gateway_routing_artifact_key_id)) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_routing_artifact_nonempty_che CHECK ((octet_length(gateway_routing_artifact) > 0)),
    CONSTRAINT genio_one_gateway_policy_releases_routing_artifact_sha256_check CHECK ((gateway_routing_artifact_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_gateway_policy_releases_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0))
);

CREATE TABLE genio_one_gateway_projections (
    tenant_id text NOT NULL,
    projection_id text NOT NULL,
    resource_id text NOT NULL,
    capability_id text NOT NULL,
    revision bigint NOT NULL,
    resource_revision bigint NOT NULL,
    policy_revision bigint NOT NULL,
    digest text NOT NULL,
    signature jsonb NOT NULL,
    payload jsonb NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    publication_id text NOT NULL,
    endpoint_revision bigint NOT NULL,
    CONSTRAINT genio_one_gateway_projections_digest_check CHECK ((length(TRIM(BOTH FROM digest)) > 0)),
    CONSTRAINT genio_one_gateway_projections_endpoint_revision_check CHECK ((endpoint_revision > 0)),
    CONSTRAINT genio_one_gateway_projections_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT genio_one_gateway_projections_policy_revision_check CHECK ((policy_revision > 0)),
    CONSTRAINT genio_one_gateway_projections_resource_revision_check CHECK ((resource_revision > 0)),
    CONSTRAINT genio_one_gateway_projections_revision_check CHECK ((revision > 0)),
    CONSTRAINT genio_one_gateway_projections_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_gateway_projections_signature_check CHECK ((jsonb_typeof(signature) = 'object'::text))
);

CREATE TABLE genio_one_gateway_registrations (
    tenant_id text NOT NULL,
    runtime_id text NOT NULL,
    display_name text NOT NULL,
    gateway_id text NOT NULL,
    site_id text NOT NULL,
    region text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    identity_client_id text NOT NULL,
    state text NOT NULL,
    registered_by_subject_id text CONSTRAINT genio_one_gateway_registratio_registered_by_subject_id_not_null NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    retired_at timestamp with time zone,
    row_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT genio_one_gateway_registrations_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_gateway_registrations_gateway_id_check CHECK ((length(TRIM(BOTH FROM gateway_id)) > 0)),
    CONSTRAINT genio_one_gateway_registrations_labels_check CHECK ((jsonb_typeof(labels) = 'object'::text)),
    CONSTRAINT genio_one_gateway_registrations_region_check CHECK ((length(TRIM(BOTH FROM region)) > 0)),
    CONSTRAINT genio_one_gateway_registrations_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_gateway_registrations_site_id_check CHECK ((length(TRIM(BOTH FROM site_id)) > 0)),
    CONSTRAINT genio_one_gateway_registrations_state_check CHECK ((state = ANY (ARRAY['PROVISIONING'::text, 'ACTIVE'::text, 'RETIRED'::text])))
);

CREATE TABLE genio_one_mcp_discovery_operations (
    tenant_id text NOT NULL,
    operation_id text NOT NULL,
    gateway_id text NOT NULL,
    resource_id text NOT NULL,
    connection_id text NOT NULL,
    requested_by_subject_id text CONSTRAINT genio_one_mcp_discovery_operat_requested_by_subject_id_not_null NOT NULL,
    correlation_id text NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    runtime_id text,
    endpoint text NOT NULL,
    credential_ref text,
    downstream_identity jsonb NOT NULL,
    observation jsonb,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    candidates jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT genio_one_mcp_discovery_candidates_array CHECK ((jsonb_typeof(candidates) = 'array'::text)),
    CONSTRAINT genio_one_mcp_discovery_operations_check CHECK ((((state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text])) AND (observation IS NULL) AND (completed_at IS NULL)) OR ((state = 'SUCCEEDED'::text) AND (observation IS NOT NULL) AND (error_code IS NULL) AND (error_message IS NULL) AND (completed_at IS NOT NULL)) OR ((state = 'FAILED'::text) AND (observation IS NULL) AND (error_code IS NOT NULL) AND (error_message IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT genio_one_mcp_discovery_operations_downstream_identity_check CHECK ((jsonb_typeof(downstream_identity) = 'object'::text)),
    CONSTRAINT genio_one_mcp_discovery_operations_endpoint_check CHECK ((length(TRIM(BOTH FROM endpoint)) > 0)),
    CONSTRAINT genio_one_mcp_discovery_operations_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'SUCCEEDED'::text, 'FAILED'::text])))
);

CREATE TABLE genio_one_mcp_oauth_bindings (
    tenant_id text NOT NULL,
    resource_id text NOT NULL,
    connection_id text NOT NULL,
    subject_id text NOT NULL,
    issuer text NOT NULL,
    resource_url text NOT NULL,
    sealed_state text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE genio_one_mcp_oauth_sessions (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    state_hash text NOT NULL,
    resource_id text NOT NULL,
    connection_id text NOT NULL,
    subject_id text NOT NULL,
    return_url text NOT NULL,
    sealed_state text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE genio_one_model_entitlements (
    tenant_id text NOT NULL,
    entitlement_id text NOT NULL,
    subject_id text,
    client_id text,
    public_model_id text,
    state text DEFAULT 'ACTIVE'::text NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resource_id text NOT NULL,
    capability_id text NOT NULL,
    revocation_reason text,
    revoked_at timestamp with time zone,
    revoked_by_subject_id text,
    revocation_correlation_id text,
    grant_idempotency_key text,
    grant_request_digest text,
    CONSTRAINT genio_one_model_entitlements_check CHECK (((subject_id IS NOT NULL) OR (client_id IS NOT NULL))),
    CONSTRAINT genio_one_model_entitlements_check1 CHECK (((expires_at IS NULL) OR (expires_at > starts_at))),
    CONSTRAINT genio_one_model_entitlements_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_model_entitlements_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text])))
);

CREATE TABLE genio_one_model_price_catalog (
    source text NOT NULL,
    source_version text NOT NULL,
    provider_id text NOT NULL,
    catalog_model_key text NOT NULL,
    provider_model_id text NOT NULL,
    input_cost_per_token numeric(30,18) NOT NULL,
    output_cost_per_token numeric(30,18) NOT NULL,
    fetched_at bigint NOT NULL,
    CONSTRAINT genio_one_model_price_catalog_fetched_at_check CHECK ((fetched_at >= 0)),
    CONSTRAINT genio_one_model_price_catalog_input_cost_per_token_check CHECK ((input_cost_per_token >= (0)::numeric)),
    CONSTRAINT genio_one_model_price_catalog_output_cost_per_token_check CHECK ((output_cost_per_token >= (0)::numeric))
);

CREATE TABLE genio_one_model_route_transitions (
    tenant_id text NOT NULL,
    transition_id text NOT NULL,
    subject_id text NOT NULL,
    client_id text NOT NULL,
    public_model_id text NOT NULL,
    session_id text NOT NULL,
    from_model_id text,
    to_model_id text NOT NULL,
    from_connection_id text,
    to_connection_id text NOT NULL,
    reason text NOT NULL,
    lease_revision bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    resource_id text NOT NULL,
    from_mapping_id text,
    to_mapping_id text NOT NULL,
    from_provider_model text,
    to_provider_model text NOT NULL,
    from_mapping_revision bigint,
    to_mapping_revision bigint NOT NULL,
    CONSTRAINT genio_one_model_route_transitions_client_id_check CHECK ((length(TRIM(BOTH FROM client_id)) > 0)),
    CONSTRAINT genio_one_model_route_transitions_lease_revision_check CHECK (((lease_revision IS NULL) OR (lease_revision > 0))),
    CONSTRAINT genio_one_model_route_transitions_public_model_id_check CHECK ((length(TRIM(BOTH FROM public_model_id)) > 0)),
    CONSTRAINT genio_one_model_route_transitions_reason_check CHECK ((length(TRIM(BOTH FROM reason)) > 0)),
    CONSTRAINT genio_one_model_route_transitions_session_id_check CHECK ((length(TRIM(BOTH FROM session_id)) > 0)),
    CONSTRAINT genio_one_model_route_transitions_subject_id_check CHECK ((length(TRIM(BOTH FROM subject_id)) > 0)),
    CONSTRAINT genio_one_model_route_transitions_to_connection_id_check CHECK ((length(TRIM(BOTH FROM to_connection_id)) > 0)),
    CONSTRAINT genio_one_model_route_transitions_to_model_id_check CHECK ((length(TRIM(BOTH FROM to_model_id)) > 0)),
    CONSTRAINT genio_one_route_transition_mapping_revision_check CHECK (((to_mapping_revision > 0) AND ((from_mapping_revision IS NULL) OR (from_mapping_revision > 0))))
);

CREATE TABLE genio_one_model_routing_policies (
    tenant_id text NOT NULL,
    routing_policy_id text NOT NULL,
    owner_organization_id text NOT NULL,
    resource_id text NOT NULL,
    capability_id text NOT NULL,
    routing_revision bigint NOT NULL,
    mode text NOT NULL,
    default_public_model_id text CONSTRAINT genio_one_model_routing_polici_default_public_model_id_not_null NOT NULL,
    candidate_public_model_ids jsonb CONSTRAINT genio_one_model_routing_pol_candidate_public_model_ids_not_null NOT NULL,
    session_lease_seconds bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context_requirements jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT genio_one_model_routing_context_requirements_check CHECK ((jsonb_typeof(context_requirements) = 'array'::text)),
    CONSTRAINT genio_one_model_routing_polic_candidate_public_model_ids_check1 CHECK ((candidate_public_model_ids <> '[]'::jsonb)),
    CONSTRAINT genio_one_model_routing_polici_candidate_public_model_ids_check CHECK ((jsonb_typeof(candidate_public_model_ids) = 'array'::text)),
    CONSTRAINT genio_one_model_routing_policies_capability_id_check CHECK ((length(TRIM(BOTH FROM capability_id)) > 0)),
    CONSTRAINT genio_one_model_routing_policies_check CHECK ((((mode = 'DETERMINISTIC'::text) AND (session_lease_seconds IS NULL)) OR ((mode = 'SESSION_LEASE'::text) AND ((session_lease_seconds >= 1) AND (session_lease_seconds <= 86400))))),
    CONSTRAINT genio_one_model_routing_policies_default_public_model_id_check CHECK ((length(TRIM(BOTH FROM default_public_model_id)) > 0)),
    CONSTRAINT genio_one_model_routing_policies_mode_check CHECK ((mode = ANY (ARRAY['DETERMINISTIC'::text, 'SESSION_LEASE'::text]))),
    CONSTRAINT genio_one_model_routing_policies_owner_organization_id_check CHECK ((length(TRIM(BOTH FROM owner_organization_id)) > 0)),
    CONSTRAINT genio_one_model_routing_policies_resource_id_check CHECK ((length(TRIM(BOTH FROM resource_id)) > 0)),
    CONSTRAINT genio_one_model_routing_policies_routing_policy_id_check CHECK ((length(TRIM(BOTH FROM routing_policy_id)) > 0)),
    CONSTRAINT genio_one_model_routing_policies_routing_revision_check CHECK ((routing_revision > 0)),
    CONSTRAINT genio_one_model_routing_policies_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0))
);

CREATE TABLE genio_one_mutation_idempotency_receipts (
    tenant_id text NOT NULL,
    idempotency_key text CONSTRAINT genio_one_mutation_idempotency_receipt_idempotency_key_not_null NOT NULL,
    operation text NOT NULL,
    request_digest text NOT NULL,
    response_status integer CONSTRAINT genio_one_mutation_idempotency_receipt_response_status_not_null NOT NULL,
    response_digest text CONSTRAINT genio_one_mutation_idempotency_receipt_response_digest_not_null NOT NULL,
    response_payload jsonb CONSTRAINT genio_one_mutation_idempotency_receip_response_payload_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_mutation_idempotency_receipts_idempotency_key_check CHECK ((length(TRIM(BOTH FROM idempotency_key)) > 0)),
    CONSTRAINT genio_one_mutation_idempotency_receipts_operation_check CHECK ((length(TRIM(BOTH FROM operation)) > 0)),
    CONSTRAINT genio_one_mutation_idempotency_receipts_request_digest_check CHECK ((length(TRIM(BOTH FROM request_digest)) > 0)),
    CONSTRAINT genio_one_mutation_idempotency_receipts_response_digest_check CHECK ((length(TRIM(BOTH FROM response_digest)) > 0)),
    CONSTRAINT genio_one_mutation_idempotency_receipts_response_payload_check CHECK ((jsonb_typeof(response_payload) = 'object'::text)),
    CONSTRAINT genio_one_mutation_idempotency_receipts_response_status_check CHECK (((response_status >= 200) AND (response_status <= 599)))
);

CREATE TABLE genio_one_notification_subscriptions (
    tenant_id text NOT NULL,
    subscription_id text NOT NULL,
    subject_id text NOT NULL,
    notification_type text NOT NULL,
    channel text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by_subject_id text CONSTRAINT genio_one_notification_subscript_created_by_subject_id_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_notification_subscriptions_channel_check CHECK ((channel = 'IN_APP'::text)),
    CONSTRAINT genio_one_notification_subscriptions_notification_type_check CHECK ((notification_type = ANY (ARRAY['ACCESS_REQUEST'::text, 'ENTITLEMENT_EXPIRING'::text, 'RUNAWAY_INVOCATION_SUSPENDED'::text, 'API_VERSION_LIFECYCLE'::text, 'ALL'::text])))
);

CREATE TABLE genio_one_organization_membership_sources (
    tenant_id text NOT NULL,
    organization_id text CONSTRAINT genio_one_organization_membership_sour_organization_id_not_null NOT NULL,
    kind text NOT NULL,
    reference text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_organization_membership_sources_kind_check CHECK ((kind = ANY (ARRAY['MANUAL'::text, 'SCIM_GROUP'::text, 'OIDC_GROUP'::text]))),
    CONSTRAINT genio_one_organization_membership_sources_reference_check CHECK ((length(TRIM(BOTH FROM reference)) > 0)),
    CONSTRAINT genio_one_organization_membership_sources_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'SYNCED'::text, 'ERROR'::text])))
);

CREATE TABLE genio_one_organization_memberships (
    tenant_id text NOT NULL,
    organization_id text NOT NULL,
    subject_id text NOT NULL,
    role text DEFAULT 'USER'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_organization_memberships_role_check CHECK ((role = ANY (ARRAY['USER'::text, 'ORGANIZATION_ADMINISTRATOR'::text])))
);

CREATE TABLE genio_one_organizations (
    tenant_id text NOT NULL,
    organization_id text NOT NULL,
    display_name text NOT NULL,
    slug text NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_organizations_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_organizations_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_organizations_slug_check CHECK ((length(TRIM(BOTH FROM slug)) > 0))
);

CREATE TABLE genio_one_personal_password_credentials (
    tenant_id text NOT NULL,
    resource_id text NOT NULL,
    connection_id text NOT NULL,
    subject_id text NOT NULL,
    sealed_value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE genio_one_platform_runtime_aggregate_commands (
    tenant_id text CONSTRAINT genio_one_platform_runtime_aggregate_command_tenant_id_not_null NOT NULL,
    runtime_kind text DEFAULT 'GATEWAY'::text CONSTRAINT genio_one_platform_runtime_aggregate_comm_runtime_kind_not_null NOT NULL,
    runtime_id text CONSTRAINT genio_one_platform_runtime_aggregate_comman_runtime_id_not_null NOT NULL,
    command_id text CONSTRAINT genio_one_platform_runtime_aggregate_comman_command_id_not_null NOT NULL,
    release_id text CONSTRAINT genio_one_platform_runtime_aggregate_comman_release_id_not_null NOT NULL,
    gateway_id text CONSTRAINT genio_one_platform_runtime_aggregate_comman_gateway_id_not_null NOT NULL,
    head_revision bigint CONSTRAINT genio_one_platform_runtime_aggregate_com_head_revision_not_null NOT NULL,
    package_digest text CONSTRAINT genio_one_platform_runtime_aggregate_co_package_digest_not_null NOT NULL,
    projection_count bigint CONSTRAINT genio_one_platform_runtime_aggregate__projection_count_not_null NOT NULL,
    command jsonb NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    failure_code text,
    failure_message text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT genio_one_platform_runtime_aggregate_comman_created_at_not_null NOT NULL,
    delivered_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    failed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT genio_one_platform_runtime_aggregate_comman_updated_at_not_null NOT NULL,
    CONSTRAINT genio_one_platform_runtime_aggregate_com_projection_count_check CHECK ((projection_count >= 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_comm_failure_message_check CHECK (((failure_message IS NULL) OR (length(TRIM(BOTH FROM failure_message)) > 0))),
    CONSTRAINT genio_one_platform_runtime_aggregate_comma_package_digest_check CHECK ((package_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_platform_runtime_aggregate_comman_head_revision_check CHECK ((head_revision > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_command_failure_code_check CHECK (((failure_code IS NULL) OR (length(TRIM(BOTH FROM failure_code)) > 0))),
    CONSTRAINT genio_one_platform_runtime_aggregate_command_runtime_kind_check CHECK ((runtime_kind = 'GATEWAY'::text)),
    CONSTRAINT genio_one_platform_runtime_aggregate_commands_command_check CHECK ((jsonb_typeof(command) = 'object'::text)),
    CONSTRAINT genio_one_platform_runtime_aggregate_commands_command_id_check CHECK ((length(TRIM(BOTH FROM command_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_commands_gateway_id_check CHECK ((length(TRIM(BOTH FROM gateway_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_commands_release_id_check CHECK ((length(TRIM(BOTH FROM release_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_commands_runtime_id_check CHECK ((length(TRIM(BOTH FROM runtime_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_commands_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'ACKNOWLEDGED'::text, 'FAILED'::text]))),
    CONSTRAINT genio_one_platform_runtime_aggregate_commands_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0))
);

CREATE TABLE genio_one_platform_runtime_aggregate_observed_states (
    tenant_id text CONSTRAINT genio_one_platform_runtime_aggregate_observe_tenant_id_not_null NOT NULL,
    runtime_kind text DEFAULT 'GATEWAY'::text CONSTRAINT genio_one_platform_runtime_aggregate_obse_runtime_kind_not_null NOT NULL,
    runtime_id text CONSTRAINT genio_one_platform_runtime_aggregate_observ_runtime_id_not_null NOT NULL,
    command_id text CONSTRAINT genio_one_platform_runtime_aggregate_observ_command_id_not_null NOT NULL,
    report_id text CONSTRAINT genio_one_platform_runtime_aggregate_observe_report_id_not_null NOT NULL,
    revision text CONSTRAINT genio_one_platform_runtime_aggregate_observed_revision_not_null NOT NULL,
    digest text CONSTRAINT genio_one_platform_runtime_aggregate_observed_s_digest_not_null NOT NULL,
    applied_release jsonb,
    observed_status jsonb CONSTRAINT genio_one_platform_runtime_aggregate_o_observed_status_not_null NOT NULL,
    observed_at timestamp with time zone DEFAULT now() CONSTRAINT genio_one_platform_runtime_aggregate_obser_observed_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT genio_one_platform_runtime_aggregate_observ_updated_at_not_null NOT NULL,
    CONSTRAINT genio_one_platform_runtime_aggregate_obse_applied_release_check CHECK (((applied_release IS NULL) OR (jsonb_typeof(applied_release) = 'object'::text))),
    CONSTRAINT genio_one_platform_runtime_aggregate_obse_observed_status_check CHECK ((jsonb_typeof(observed_status) = 'object'::text)),
    CONSTRAINT genio_one_platform_runtime_aggregate_observe_runtime_kind_check CHECK ((runtime_kind = 'GATEWAY'::text)),
    CONSTRAINT genio_one_platform_runtime_aggregate_observed__command_id_check CHECK ((length(TRIM(BOTH FROM command_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_observed__runtime_id_check CHECK ((length(TRIM(BOTH FROM runtime_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_observed_s_report_id_check CHECK ((length(TRIM(BOTH FROM report_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_observed_s_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_observed_st_revision_check CHECK ((length(TRIM(BOTH FROM revision)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_observed_stat_digest_check CHECK ((digest ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE genio_one_platform_runtime_aggregate_report_history (
    tenant_id text CONSTRAINT genio_one_platform_runtime_aggregate_report__tenant_id_not_null NOT NULL,
    runtime_kind text DEFAULT 'GATEWAY'::text CONSTRAINT genio_one_platform_runtime_aggregate_repo_runtime_kind_not_null NOT NULL,
    runtime_id text CONSTRAINT genio_one_platform_runtime_aggregate_report_runtime_id_not_null NOT NULL,
    report_id text CONSTRAINT genio_one_platform_runtime_aggregate_report__report_id_not_null NOT NULL,
    command_id text CONSTRAINT genio_one_platform_runtime_aggregate_report_command_id_not_null NOT NULL,
    release_id text CONSTRAINT genio_one_platform_runtime_aggregate_report_release_id_not_null NOT NULL,
    package_digest text CONSTRAINT genio_one_platform_runtime_aggregate_re_package_digest_not_null NOT NULL,
    revision text CONSTRAINT genio_one_platform_runtime_aggregate_report_h_revision_not_null NOT NULL,
    digest text CONSTRAINT genio_one_platform_runtime_aggregate_report_his_digest_not_null NOT NULL,
    report jsonb CONSTRAINT genio_one_platform_runtime_aggregate_report_his_report_not_null NOT NULL,
    outcome text CONSTRAINT genio_one_platform_runtime_aggregate_report_hi_outcome_not_null NOT NULL,
    observed_at timestamp with time zone DEFAULT now() CONSTRAINT genio_one_platform_runtime_aggregate_repor_observed_at_not_null NOT NULL,
    CONSTRAINT genio_one_platform_runtime_aggregate_repor_package_digest_check CHECK ((package_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report__runtime_kind_check CHECK ((runtime_kind = 'GATEWAY'::text)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_hi_command_id_check CHECK ((length(TRIM(BOTH FROM command_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_hi_release_id_check CHECK ((length(TRIM(BOTH FROM release_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_hi_runtime_id_check CHECK ((length(TRIM(BOTH FROM runtime_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_his_report_id_check CHECK ((length(TRIM(BOTH FROM report_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_his_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_hist_revision_check CHECK ((length(TRIM(BOTH FROM revision)) > 0)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_histo_outcome_check CHECK ((outcome = ANY (ARRAY['ACCEPTED'::text, 'STALE'::text]))),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_histor_digest_check CHECK ((digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_platform_runtime_aggregate_report_histor_report_check CHECK ((jsonb_typeof(report) = 'object'::text))
);

CREATE TABLE genio_one_platform_runtime_capabilities (
    tenant_id text NOT NULL,
    runtime_kind text DEFAULT 'GATEWAY'::text NOT NULL,
    runtime_id text NOT NULL,
    protocol_versions jsonb CONSTRAINT genio_one_platform_runtime_capabilit_protocol_versions_not_null NOT NULL,
    preferred_protocol_version text CONSTRAINT genio_one_platform_runtime__preferred_protocol_version_not_null NOT NULL,
    delivery_mode text DEFAULT 'AGGREGATE_RELEASE'::text NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_platform_runtime_cap_preferred_protocol_version_check CHECK ((preferred_protocol_version = 'genio.one.runtime.v1'::text)),
    CONSTRAINT genio_one_platform_runtime_capabilitie_protocol_versions_check1 CHECK ((protocol_versions = '["genio.one.runtime.v1"]'::jsonb)),
    CONSTRAINT genio_one_platform_runtime_capabilities_delivery_mode_check CHECK ((delivery_mode = 'AGGREGATE_RELEASE'::text)),
    CONSTRAINT genio_one_platform_runtime_capabilities_protocol_versions_check CHECK ((jsonb_typeof(protocol_versions) = 'array'::text)),
    CONSTRAINT genio_one_platform_runtime_capabilities_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_platform_runtime_capabilities_runtime_id_check CHECK ((length(TRIM(BOTH FROM runtime_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_capabilities_runtime_kind_check CHECK ((runtime_kind = 'GATEWAY'::text)),
    CONSTRAINT genio_one_platform_runtime_capabilities_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0))
);

CREATE TABLE genio_one_platform_runtime_registrations (
    tenant_id text NOT NULL,
    runtime_kind text DEFAULT 'GATEWAY'::text NOT NULL,
    runtime_id text NOT NULL,
    target_id text NOT NULL,
    oidc_client_id text CONSTRAINT genio_one_platform_runtime_registration_oidc_client_id_not_null NOT NULL,
    report_key_id text NOT NULL,
    report_public_key_pem text CONSTRAINT genio_one_platform_runtime_regis_report_public_key_pem_not_null NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_platform_runtime_registra_report_public_key_pem_check CHECK ((length(TRIM(BOTH FROM report_public_key_pem)) > 0)),
    CONSTRAINT genio_one_platform_runtime_registrations_oidc_client_id_check CHECK ((length(TRIM(BOTH FROM oidc_client_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_registrations_report_key_id_check CHECK ((length(TRIM(BOTH FROM report_key_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_registrations_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_platform_runtime_registrations_runtime_id_check CHECK ((length(TRIM(BOTH FROM runtime_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_registrations_runtime_kind_check CHECK ((runtime_kind = 'GATEWAY'::text)),
    CONSTRAINT genio_one_platform_runtime_registrations_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text, 'REVOKED'::text]))),
    CONSTRAINT genio_one_platform_runtime_registrations_target_id_check CHECK ((length(TRIM(BOTH FROM target_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_registrations_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0))
);

CREATE TABLE genio_one_platform_runtime_session_leases (
    tenant_id text NOT NULL,
    runtime_kind text DEFAULT 'GATEWAY'::text NOT NULL,
    runtime_id text NOT NULL,
    lease_id text NOT NULL,
    owner_id text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    renewed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT genio_one_platform_runtime_session_leases_check CHECK ((expires_at > claimed_at)),
    CONSTRAINT genio_one_platform_runtime_session_leases_lease_id_check CHECK ((length(TRIM(BOTH FROM lease_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_session_leases_owner_id_check CHECK ((length(TRIM(BOTH FROM owner_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_session_leases_runtime_id_check CHECK ((length(TRIM(BOTH FROM runtime_id)) > 0)),
    CONSTRAINT genio_one_platform_runtime_session_leases_runtime_kind_check CHECK ((runtime_kind = 'GATEWAY'::text)),
    CONSTRAINT genio_one_platform_runtime_session_leases_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0))
);

CREATE TABLE genio_one_policy_authoring_settings (
    tenant_id text NOT NULL,
    require_distinct_reviewer boolean DEFAULT false CONSTRAINT genio_one_policy_authoring_s_require_distinct_reviewer_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT genio_one_policy_authoring_settings_revision_check CHECK ((revision > 0))
);

CREATE TABLE genio_one_policy_drafts (
    tenant_id text NOT NULL,
    policy_key text NOT NULL,
    value jsonb NOT NULL,
    last_version integer DEFAULT 1 NOT NULL
);

CREATE TABLE genio_one_policy_revisions (
    tenant_id text NOT NULL,
    policy_id text NOT NULL,
    revision bigint NOT NULL,
    display_name text NOT NULL,
    provenance text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    scope jsonb NOT NULL,
    rules jsonb NOT NULL,
    published_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_policy_revisions_provenance_check CHECK ((provenance = ANY (ARRAY['SYSTEM_SEED'::text, 'TENANT_AUTHORED'::text]))),
    CONSTRAINT genio_one_policy_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT genio_one_policy_revisions_rules_check CHECK ((jsonb_typeof(rules) = 'array'::text)),
    CONSTRAINT genio_one_policy_revisions_scope_check CHECK ((jsonb_typeof(scope) = 'object'::text))
);

CREATE TABLE genio_one_price_catalog_versions (
    source text NOT NULL,
    source_version text NOT NULL,
    source_url text NOT NULL,
    fetched_at bigint NOT NULL,
    status text NOT NULL,
    CONSTRAINT genio_one_price_catalog_versions_fetched_at_check CHECK ((fetched_at >= 0)),
    CONSTRAINT genio_one_price_catalog_versions_source_version_check CHECK ((source_version ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_price_catalog_versions_status_check CHECK ((status = ANY (ARRAY['CURRENT'::text, 'LKG'::text])))
);

CREATE TABLE genio_one_provider_credential_profile_revisions (
    tenant_id text CONSTRAINT genio_one_provider_credential_profile_revisi_tenant_id_not_null NOT NULL,
    profile_id text CONSTRAINT genio_one_provider_credential_profile_revis_profile_id_not_null NOT NULL,
    revision bigint CONSTRAINT genio_one_provider_credential_profile_revisio_revision_not_null NOT NULL,
    owner_organization_id text CONSTRAINT genio_one_provider_credential_pr_owner_organization_id_not_null NOT NULL,
    display_name text CONSTRAINT genio_one_provider_credential_profile_rev_display_name_not_null NOT NULL,
    adapter_family text CONSTRAINT genio_one_provider_credential_profile_re_provider_type_not_null NOT NULL,
    strategy jsonb CONSTRAINT genio_one_provider_credential_profile_revisio_strategy_not_null NOT NULL,
    strategy_digest text CONSTRAINT genio_one_provider_credential_profile__strategy_digest_not_null NOT NULL,
    state text NOT NULL,
    created_by_subject_id text CONSTRAINT genio_one_provider_credential_pr_created_by_subject_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT genio_one_provider_credential_profile_revis_created_at_not_null NOT NULL,
    credential_ciphertext text,
    CONSTRAINT genio_one_provider_credential_adapter_family_check CHECK ((adapter_family = ANY (ARRAY['GENERIC'::text, 'GCP'::text]))),
    CONSTRAINT genio_one_provider_credential_profile_rev_strategy_digest_check CHECK ((strategy_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT genio_one_provider_credential_profile_revisi_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_provider_credential_profile_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT genio_one_provider_credential_profile_revisions_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text]))),
    CONSTRAINT genio_one_provider_credential_profile_revisions_strategy_check CHECK ((jsonb_typeof(strategy) = 'object'::text))
);

CREATE TABLE genio_one_provider_profiles (
    tenant_id text NOT NULL,
    profile_id text NOT NULL,
    display_name text NOT NULL,
    provider_type text NOT NULL,
    protocol text NOT NULL,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    model_discovery text NOT NULL,
    endpoint_required boolean NOT NULL,
    credential_required boolean NOT NULL,
    built_in boolean DEFAULT false NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_provider_profiles_capabilities_check CHECK ((jsonb_typeof(capabilities) = 'array'::text)),
    CONSTRAINT genio_one_provider_profiles_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_provider_profiles_row_revision_check CHECK ((row_revision > 0))
);

CREATE TABLE genio_one_public_models (
    tenant_id text NOT NULL,
    model_id text NOT NULL,
    model_name text NOT NULL,
    display_name text NOT NULL,
    resource_id text NOT NULL,
    visibility text NOT NULL,
    lifecycle text NOT NULL,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_public_models_capabilities_check CHECK ((jsonb_typeof(capabilities) = 'array'::text)),
    CONSTRAINT genio_one_public_models_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_public_models_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['PUBLISHED'::text, 'DEPRECATED'::text]))),
    CONSTRAINT genio_one_public_models_model_name_check CHECK ((length(TRIM(BOTH FROM model_name)) > 0)),
    CONSTRAINT genio_one_public_models_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_public_models_visibility_check CHECK ((visibility = ANY (ARRAY['PUBLIC'::text, 'PRIVATE'::text])))
);

CREATE TABLE genio_one_publication_build_attempts (
    tenant_id text NOT NULL,
    publication_id text NOT NULL,
    attempt_id text NOT NULL,
    request_id text NOT NULL,
    snapshot_digest text NOT NULL,
    state text NOT NULL,
    projection_digest text,
    failure_code text,
    claimed_by text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT genio_one_publication_build_attempts_claimed_by_check CHECK ((length(TRIM(BOTH FROM claimed_by)) > 0)),
    CONSTRAINT genio_one_publication_build_attempts_request_id_check CHECK ((length(TRIM(BOTH FROM request_id)) > 0)),
    CONSTRAINT genio_one_publication_build_attempts_snapshot_digest_check CHECK ((length(TRIM(BOTH FROM snapshot_digest)) > 0)),
    CONSTRAINT genio_one_publication_build_attempts_state_check CHECK ((state = ANY (ARRAY['BUILDING'::text, 'FAILED'::text, 'READY'::text])))
);

CREATE TABLE genio_one_publications (
    tenant_id text NOT NULL,
    publication_id text NOT NULL,
    resource_id text NOT NULL,
    endpoint_revision bigint NOT NULL,
    resource_revision bigint NOT NULL,
    resource_digest text NOT NULL,
    policy_revision bigint NOT NULL,
    gateway_id text NOT NULL,
    hostname text NOT NULL,
    base_path text DEFAULT '/'::text NOT NULL,
    visibility text DEFAULT 'PRIVATE'::text NOT NULL,
    publication_state text DEFAULT 'DRAFT'::text NOT NULL,
    dns_management text DEFAULT 'EXTERNAL'::text NOT NULL,
    dns_proof_status text DEFAULT 'PENDING'::text NOT NULL,
    dns_proof jsonb DEFAULT '{}'::jsonb NOT NULL,
    request_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    review_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    publication_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    publication_build_state text DEFAULT 'IDLE'::text NOT NULL,
    build_attempt_id text,
    last_error_code text,
    projection_digest text,
    CONSTRAINT genio_one_publications_attempt_state_check CHECK ((((publication_build_state = ANY (ARRAY['BUILDING'::text, 'FAILED'::text, 'READY'::text])) AND (build_attempt_id IS NOT NULL)) OR ((publication_build_state = ANY (ARRAY['IDLE'::text, 'PENDING_REVIEW'::text])) AND (build_attempt_id IS NULL)))),
    CONSTRAINT genio_one_publications_base_path_check CHECK ((base_path ~~ '/%'::text)),
    CONSTRAINT genio_one_publications_build_state_check CHECK ((publication_build_state = ANY (ARRAY['IDLE'::text, 'PENDING_REVIEW'::text, 'BUILDING'::text, 'FAILED'::text, 'READY'::text]))),
    CONSTRAINT genio_one_publications_dns_management_check CHECK ((dns_management = ANY (ARRAY['PLATFORM_MANAGED'::text, 'EXTERNAL'::text]))),
    CONSTRAINT genio_one_publications_dns_proof_check CHECK ((jsonb_typeof(dns_proof) = 'object'::text)),
    CONSTRAINT genio_one_publications_dns_proof_status_check CHECK ((dns_proof_status = ANY (ARRAY['PENDING'::text, 'VERIFIED'::text, 'FAILED'::text]))),
    CONSTRAINT genio_one_publications_endpoint_revision_check CHECK ((endpoint_revision > 0)),
    CONSTRAINT genio_one_publications_hostname_check CHECK ((hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'::text)),
    CONSTRAINT genio_one_publications_policy_revision_check CHECK ((policy_revision >= 0)),
    CONSTRAINT genio_one_publications_publication_state_check CHECK ((publication_state = ANY (ARRAY['DRAFT'::text, 'PENDING_REVIEW'::text, 'PUBLISHED'::text, 'DEPRECATED'::text, 'RETIRED'::text]))),
    CONSTRAINT genio_one_publications_request_snapshot_check CHECK ((jsonb_typeof(request_snapshot) = 'object'::text)),
    CONSTRAINT genio_one_publications_resource_revision_check CHECK ((resource_revision > 0)),
    CONSTRAINT genio_one_publications_review_snapshot_check CHECK ((jsonb_typeof(review_snapshot) = 'object'::text)),
    CONSTRAINT genio_one_publications_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_publications_snapshot_object_check CHECK ((jsonb_typeof(publication_snapshot) = 'object'::text)),
    CONSTRAINT genio_one_publications_visibility_check CHECK ((visibility = ANY (ARRAY['PRIVATE'::text, 'REQUEST'::text, 'PUBLIC'::text])))
);

CREATE TABLE genio_one_resource_connections (
    tenant_id text NOT NULL,
    resource_id text NOT NULL,
    connection_id text NOT NULL,
    display_name text NOT NULL,
    provider_type text,
    provider_profile_id text,
    endpoint text NOT NULL,
    credential_ref text,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    connection_kind text DEFAULT 'LLM'::text NOT NULL,
    downstream_identity jsonb DEFAULT '{"mode": "NONE"}'::jsonb NOT NULL,
    mcp_tool_namespace text,
    mcp_selected_tools text[] DEFAULT '{}'::text[] NOT NULL,
    mcp_tool_selection_operation_id text,
    request_mapping jsonb,
    configuration_revision bigint DEFAULT 1 NOT NULL,
    lifecycle text NOT NULL,
    verification_state text NOT NULL,
    health_state text NOT NULL,
    health_observed_at timestamp with time zone,
    health_source_revision bigint,
    routing_priority integer DEFAULT 0 NOT NULL,
    region text,
    supported_obligations text[] DEFAULT '{}'::text[] NOT NULL,
    revoke_requested_after_release_revision bigint,
    provider_credential_profile_id text,
    provider_credential_profile_revision bigint,
    provider_credential_strategy_digest text,
    certificate_mode text DEFAULT 'SYSTEM_CA'::text NOT NULL,
    certificate_pem text,
    certificate_fingerprint_sha256 text,
    certificate_subject text,
    certificate_issuer text,
    certificate_is_self_signed boolean DEFAULT false CONSTRAINT genio_one_resource_connecti_certificate_is_self_signed_not_null NOT NULL,
    certificate_not_before timestamp with time zone,
    certificate_not_after timestamp with time zone,
    connector_configuration jsonb,
    CONSTRAINT genio_one_connection_provider_credential_binding_check CHECK ((((provider_credential_profile_id IS NULL) AND (provider_credential_profile_revision IS NULL) AND (provider_credential_strategy_digest IS NULL)) OR ((length(TRIM(BOTH FROM provider_credential_profile_id)) > 0) AND (provider_credential_profile_revision > 0) AND (provider_credential_strategy_digest ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT genio_one_connections_certificate_fingerprint CHECK (((certificate_fingerprint_sha256 IS NULL) OR (certificate_fingerprint_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT genio_one_connections_certificate_mode CHECK ((certificate_mode = ANY (ARRAY['SYSTEM_CA'::text, 'CUSTOM_CA'::text]))),
    CONSTRAINT genio_one_connections_certificate_pem_length CHECK (((certificate_pem IS NULL) OR (length(certificate_pem) <= 131072))),
    CONSTRAINT genio_one_connections_certificate_shape CHECK ((((certificate_mode = 'SYSTEM_CA'::text) AND (certificate_pem IS NULL) AND (certificate_fingerprint_sha256 IS NULL) AND (certificate_subject IS NULL) AND (certificate_issuer IS NULL) AND (certificate_is_self_signed = false) AND (certificate_not_before IS NULL) AND (certificate_not_after IS NULL)) OR ((certificate_mode = 'CUSTOM_CA'::text) AND (certificate_pem IS NOT NULL) AND (certificate_fingerprint_sha256 IS NOT NULL) AND (certificate_subject IS NOT NULL) AND (certificate_issuer IS NOT NULL) AND (certificate_not_before IS NOT NULL) AND (certificate_not_after IS NOT NULL)))),
    CONSTRAINT genio_one_connections_certificate_window CHECK (((certificate_not_before IS NULL) OR (certificate_not_after IS NULL) OR (certificate_not_after > certificate_not_before))),
    CONSTRAINT genio_one_connections_downstream_identity_check CHECK (((jsonb_typeof(downstream_identity) = 'object'::text) AND (((downstream_identity = '{"mode": "SERVICE", "authentication": "PROVIDER_CREDENTIAL_PROFILE"}'::jsonb) AND (provider_credential_profile_id IS NOT NULL) AND (provider_credential_profile_revision IS NOT NULL) AND (provider_credential_strategy_digest IS NOT NULL) AND (credential_ref IS NULL)) OR ((provider_credential_profile_id IS NULL) AND (provider_credential_profile_revision IS NULL) AND (provider_credential_strategy_digest IS NULL) AND (((connection_kind = 'LLM'::text) AND (downstream_identity = '{"mode": "NONE"}'::jsonb) AND (credential_ref IS NULL)) OR ((connection_kind = 'API'::text) AND (downstream_identity = '{"mode": "NONE"}'::jsonb) AND (credential_ref IS NULL)) OR ((connection_kind = 'MCP'::text) AND (((downstream_identity = '{"mode": "NONE"}'::jsonb) AND (credential_ref IS NULL)) OR ((downstream_identity = '{"mode": "SERVICE", "authentication": "API_KEY"}'::jsonb) AND (credential_ref IS NOT NULL)) OR (((downstream_identity ->> 'mode'::text) = 'USER_OAUTH'::text) AND (credential_ref IS NULL) AND ((downstream_identity - 'oauth_client'::text) = '{"mode": "USER_OAUTH"}'::jsonb) AND ((NOT (downstream_identity ? 'oauth_client'::text)) OR (jsonb_typeof((downstream_identity -> 'oauth_client'::text)) = 'object'::text))) OR ((downstream_identity = '{"mode": "USER_PASSWORD"}'::jsonb) AND (credential_ref IS NULL)) OR (((downstream_identity ->> 'mode'::text) = 'USER_PASSTHROUGH'::text) AND (credential_ref IS NULL))))))))),
    CONSTRAINT genio_one_connections_kind_check CHECK ((connection_kind = ANY (ARRAY['LLM'::text, 'MCP'::text, 'API'::text]))),
    CONSTRAINT genio_one_connections_kind_provider_check CHECK ((((connection_kind = 'LLM'::text) AND (provider_type IS NOT NULL) AND (provider_profile_id IS NOT NULL)) OR ((connection_kind = ANY (ARRAY['MCP'::text, 'API'::text])) AND (provider_type IS NULL) AND (provider_profile_id IS NULL)))),
    CONSTRAINT genio_one_connections_request_mapping_check CHECK ((((connection_kind = 'API'::text) AND (request_mapping IS NOT NULL) AND (jsonb_typeof(request_mapping) = 'object'::text)) OR ((connection_kind <> 'API'::text) AND (request_mapping IS NULL)))),
    CONSTRAINT genio_one_resource_connections_configuration_revision_positive CHECK ((configuration_revision > 0)),
    CONSTRAINT genio_one_resource_connections_credential_ref_check CHECK (((credential_ref IS NULL) OR (length(TRIM(BOTH FROM credential_ref)) > 0))),
    CONSTRAINT genio_one_resource_connections_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_resource_connections_endpoint_check CHECK ((length(TRIM(BOTH FROM endpoint)) > 0)),
    CONSTRAINT genio_one_resource_connections_health_revision_positive CHECK (((health_source_revision IS NULL) OR (health_source_revision > 0))),
    CONSTRAINT genio_one_resource_connections_health_state CHECK ((health_state = ANY (ARRAY['UNKNOWN'::text, 'HEALTHY'::text, 'DEGRADED'::text, 'UNAVAILABLE'::text]))),
    CONSTRAINT genio_one_resource_connections_lifecycle CHECK ((lifecycle = ANY (ARRAY['DRAFT'::text, 'ENABLED'::text, 'DISABLED'::text, 'REVOKE_PENDING'::text, 'REVOKED'::text]))),
    CONSTRAINT genio_one_resource_connections_pending_revoke_watermark_require CHECK (((lifecycle <> 'REVOKE_PENDING'::text) OR (revoke_requested_after_release_revision IS NOT NULL))),
    CONSTRAINT genio_one_resource_connections_region_nonempty CHECK (((region IS NULL) OR (length(TRIM(BOTH FROM region)) > 0))),
    CONSTRAINT genio_one_resource_connections_revoke_release_watermark_nonnega CHECK (((revoke_requested_after_release_revision IS NULL) OR (revoke_requested_after_release_revision >= 0))),
    CONSTRAINT genio_one_resource_connections_routing_priority_range CHECK (((routing_priority >= 0) AND (routing_priority <= 1000))),
    CONSTRAINT genio_one_resource_connections_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_resource_connections_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'READY'::text, 'DEGRADED'::text, 'DISABLED'::text]))),
    CONSTRAINT genio_one_resource_connections_verification_state CHECK ((verification_state = ANY (ARRAY['UNVERIFIED'::text, 'VERIFIED'::text, 'FAILED'::text])))
);

CREATE TABLE genio_one_resources (
    tenant_id text NOT NULL,
    resource_id text NOT NULL,
    display_name text NOT NULL,
    kind text NOT NULL,
    owner_organization_id text NOT NULL,
    authentication_strategy text NOT NULL,
    environment_id text NOT NULL,
    version text NOT NULL,
    lifecycle text DEFAULT 'DRAFT'::text NOT NULL,
    operational_state text DEFAULT 'UNKNOWN'::text NOT NULL,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    enforcement_point_id text NOT NULL,
    row_revision bigint DEFAULT 1 NOT NULL,
    resource_digest text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    api_metadata jsonb,
    extension_metadata jsonb,
    documentation text DEFAULT ''::text NOT NULL,
    builtin_service text,
    installation_owned boolean DEFAULT false NOT NULL,
    service_kind text,
    CONSTRAINT genio_one_builtin_service_check CHECK (((builtin_service IS NULL) OR ((builtin_service = 'DISCOVERY'::text) AND (kind = 'MCP'::text)))),
    CONSTRAINT genio_one_resources_api_metadata_check CHECK ((((kind = 'API'::text) AND ((api_metadata IS NULL) OR (jsonb_typeof(api_metadata) = 'object'::text))) OR ((kind <> 'API'::text) AND (api_metadata IS NULL)))),
    CONSTRAINT genio_one_resources_capabilities_check CHECK ((jsonb_typeof(capabilities) = 'array'::text)),
    CONSTRAINT genio_one_resources_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_resources_extension_metadata_object CHECK (((extension_metadata IS NULL) OR (jsonb_typeof(extension_metadata) = 'object'::text))),
    CONSTRAINT genio_one_resources_installation_owned_check CHECK (((NOT installation_owned) OR (service_kind IS NOT NULL))),
    CONSTRAINT genio_one_resources_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'DEPRECATED'::text, 'RETIRED'::text]))),
    CONSTRAINT genio_one_resources_operational_state_check CHECK ((operational_state = ANY (ARRAY['UNKNOWN'::text, 'HEALTHY'::text, 'DEGRADED'::text, 'UNAVAILABLE'::text]))),
    CONSTRAINT genio_one_resources_row_revision_check CHECK ((row_revision > 0)),
    CONSTRAINT genio_one_resources_service_kind_check CHECK (((service_kind IS NULL) OR (service_kind = ANY (ARRAY['SERVICENOW_CSM'::text, 'MAIL2000'::text, 'DISCOVERY'::text, 'GENIO_BOT'::text])))),
    CONSTRAINT genio_one_resources_version_check CHECK ((length(TRIM(BOTH FROM version)) > 0))
);

CREATE TABLE genio_one_routing_attempt_events (
    tenant_id text NOT NULL,
    correlation_id text NOT NULL,
    attempt_id text NOT NULL,
    attempt_order integer NOT NULL,
    connection_id text NOT NULL,
    connection_configuration_revision bigint CONSTRAINT genio_one_routing_attempt_e_connection_configuration_r_not_null NOT NULL,
    priority integer NOT NULL,
    outcome text NOT NULL,
    response_started boolean NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    CONSTRAINT genio_one_routing_attempt_ev_connection_configuration_rev_check CHECK ((connection_configuration_revision > 0)),
    CONSTRAINT genio_one_routing_attempt_events_attempt_order_check CHECK ((attempt_order > 0)),
    CONSTRAINT genio_one_routing_attempt_events_outcome_check CHECK ((outcome = ANY (ARRAY['SELECTED'::text, 'CONNECT_FAILURE'::text, 'RESET_BEFORE_RESPONSE'::text, 'RETRIED_BEFORE_RESPONSE'::text, 'HTTP_5XX'::text, 'MID_STREAM_FAILURE'::text]))),
    CONSTRAINT genio_one_routing_attempt_events_priority_check CHECK (((priority >= 0) AND (priority <= 1000)))
);

CREATE TABLE genio_one_self_service_configuration_projections (
    tenant_id text CONSTRAINT genio_one_self_service_configuration_project_tenant_id_not_null NOT NULL,
    revision text CONSTRAINT genio_one_self_service_configuration_projecti_revision_not_null NOT NULL,
    projected_at timestamp with time zone DEFAULT now() CONSTRAINT genio_one_self_service_configuration_proj_projected_at_not_null NOT NULL
);

CREATE TABLE genio_one_siem_deliveries (
    tenant_id text NOT NULL,
    destination_id text NOT NULL,
    audit_event_id text NOT NULL,
    endpoint_url text NOT NULL,
    event jsonb NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    delivered_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_siem_deliveries_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT genio_one_siem_deliveries_event_check CHECK ((jsonb_typeof(event) = 'object'::text)),
    CONSTRAINT genio_one_siem_deliveries_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'IN_FLIGHT'::text, 'RETRY_SCHEDULED'::text, 'DELIVERED'::text, 'CANCELLED'::text])))
);

CREATE TABLE genio_one_siem_destinations (
    tenant_id text NOT NULL,
    destination_id text NOT NULL,
    endpoint_url text NOT NULL,
    event_kinds jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    configured_by_subject_id text NOT NULL,
    configured_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_siem_destinations_destination_id_check CHECK ((length(TRIM(BOTH FROM destination_id)) > 0)),
    CONSTRAINT genio_one_siem_destinations_endpoint_url_check CHECK ((length(TRIM(BOTH FROM endpoint_url)) > 0)),
    CONSTRAINT genio_one_siem_destinations_event_kinds_check CHECK ((jsonb_typeof(event_kinds) = 'array'::text))
);

CREATE TABLE genio_one_subject_roles (
    tenant_id text NOT NULL,
    subject_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT genio_one_subject_roles_role_check CHECK ((role = ANY (ARRAY['USER'::text, 'TENANT_ADMINISTRATOR'::text])))
);

CREATE TABLE genio_one_subjects (
    tenant_id text NOT NULL,
    subject_id text NOT NULL,
    kind text NOT NULL,
    display_name text,
    email text,
    department text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    suspended_at timestamp with time zone,
    suspended_by text,
    suspension_reason text,
    CONSTRAINT genio_one_subjects_department_check CHECK (((department IS NULL) OR (length(TRIM(BOTH FROM department)) > 0))),
    CONSTRAINT genio_one_subjects_display_name_check CHECK (((display_name IS NULL) OR (length(TRIM(BOTH FROM display_name)) > 0))),
    CONSTRAINT genio_one_subjects_email_check CHECK (((email IS NULL) OR (length(TRIM(BOTH FROM email)) > 0))),
    CONSTRAINT genio_one_subjects_kind_check CHECK ((kind = ANY (ARRAY['PERSON'::text, 'APPLICATION'::text, 'AGENT'::text]))),
    CONSTRAINT genio_one_subjects_subject_id_check CHECK ((length(TRIM(BOTH FROM subject_id)) > 0)),
    CONSTRAINT genio_one_subjects_tenant_id_check CHECK ((length(TRIM(BOTH FROM tenant_id)) > 0))
);

CREATE TABLE genio_one_tenant_configuration_revisions (
    tenant_id text NOT NULL,
    revision text NOT NULL,
    state text NOT NULL,
    settings jsonb NOT NULL,
    created_by_subject_id text CONSTRAINT genio_one_tenant_configuration_r_created_by_subject_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    validated_at timestamp with time zone,
    previewed_at timestamp with time zone,
    reviewed_at timestamp with time zone,
    published_at timestamp with time zone,
    observed_revision text,
    projection_status text DEFAULT 'PENDING'::text CONSTRAINT genio_one_tenant_configuration_revis_projection_status_not_null NOT NULL,
    projection_drift boolean DEFAULT true CONSTRAINT genio_one_tenant_configuration_revisi_projection_drift_not_null NOT NULL,
    projection_last_error text,
    projection_retry_count integer DEFAULT 0 CONSTRAINT genio_one_tenant_configuration__projection_retry_count_not_null NOT NULL,
    projection_last_reconciled_at timestamp with time zone,
    rolled_back_from text,
    CONSTRAINT genio_one_tenant_configuration_rev_projection_retry_count_check CHECK ((projection_retry_count >= 0)),
    CONSTRAINT genio_one_tenant_configuration_revision_projection_status_check CHECK ((projection_status = ANY (ARRAY['PENDING'::text, 'CONVERGED'::text, 'FAILED'::text, 'ROLLED_BACK'::text]))),
    CONSTRAINT genio_one_tenant_configuration_revisions_settings_check CHECK ((jsonb_typeof(settings) = 'object'::text)),
    CONSTRAINT genio_one_tenant_configuration_revisions_state_check CHECK ((state = ANY (ARRAY['DRAFT'::text, 'VALIDATED'::text, 'REVIEWED'::text, 'PUBLISHED'::text])))
);

CREATE TABLE genio_one_usage_policy_revisions (
    tenant_id text NOT NULL,
    usage_policy_id text NOT NULL,
    revision bigint NOT NULL,
    owner_organization_id text NOT NULL,
    accounting_key_id text NOT NULL,
    selectors jsonb NOT NULL,
    limits jsonb NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text,
    CONSTRAINT genio_one_usage_policy_revisions_accounting_key_id_check CHECK ((length(TRIM(BOTH FROM accounting_key_id)) > 0)),
    CONSTRAINT genio_one_usage_policy_revisions_display_name_nonempty CHECK (((display_name IS NULL) OR (length(TRIM(BOTH FROM display_name)) > 0))),
    CONSTRAINT genio_one_usage_policy_revisions_limits_check CHECK ((jsonb_typeof(limits) = 'object'::text)),
    CONSTRAINT genio_one_usage_policy_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT genio_one_usage_policy_revisions_selectors_check CHECK ((jsonb_typeof(selectors) = 'object'::text)),
    CONSTRAINT genio_one_usage_policy_revisions_state_check CHECK ((state = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text, 'RETIRED'::text])))
);

CREATE TABLE genio_one_usage_quantities (
    tenant_id text NOT NULL,
    quantity_id text NOT NULL,
    invocation_id text NOT NULL,
    quantity numeric NOT NULL,
    unit text NOT NULL,
    trusted_source text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    CONSTRAINT genio_one_usage_quantities_quantity_check CHECK ((quantity >= (0)::numeric))
);

CREATE TABLE genio_one_use_cases (
    tenant_id text NOT NULL,
    organization_id text NOT NULL,
    use_case_id text NOT NULL,
    display_name text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    risk_level text DEFAULT 'LOW'::text NOT NULL,
    CONSTRAINT genio_one_use_cases_display_name_check CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT genio_one_use_cases_risk_level_check CHECK ((risk_level = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'CRITICAL'::text]))),
    CONSTRAINT genio_one_use_cases_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text])))
);

ALTER TABLE ONLY genio_one_access_group_revisions
    ADD CONSTRAINT genio_one_access_group_revisions_pkey PRIMARY KEY (tenant_id, access_group_id, revision);

ALTER TABLE ONLY genio_one_access_groups
    ADD CONSTRAINT genio_one_access_groups_pkey PRIMARY KEY (tenant_id, access_group_id);

ALTER TABLE ONLY genio_one_access_requests
    ADD CONSTRAINT genio_one_access_requests_pkey PRIMARY KEY (tenant_id, access_request_id);

ALTER TABLE ONLY genio_one_activity_outcome_attributions
    ADD CONSTRAINT genio_one_activity_outcome_attributions_pkey PRIMARY KEY (tenant_id, attribution_id);

ALTER TABLE ONLY genio_one_agent_delegation_revisions
    ADD CONSTRAINT genio_one_agent_delegation_revisions_pkey PRIMARY KEY (tenant_id, delegation_id, revision);

ALTER TABLE ONLY genio_one_application_api_credentials
    ADD CONSTRAINT genio_one_application_api_credentials_pkey PRIMARY KEY (tenant_id, credential_id);

ALTER TABLE ONLY genio_one_applications
    ADD CONSTRAINT genio_one_applications_pkey PRIMARY KEY (tenant_id, application_id);

ALTER TABLE ONLY genio_one_applications
    ADD CONSTRAINT genio_one_applications_tenant_id_subject_id_key UNIQUE (tenant_id, subject_id);

ALTER TABLE ONLY genio_one_bot_policy_revisions
    ADD CONSTRAINT genio_one_bot_policy_revisions_pkey PRIMARY KEY (tenant_id, policy_id, policy_revision);

ALTER TABLE ONLY genio_one_canonical_charges
    ADD CONSTRAINT genio_one_canonical_charges_pkey PRIMARY KEY (tenant_id, charge_id);

ALTER TABLE ONLY genio_one_canonical_charges
    ADD CONSTRAINT genio_one_canonical_charges_tenant_id_invocation_id_correla_key UNIQUE (tenant_id, invocation_id, correlation_id, accounting_key_id);

ALTER TABLE ONLY genio_one_canonical_invocation_accounting
    ADD CONSTRAINT genio_one_canonical_invocatio_tenant_id_correlation_id_acco_key UNIQUE (tenant_id, correlation_id, accounting_key_id);

ALTER TABLE ONLY genio_one_canonical_invocation_accounting
    ADD CONSTRAINT genio_one_canonical_invocation_accounting_pkey PRIMARY KEY (tenant_id, invocation_id);

ALTER TABLE ONLY genio_one_connection_model_mappings
    ADD CONSTRAINT genio_one_connection_model_ma_tenant_id_resource_id_mapping_key UNIQUE (tenant_id, resource_id, mapping_id);

ALTER TABLE ONLY genio_one_connection_model_mappings
    ADD CONSTRAINT genio_one_connection_model_ma_tenant_id_resource_id_public__key UNIQUE (tenant_id, resource_id, public_model_id, connection_id);

ALTER TABLE ONLY genio_one_connection_model_mappings
    ADD CONSTRAINT genio_one_connection_model_mappings_pkey PRIMARY KEY (tenant_id, mapping_id);

ALTER TABLE ONLY genio_one_resource_connections
    ADD CONSTRAINT genio_one_connections_provider_match_key UNIQUE (tenant_id, resource_id, connection_id, provider_profile_id);

ALTER TABLE ONLY genio_one_cost_valuations
    ADD CONSTRAINT genio_one_cost_valuations_pkey PRIMARY KEY (tenant_id, valuation_id);

ALTER TABLE ONLY genio_one_demo_installations
    ADD CONSTRAINT genio_one_demo_installations_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY genio_one_endpoint_activities
    ADD CONSTRAINT genio_one_endpoint_activities_pkey PRIMARY KEY (tenant_id, activity_id);

ALTER TABLE ONLY genio_one_endpoint_activities
    ADD CONSTRAINT genio_one_endpoint_activities_tenant_id_device_id_correlati_key UNIQUE (tenant_id, device_id, correlation_id);

ALTER TABLE ONLY genio_one_endpoint_credentials
    ADD CONSTRAINT genio_one_endpoint_credentials_pkey PRIMARY KEY (credential_id);

ALTER TABLE ONLY genio_one_endpoint_credentials
    ADD CONSTRAINT genio_one_endpoint_credentials_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY genio_one_endpoint_devices
    ADD CONSTRAINT genio_one_endpoint_devices_pkey PRIMARY KEY (tenant_id, device_id);

ALTER TABLE ONLY genio_one_endpoint_lifecycle_events
    ADD CONSTRAINT genio_one_endpoint_lifecycle_event_tenant_id_device_id_kind_key UNIQUE (tenant_id, device_id, kind);

ALTER TABLE ONLY genio_one_endpoint_lifecycle_events
    ADD CONSTRAINT genio_one_endpoint_lifecycle_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY genio_one_enforcement_chain_revisions
    ADD CONSTRAINT genio_one_enforcement_chain_revisions_pkey PRIMARY KEY (tenant_id, resource_id, capability_id, one_policy_revision);

ALTER TABLE ONLY genio_one_execution_grant_request_revisions
    ADD CONSTRAINT genio_one_execution_grant_request_revisions_pkey PRIMARY KEY (tenant_id, request_id, revision);

ALTER TABLE ONLY genio_one_execution_grants
    ADD CONSTRAINT genio_one_execution_grants_pkey PRIMARY KEY (tenant_id, execution_grant_id);

ALTER TABLE ONLY genio_one_execution_grants
    ADD CONSTRAINT genio_one_execution_grants_tenant_id_request_id_key UNIQUE (tenant_id, request_id);

ALTER TABLE ONLY genio_one_external_identity_bindings
    ADD CONSTRAINT genio_one_external_identity_bindings_pkey PRIMARY KEY (tenant_id, provider_id, external_subject_id);

ALTER TABLE ONLY genio_one_federation_assertion_uses
    ADD CONSTRAINT genio_one_federation_assertion_correlation_unique UNIQUE (tenant_id, correlation_id);

ALTER TABLE ONLY genio_one_federation_assertion_uses
    ADD CONSTRAINT genio_one_federation_assertion_uses_pkey PRIMARY KEY (tenant_id, trust_id, trust_revision, assertion_jti_sha256);

ALTER TABLE ONLY genio_one_federation_exchange_events
    ADD CONSTRAINT genio_one_federation_exchange_even_tenant_id_correlation_id_key UNIQUE (tenant_id, correlation_id);

ALTER TABLE ONLY genio_one_federation_exchange_events
    ADD CONSTRAINT genio_one_federation_exchange_events_pkey PRIMARY KEY (tenant_id, exchange_id);

ALTER TABLE ONLY genio_one_federation_trust_heads
    ADD CONSTRAINT genio_one_federation_trust_heads_pkey PRIMARY KEY (tenant_id, trust_id);

ALTER TABLE ONLY genio_one_federation_trust_revisions
    ADD CONSTRAINT genio_one_federation_trust_revisions_pkey PRIMARY KEY (tenant_id, trust_id, revision);

ALTER TABLE ONLY genio_one_first_party_policy_seeds
    ADD CONSTRAINT genio_one_first_party_policy_seeds_pkey PRIMARY KEY (tenant_id, policy_id);

ALTER TABLE ONLY genio_one_gateway_activities
    ADD CONSTRAINT genio_one_gateway_activities_pkey PRIMARY KEY (tenant_id, correlation_id);

ALTER TABLE ONLY genio_one_gateway_authorization_audit_events
    ADD CONSTRAINT genio_one_gateway_authorization_audit_events_pkey PRIMARY KEY (tenant_id, audit_event_id);

ALTER TABLE ONLY genio_one_gateway_diagnostic_settings
    ADD CONSTRAINT genio_one_gateway_diagnostic_settings_pkey PRIMARY KEY (tenant_id, gateway_id);

ALTER TABLE ONLY genio_one_gateway_policy_releases
    ADD CONSTRAINT genio_one_gateway_policy_rele_tenant_id_gateway_id_release__key UNIQUE (tenant_id, gateway_id, release_id);

ALTER TABLE ONLY genio_one_gateway_policy_release_projections
    ADD CONSTRAINT genio_one_gateway_policy_rele_tenant_id_release_id_projecti_key UNIQUE (tenant_id, release_id, projection_id);

ALTER TABLE ONLY genio_one_gateway_policy_release_heads
    ADD CONSTRAINT genio_one_gateway_policy_release_heads_pkey PRIMARY KEY (tenant_id, gateway_id);

ALTER TABLE ONLY genio_one_gateway_policy_release_manifests
    ADD CONSTRAINT genio_one_gateway_policy_release_manifests_pkey PRIMARY KEY (tenant_id, release_id, runtime_id);

ALTER TABLE ONLY genio_one_gateway_policy_release_projections
    ADD CONSTRAINT genio_one_gateway_policy_release_projections_pkey PRIMARY KEY (tenant_id, release_id, publication_id);

ALTER TABLE ONLY genio_one_gateway_policy_releases
    ADD CONSTRAINT genio_one_gateway_policy_releases_pkey PRIMARY KEY (tenant_id, release_id);

ALTER TABLE ONLY genio_one_gateway_projections
    ADD CONSTRAINT genio_one_gateway_projections_pkey PRIMARY KEY (tenant_id, projection_id);

ALTER TABLE ONLY genio_one_gateway_projections
    ADD CONSTRAINT genio_one_gateway_projections_release_reference_key UNIQUE (tenant_id, projection_id, publication_id, revision, digest);

ALTER TABLE ONLY genio_one_gateway_projections
    ADD CONSTRAINT genio_one_gateway_projections_tenant_id_resource_id_capabil_key UNIQUE (tenant_id, resource_id, capability_id, revision);

ALTER TABLE ONLY genio_one_gateway_registrations
    ADD CONSTRAINT genio_one_gateway_registrations_pkey PRIMARY KEY (tenant_id, runtime_id);

ALTER TABLE ONLY genio_one_mcp_discovery_operations
    ADD CONSTRAINT genio_one_mcp_discovery_operations_pkey PRIMARY KEY (tenant_id, operation_id);

ALTER TABLE ONLY genio_one_mcp_discovery_operations
    ADD CONSTRAINT genio_one_mcp_discovery_operations_tenant_id_correlation_id_key UNIQUE (tenant_id, correlation_id);

ALTER TABLE ONLY genio_one_mcp_oauth_bindings
    ADD CONSTRAINT genio_one_mcp_oauth_bindings_pkey PRIMARY KEY (tenant_id, connection_id, subject_id);

ALTER TABLE ONLY genio_one_mcp_oauth_sessions
    ADD CONSTRAINT genio_one_mcp_oauth_sessions_pkey PRIMARY KEY (tenant_id, session_id);

ALTER TABLE ONLY genio_one_mcp_oauth_sessions
    ADD CONSTRAINT genio_one_mcp_oauth_sessions_state_hash_key UNIQUE (state_hash);

ALTER TABLE ONLY genio_one_model_entitlements
    ADD CONSTRAINT genio_one_model_entitlements_pkey PRIMARY KEY (tenant_id, entitlement_id);

ALTER TABLE ONLY genio_one_model_price_catalog
    ADD CONSTRAINT genio_one_model_price_catalog_pkey PRIMARY KEY (source, source_version, provider_id, catalog_model_key);

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_model_route_transitions_pkey PRIMARY KEY (tenant_id, transition_id);

ALTER TABLE ONLY genio_one_model_routing_policies
    ADD CONSTRAINT genio_one_model_routing_polic_tenant_id_resource_id_capabil_key UNIQUE (tenant_id, resource_id, capability_id, routing_revision);

ALTER TABLE ONLY genio_one_model_routing_policies
    ADD CONSTRAINT genio_one_model_routing_policies_pkey PRIMARY KEY (tenant_id, routing_policy_id, routing_revision);

ALTER TABLE ONLY genio_one_public_models
    ADD CONSTRAINT genio_one_models_public_name_key UNIQUE (tenant_id, model_name);

ALTER TABLE ONLY genio_one_public_models
    ADD CONSTRAINT genio_one_models_resource_model_key UNIQUE (tenant_id, resource_id, model_id);

ALTER TABLE ONLY genio_one_mutation_idempotency_receipts
    ADD CONSTRAINT genio_one_mutation_idempotency_receipts_pkey PRIMARY KEY (tenant_id, idempotency_key);

ALTER TABLE ONLY genio_one_notification_subscriptions
    ADD CONSTRAINT genio_one_notification_subscr_tenant_id_subject_id_notifica_key UNIQUE (tenant_id, subject_id, notification_type, channel);

ALTER TABLE ONLY genio_one_notification_subscriptions
    ADD CONSTRAINT genio_one_notification_subscriptions_pkey PRIMARY KEY (tenant_id, subscription_id);

ALTER TABLE ONLY genio_one_organization_membership_sources
    ADD CONSTRAINT genio_one_organization_membership_sources_pkey PRIMARY KEY (tenant_id, organization_id, kind, reference);

ALTER TABLE ONLY genio_one_organization_memberships
    ADD CONSTRAINT genio_one_organization_memberships_pkey PRIMARY KEY (tenant_id, organization_id, subject_id);

ALTER TABLE ONLY genio_one_organizations
    ADD CONSTRAINT genio_one_organizations_pkey PRIMARY KEY (tenant_id, organization_id);

ALTER TABLE ONLY genio_one_organizations
    ADD CONSTRAINT genio_one_organizations_tenant_id_slug_key UNIQUE (tenant_id, slug);

ALTER TABLE ONLY genio_one_personal_password_credentials
    ADD CONSTRAINT genio_one_personal_password_credentials_pkey PRIMARY KEY (tenant_id, resource_id, connection_id, subject_id);

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_commands
    ADD CONSTRAINT genio_one_platform_runtime_ag_tenant_id_runtime_kind_runtim_key UNIQUE (tenant_id, runtime_kind, runtime_id, release_id);

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_commands
    ADD CONSTRAINT genio_one_platform_runtime_aggregate_commands_pkey PRIMARY KEY (tenant_id, runtime_kind, runtime_id, command_id);

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_observed_states
    ADD CONSTRAINT genio_one_platform_runtime_aggregate_observed_states_pkey PRIMARY KEY (tenant_id, runtime_kind, runtime_id);

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_report_history
    ADD CONSTRAINT genio_one_platform_runtime_aggregate_report_history_pkey PRIMARY KEY (tenant_id, runtime_kind, runtime_id, report_id);

ALTER TABLE ONLY genio_one_platform_runtime_capabilities
    ADD CONSTRAINT genio_one_platform_runtime_capabilities_pkey PRIMARY KEY (tenant_id, runtime_kind, runtime_id);

ALTER TABLE ONLY genio_one_platform_runtime_registrations
    ADD CONSTRAINT genio_one_platform_runtime_registrations_pkey PRIMARY KEY (tenant_id, runtime_kind, runtime_id);

ALTER TABLE ONLY genio_one_platform_runtime_session_leases
    ADD CONSTRAINT genio_one_platform_runtime_session_leases_pkey PRIMARY KEY (tenant_id, runtime_kind, runtime_id);

ALTER TABLE ONLY genio_one_policy_authoring_settings
    ADD CONSTRAINT genio_one_policy_authoring_settings_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY genio_one_policy_drafts
    ADD CONSTRAINT genio_one_policy_drafts_pkey PRIMARY KEY (tenant_id, policy_key);

ALTER TABLE ONLY genio_one_policy_revisions
    ADD CONSTRAINT genio_one_policy_revisions_pkey PRIMARY KEY (tenant_id, policy_id, revision);

ALTER TABLE ONLY genio_one_price_catalog_versions
    ADD CONSTRAINT genio_one_price_catalog_versions_pkey PRIMARY KEY (source, source_version);

ALTER TABLE ONLY genio_one_provider_credential_profile_revisions
    ADD CONSTRAINT genio_one_provider_credential_profile_revisions_pkey PRIMARY KEY (tenant_id, profile_id, revision);

ALTER TABLE ONLY genio_one_provider_profiles
    ADD CONSTRAINT genio_one_provider_profiles_pkey PRIMARY KEY (tenant_id, profile_id);

ALTER TABLE ONLY genio_one_public_models
    ADD CONSTRAINT genio_one_public_models_pkey PRIMARY KEY (tenant_id, model_id);

ALTER TABLE ONLY genio_one_publication_build_attempts
    ADD CONSTRAINT genio_one_publication_build_attempts_pkey PRIMARY KEY (tenant_id, publication_id, attempt_id);

ALTER TABLE ONLY genio_one_publications
    ADD CONSTRAINT genio_one_publications_pkey PRIMARY KEY (tenant_id, publication_id);

ALTER TABLE ONLY genio_one_publications
    ADD CONSTRAINT genio_one_publications_projection_revision_key UNIQUE (tenant_id, publication_id, endpoint_revision, resource_revision);

ALTER TABLE ONLY genio_one_publications
    ADD CONSTRAINT genio_one_publications_tenant_id_resource_id_endpoint_revis_key UNIQUE (tenant_id, resource_id, endpoint_revision);

ALTER TABLE ONLY genio_one_resource_connections
    ADD CONSTRAINT genio_one_resource_connections_pkey PRIMARY KEY (tenant_id, resource_id, connection_id);

ALTER TABLE ONLY genio_one_resources
    ADD CONSTRAINT genio_one_resources_pkey PRIMARY KEY (tenant_id, resource_id);

ALTER TABLE ONLY genio_one_routing_attempt_events
    ADD CONSTRAINT genio_one_routing_attempt_eve_tenant_id_correlation_id_atte_key UNIQUE (tenant_id, correlation_id, attempt_order);

ALTER TABLE ONLY genio_one_routing_attempt_events
    ADD CONSTRAINT genio_one_routing_attempt_events_pkey PRIMARY KEY (tenant_id, correlation_id, attempt_id);

ALTER TABLE ONLY genio_one_self_service_configuration_projections
    ADD CONSTRAINT genio_one_self_service_configuration_projections_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY genio_one_siem_deliveries
    ADD CONSTRAINT genio_one_siem_deliveries_pkey PRIMARY KEY (tenant_id, destination_id, audit_event_id);

ALTER TABLE ONLY genio_one_siem_destinations
    ADD CONSTRAINT genio_one_siem_destinations_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY genio_one_subject_roles
    ADD CONSTRAINT genio_one_subject_roles_pkey PRIMARY KEY (tenant_id, subject_id, role);

ALTER TABLE ONLY genio_one_subjects
    ADD CONSTRAINT genio_one_subjects_pkey PRIMARY KEY (tenant_id, subject_id);

ALTER TABLE ONLY genio_one_tenant_configuration_revisions
    ADD CONSTRAINT genio_one_tenant_configuration_revisions_pkey PRIMARY KEY (tenant_id, revision);

ALTER TABLE ONLY genio_one_usage_policy_revisions
    ADD CONSTRAINT genio_one_usage_policy_revisions_pkey PRIMARY KEY (tenant_id, usage_policy_id, revision);

ALTER TABLE ONLY genio_one_usage_quantities
    ADD CONSTRAINT genio_one_usage_quantities_pkey PRIMARY KEY (tenant_id, quantity_id);

ALTER TABLE ONLY genio_one_use_cases
    ADD CONSTRAINT genio_one_use_cases_pkey PRIMARY KEY (tenant_id, organization_id, use_case_id);

CREATE INDEX genio_one_access_groups_subject_lookup_idx ON genio_one_access_groups USING gin (((value -> 'membership_sources'::text)) jsonb_path_ops);

CREATE UNIQUE INDEX genio_one_access_requests_one_pending_idx ON genio_one_access_requests USING btree (tenant_id, target_subject_id, resource_id, capability_id) WHERE (state = 'PENDING'::text);

CREATE INDEX genio_one_access_requests_owner_idx ON genio_one_access_requests USING btree (tenant_id, owner_organization_id, created_at DESC);

CREATE INDEX genio_one_activity_outcome_correlation_idx ON genio_one_activity_outcome_attributions USING btree (tenant_id, correlation_id, observed_at, attribution_id);

CREATE INDEX genio_one_agent_delegation_agent_idx ON genio_one_agent_delegation_revisions USING btree (tenant_id, agent_subject_id, state, expires_at);

CREATE UNIQUE INDEX genio_one_application_api_credentials_active_idx ON genio_one_application_api_credentials USING btree (tenant_id, application_id, resource_id, capability_id) WHERE (state = 'ACTIVE'::text);

CREATE INDEX genio_one_application_api_credentials_application_idx ON genio_one_application_api_credentials USING btree (tenant_id, application_id, created_at DESC);

CREATE UNIQUE INDEX genio_one_application_api_credentials_generation_idx ON genio_one_application_api_credentials USING btree (tenant_id, application_id, resource_id, capability_id, generation);

CREATE UNIQUE INDEX genio_one_application_api_credentials_operation_idx ON genio_one_application_api_credentials USING btree (tenant_id, application_id, operation_correlation_id) WHERE (operation_correlation_id IS NOT NULL);

CREATE INDEX genio_one_application_api_credentials_retirement_idx ON genio_one_application_api_credentials USING btree (tenant_id, valid_until, credential_id) WHERE ((state = 'RETIRED'::text) AND (external_subject_id IS NOT NULL));

CREATE INDEX genio_one_applications_owner_idx ON genio_one_applications USING btree (tenant_id, owner_organization_id, created_at DESC);

CREATE UNIQUE INDEX genio_one_builtin_service_unique ON genio_one_resources USING btree (tenant_id, builtin_service) WHERE (builtin_service IS NOT NULL);

CREATE INDEX genio_one_connections_certificate_expiry_idx ON genio_one_resource_connections USING btree (tenant_id, certificate_not_after) WHERE (certificate_mode = 'CUSTOM_CA'::text);

CREATE INDEX genio_one_connections_resource_idx ON genio_one_resource_connections USING btree (tenant_id, resource_id, status);

CREATE INDEX genio_one_endpoint_activities_recent_idx ON genio_one_endpoint_activities USING btree (tenant_id, observed_at DESC, activity_id DESC);

CREATE INDEX genio_one_endpoint_activities_resource_idx ON genio_one_endpoint_activities USING btree (tenant_id, resource_id, observed_at);

CREATE UNIQUE INDEX genio_one_endpoint_bootstrap_correlation_idx ON genio_one_endpoint_credentials USING btree (tenant_id, subject_id, correlation_id) WHERE (kind = 'BOOTSTRAP'::text);

CREATE INDEX genio_one_endpoint_credentials_device_idx ON genio_one_endpoint_credentials USING btree (tenant_id, device_id);

CREATE INDEX genio_one_endpoint_devices_subject_idx ON genio_one_endpoint_devices USING btree (tenant_id, subject_id, last_seen_at DESC);

CREATE INDEX genio_one_endpoint_lifecycle_events_device_idx ON genio_one_endpoint_lifecycle_events USING btree (tenant_id, device_id, event_id);

CREATE INDEX genio_one_enforcement_chain_revision_idx ON genio_one_enforcement_chain_revisions USING btree (tenant_id, resource_id, capability_id, one_policy_revision DESC);

CREATE UNIQUE INDEX genio_one_entitlement_grant_idempotency_key_unique ON genio_one_model_entitlements USING btree (tenant_id, grant_idempotency_key) WHERE (grant_idempotency_key IS NOT NULL);

CREATE INDEX genio_one_entitlements_capability_idx ON genio_one_model_entitlements USING btree (tenant_id, resource_id, capability_id, state, starts_at, expires_at);

CREATE INDEX genio_one_execution_grants_subject_idx ON genio_one_execution_grants USING btree (tenant_id, subject_id, resource_id, capability_id, expires_at);

CREATE INDEX genio_one_federation_assertion_expiry_idx ON genio_one_federation_assertion_uses USING btree (expires_at);

CREATE INDEX genio_one_federation_exchange_application_idx ON genio_one_federation_exchange_events USING btree (tenant_id, application_id, occurred_at DESC);

CREATE INDEX genio_one_federation_trust_application_idx ON genio_one_federation_trust_heads USING btree (tenant_id, application_id, state, trust_id);

CREATE INDEX genio_one_first_party_policy_seeds_enabled_idx ON genio_one_first_party_policy_seeds USING btree (tenant_id, enabled);

CREATE INDEX genio_one_gateway_activities_recent_idx ON genio_one_gateway_activities USING btree (tenant_id, occurred_at DESC);

CREATE INDEX genio_one_gateway_activities_session_timeline_idx ON genio_one_gateway_activities USING btree (tenant_id, session_id, occurred_at, correlation_id) WHERE (session_id IS NOT NULL);

CREATE INDEX genio_one_gateway_authorization_audit_access_group_idx ON genio_one_gateway_authorization_audit_events USING btree (tenant_id, occurred_at DESC) WHERE ((event ->> 'kind'::text) = 'ACCESS_GROUP_CHANGE'::text);

CREATE INDEX genio_one_gateway_authorization_audit_correlation_idx ON genio_one_gateway_authorization_audit_events USING btree (tenant_id, correlation_id);

CREATE INDEX genio_one_gateway_authorization_audit_policy_change_idx ON genio_one_gateway_authorization_audit_events USING btree (tenant_id, occurred_at DESC) WHERE ((event ->> 'kind'::text) = 'POLICY_CHANGE'::text);

CREATE INDEX genio_one_gateway_authorization_audit_recent_idx ON genio_one_gateway_authorization_audit_events USING btree (tenant_id, occurred_at DESC);

CREATE INDEX genio_one_gateway_policy_release_projections_projection_idx ON genio_one_gateway_policy_release_projections USING btree (tenant_id, projection_id, release_id);

CREATE INDEX genio_one_gateway_projections_publication_revision_idx ON genio_one_gateway_projections USING btree (tenant_id, publication_id, endpoint_revision, resource_revision, projection_id);

CREATE INDEX genio_one_gateway_projections_revision_idx ON genio_one_gateway_projections USING btree (tenant_id, revision DESC);

CREATE INDEX genio_one_gateway_registrations_state_idx ON genio_one_gateway_registrations USING btree (tenant_id, state, registered_at DESC);

CREATE UNIQUE INDEX genio_one_mcp_discovery_active_connection_idx ON genio_one_mcp_discovery_operations USING btree (tenant_id, connection_id) WHERE (state = ANY (ARRAY['PENDING'::text, 'RUNNING'::text]));

CREATE INDEX genio_one_mcp_discovery_gateway_queue_idx ON genio_one_mcp_discovery_operations USING btree (tenant_id, gateway_id, state, created_at);

CREATE INDEX genio_one_mcp_oauth_sessions_expiry_idx ON genio_one_mcp_oauth_sessions USING btree (expires_at);

CREATE INDEX genio_one_model_entitlements_effective_idx ON genio_one_model_entitlements USING btree (tenant_id, subject_id, client_id, public_model_id, state, starts_at, expires_at);

CREATE INDEX genio_one_model_entitlements_model_idx ON genio_one_model_entitlements USING btree (tenant_id, public_model_id, state, starts_at, expires_at, entitlement_id);

CREATE INDEX genio_one_model_mappings_model_idx ON genio_one_connection_model_mappings USING btree (tenant_id, resource_id, public_model_id, mapping_revision);

CREATE INDEX genio_one_model_price_lookup ON genio_one_model_price_catalog USING btree (source, source_version, provider_id, provider_model_id);

CREATE INDEX genio_one_model_routing_policies_scope_idx ON genio_one_model_routing_policies USING btree (tenant_id, owner_organization_id, resource_id, capability_id, routing_revision DESC);

CREATE INDEX genio_one_notification_subscriptions_subject_idx ON genio_one_notification_subscriptions USING btree (tenant_id, subject_id, updated_at DESC);

CREATE INDEX genio_one_organization_memberships_subject_idx ON genio_one_organization_memberships USING btree (tenant_id, subject_id, role);

CREATE INDEX genio_one_platform_runtime_aggregate_commands_pending_idx ON genio_one_platform_runtime_aggregate_commands USING btree (tenant_id, runtime_kind, runtime_id, state, created_at, command_id);

CREATE INDEX genio_one_platform_runtime_aggregate_reports_idx ON genio_one_platform_runtime_aggregate_report_history USING btree (tenant_id, runtime_kind, runtime_id, observed_at DESC, report_id);

CREATE INDEX genio_one_platform_runtime_registrations_target_idx ON genio_one_platform_runtime_registrations USING btree (tenant_id, target_id, status, runtime_id);

CREATE INDEX genio_one_policy_revisions_latest_idx ON genio_one_policy_revisions USING btree (tenant_id, policy_id, revision DESC);

CREATE INDEX genio_one_policy_revisions_scope_idx ON genio_one_policy_revisions USING gin (scope);

CREATE UNIQUE INDEX genio_one_price_catalog_one_current ON genio_one_price_catalog_versions USING btree (source) WHERE (status = 'CURRENT'::text);

CREATE INDEX genio_one_projection_chain_resource_idx ON genio_one_gateway_projections USING btree (tenant_id, resource_id, capability_id, policy_revision);

CREATE INDEX genio_one_provider_credential_profiles_latest_idx ON genio_one_provider_credential_profile_revisions USING btree (tenant_id, profile_id, revision DESC);

CREATE UNIQUE INDEX genio_one_publication_one_building_attempt_idx ON genio_one_publication_build_attempts USING btree (tenant_id, publication_id) WHERE (state = 'BUILDING'::text);

CREATE INDEX genio_one_publications_gateway_state_idx ON genio_one_publications USING btree (tenant_id, gateway_id, publication_state, publication_id);

CREATE UNIQUE INDEX genio_one_publications_one_active_idx ON genio_one_publications USING btree (tenant_id, resource_id) WHERE (publication_state = 'PUBLISHED'::text);

CREATE INDEX genio_one_publications_resource_idx ON genio_one_publications USING btree (tenant_id, resource_id, publication_state);

CREATE UNIQUE INDEX genio_one_resource_connections_mcp_namespace_unique ON genio_one_resource_connections USING btree (tenant_id, mcp_tool_namespace) WHERE (mcp_tool_namespace IS NOT NULL);

CREATE UNIQUE INDEX genio_one_resources_installation_service_unique ON genio_one_resources USING btree (tenant_id, service_kind) WHERE (installation_owned AND (service_kind IS NOT NULL));

CREATE INDEX genio_one_resources_owner_idx ON genio_one_resources USING btree (tenant_id, owner_organization_id, lifecycle);

CREATE INDEX genio_one_route_transitions_tuple_idx ON genio_one_model_route_transitions USING btree (tenant_id, subject_id, client_id, public_model_id, session_id, occurred_at);

CREATE INDEX genio_one_siem_delivery_due_idx ON genio_one_siem_deliveries USING btree (status, next_attempt_at);

CREATE INDEX genio_one_subjects_suspended_at_idx ON genio_one_subjects USING btree (tenant_id, suspended_at) WHERE (suspended_at IS NOT NULL);

CREATE INDEX genio_one_tenant_configuration_revisions_latest_idx ON genio_one_tenant_configuration_revisions USING btree (tenant_id, created_at DESC, revision DESC);

CREATE TRIGGER genio_one_gateway_authorization_audit_append_only BEFORE DELETE OR UPDATE ON genio_one_gateway_authorization_audit_events FOR EACH ROW EXECUTE FUNCTION genio_one_reject_authorization_audit_mutation();

CREATE TRIGGER genio_one_guard_installation_owned_resource BEFORE DELETE OR UPDATE ON genio_one_resources FOR EACH ROW EXECUTE FUNCTION genio_one_guard_installation_owned_resource();

ALTER TABLE ONLY genio_one_access_group_revisions
    ADD CONSTRAINT genio_one_access_group_revisions_tenant_id_access_group_id_fkey FOREIGN KEY (tenant_id, access_group_id) REFERENCES genio_one_access_groups(tenant_id, access_group_id);

ALTER TABLE ONLY genio_one_access_requests
    ADD CONSTRAINT genio_one_access_requests_tenant_id_owner_organization_id_fkey FOREIGN KEY (tenant_id, owner_organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id);

ALTER TABLE ONLY genio_one_access_requests
    ADD CONSTRAINT genio_one_access_requests_tenant_id_requester_subject_id_fkey FOREIGN KEY (tenant_id, requester_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_access_requests
    ADD CONSTRAINT genio_one_access_requests_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_access_requests
    ADD CONSTRAINT genio_one_access_requests_tenant_id_target_subject_id_fkey FOREIGN KEY (tenant_id, target_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_activity_outcome_attributions
    ADD CONSTRAINT genio_one_activity_outcome_attrib_tenant_id_correlation_id_fkey FOREIGN KEY (tenant_id, correlation_id) REFERENCES genio_one_gateway_activities(tenant_id, correlation_id);

ALTER TABLE ONLY genio_one_agent_delegation_revisions
    ADD CONSTRAINT genio_one_agent_delegation_re_tenant_id_principal_subject__fkey FOREIGN KEY (tenant_id, principal_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_agent_delegation_revisions
    ADD CONSTRAINT genio_one_agent_delegation_revi_tenant_id_agent_subject_id_fkey FOREIGN KEY (tenant_id, agent_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_agent_delegation_revisions
    ADD CONSTRAINT genio_one_agent_delegation_revisions_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_application_api_credentials
    ADD CONSTRAINT genio_one_application_api_cre_tenant_id_application_subjec_fkey FOREIGN KEY (tenant_id, application_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_application_api_credentials
    ADD CONSTRAINT genio_one_application_api_credent_tenant_id_application_id_fkey FOREIGN KEY (tenant_id, application_id) REFERENCES genio_one_applications(tenant_id, application_id);

ALTER TABLE ONLY genio_one_application_api_credentials
    ADD CONSTRAINT genio_one_application_api_credential_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_application_api_credentials
    ADD CONSTRAINT genio_one_application_api_credentials_predecessor_fk FOREIGN KEY (tenant_id, predecessor_credential_id) REFERENCES genio_one_application_api_credentials(tenant_id, credential_id);

ALTER TABLE ONLY genio_one_applications
    ADD CONSTRAINT genio_one_applications_tenant_id_owner_organization_id_fkey FOREIGN KEY (tenant_id, owner_organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id);

ALTER TABLE ONLY genio_one_applications
    ADD CONSTRAINT genio_one_applications_tenant_id_registered_by_subject_id_fkey FOREIGN KEY (tenant_id, registered_by_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_applications
    ADD CONSTRAINT genio_one_applications_tenant_id_subject_id_fkey FOREIGN KEY (tenant_id, subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_canonical_charges
    ADD CONSTRAINT genio_one_canonical_charges_tenant_id_invocation_id_fkey FOREIGN KEY (tenant_id, invocation_id) REFERENCES genio_one_canonical_invocation_accounting(tenant_id, invocation_id);

ALTER TABLE ONLY genio_one_connection_model_mappings
    ADD CONSTRAINT genio_one_connection_model_ma_tenant_id_resource_id_connec_fkey FOREIGN KEY (tenant_id, resource_id, connection_id) REFERENCES genio_one_resource_connections(tenant_id, resource_id, connection_id);

ALTER TABLE ONLY genio_one_connection_model_mappings
    ADD CONSTRAINT genio_one_connection_model_ma_tenant_id_resource_id_public_fkey FOREIGN KEY (tenant_id, resource_id, public_model_id) REFERENCES genio_one_public_models(tenant_id, resource_id, model_id);

ALTER TABLE ONLY genio_one_resource_connections
    ADD CONSTRAINT genio_one_connection_provider_credential_revision_fk FOREIGN KEY (tenant_id, provider_credential_profile_id, provider_credential_profile_revision) REFERENCES genio_one_provider_credential_profile_revisions(tenant_id, profile_id, revision);

ALTER TABLE ONLY genio_one_cost_valuations
    ADD CONSTRAINT genio_one_cost_valuations_tenant_id_charge_id_fkey FOREIGN KEY (tenant_id, charge_id) REFERENCES genio_one_canonical_charges(tenant_id, charge_id);

ALTER TABLE ONLY genio_one_endpoint_lifecycle_events
    ADD CONSTRAINT genio_one_endpoint_lifecycle_events_tenant_id_device_id_fkey FOREIGN KEY (tenant_id, device_id) REFERENCES genio_one_endpoint_devices(tenant_id, device_id);

ALTER TABLE ONLY genio_one_enforcement_chain_revisions
    ADD CONSTRAINT genio_one_enforcement_chain_revision_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_model_entitlements
    ADD CONSTRAINT genio_one_entitlements_resource_fk FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_execution_grant_request_revisions
    ADD CONSTRAINT genio_one_execution_grant_request_re_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_execution_grant_request_revisions
    ADD CONSTRAINT genio_one_execution_grant_request_rev_tenant_id_subject_id_fkey FOREIGN KEY (tenant_id, subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_execution_grants
    ADD CONSTRAINT genio_one_execution_grants_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_execution_grants
    ADD CONSTRAINT genio_one_execution_grants_tenant_id_subject_id_fkey FOREIGN KEY (tenant_id, subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_external_identity_bindings
    ADD CONSTRAINT genio_one_external_identity_bindings_tenant_id_subject_id_fkey FOREIGN KEY (tenant_id, subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_federation_assertion_uses
    ADD CONSTRAINT genio_one_federation_assertio_tenant_id_trust_id_trust_rev_fkey FOREIGN KEY (tenant_id, trust_id, trust_revision) REFERENCES genio_one_federation_trust_revisions(tenant_id, trust_id, revision);

ALTER TABLE ONLY genio_one_federation_exchange_events
    ADD CONSTRAINT genio_one_federation_exchange_tenant_id_trust_id_trust_rev_fkey FOREIGN KEY (tenant_id, trust_id, trust_revision) REFERENCES genio_one_federation_trust_revisions(tenant_id, trust_id, revision);

ALTER TABLE ONLY genio_one_federation_trust_heads
    ADD CONSTRAINT genio_one_federation_trust_he_tenant_id_trust_id_current_r_fkey FOREIGN KEY (tenant_id, trust_id, current_revision) REFERENCES genio_one_federation_trust_revisions(tenant_id, trust_id, revision);

ALTER TABLE ONLY genio_one_federation_trust_heads
    ADD CONSTRAINT genio_one_federation_trust_heads_tenant_id_application_id_fkey FOREIGN KEY (tenant_id, application_id) REFERENCES genio_one_applications(tenant_id, application_id);

ALTER TABLE ONLY genio_one_federation_trust_revisions
    ADD CONSTRAINT genio_one_federation_trust_re_tenant_id_application_subjec_fkey FOREIGN KEY (tenant_id, application_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_federation_trust_revisions
    ADD CONSTRAINT genio_one_federation_trust_revisi_tenant_id_application_id_fkey FOREIGN KEY (tenant_id, application_id) REFERENCES genio_one_applications(tenant_id, application_id);

ALTER TABLE ONLY genio_one_gateway_activities
    ADD CONSTRAINT genio_one_gateway_activities_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_gateway_diagnostic_settings
    ADD CONSTRAINT genio_one_gateway_diagnostic__tenant_id_updated_by_subject_fkey FOREIGN KEY (tenant_id, updated_by_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_gateway_policy_release_heads
    ADD CONSTRAINT genio_one_gateway_policy_rel_tenant_id_gateway_id_release_fkey1 FOREIGN KEY (tenant_id, gateway_id, release_id) REFERENCES genio_one_gateway_policy_releases(tenant_id, gateway_id, release_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_gateway_policy_release_manifests
    ADD CONSTRAINT genio_one_gateway_policy_rele_tenant_id_gateway_id_release_fkey FOREIGN KEY (tenant_id, gateway_id, release_id) REFERENCES genio_one_gateway_policy_releases(tenant_id, gateway_id, release_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_gateway_policy_release_projections
    ADD CONSTRAINT genio_one_gateway_policy_rele_tenant_id_projection_id_publ_fkey FOREIGN KEY (tenant_id, projection_id, publication_id, projection_revision, projection_digest) REFERENCES genio_one_gateway_projections(tenant_id, projection_id, publication_id, revision, digest);

ALTER TABLE ONLY genio_one_gateway_policy_release_projections
    ADD CONSTRAINT genio_one_gateway_policy_release_proj_tenant_id_release_id_fkey FOREIGN KEY (tenant_id, release_id) REFERENCES genio_one_gateway_policy_releases(tenant_id, release_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_gateway_projections
    ADD CONSTRAINT genio_one_gateway_projections_publication_fk FOREIGN KEY (tenant_id, publication_id, endpoint_revision, resource_revision) REFERENCES genio_one_publications(tenant_id, publication_id, endpoint_revision, resource_revision);

ALTER TABLE ONLY genio_one_gateway_projections
    ADD CONSTRAINT genio_one_gateway_projections_tenant_id_resource_id_capabi_fkey FOREIGN KEY (tenant_id, resource_id, capability_id, policy_revision) REFERENCES genio_one_enforcement_chain_revisions(tenant_id, resource_id, capability_id, one_policy_revision);

ALTER TABLE ONLY genio_one_gateway_projections
    ADD CONSTRAINT genio_one_gateway_projections_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_gateway_registrations
    ADD CONSTRAINT genio_one_gateway_registratio_tenant_id_registered_by_subj_fkey FOREIGN KEY (tenant_id, registered_by_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_mcp_oauth_bindings
    ADD CONSTRAINT genio_one_mcp_oauth_bindings_tenant_id_resource_id_connect_fkey FOREIGN KEY (tenant_id, resource_id, connection_id) REFERENCES genio_one_resource_connections(tenant_id, resource_id, connection_id) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_mcp_oauth_sessions
    ADD CONSTRAINT genio_one_mcp_oauth_sessions_tenant_id_resource_id_connect_fkey FOREIGN KEY (tenant_id, resource_id, connection_id) REFERENCES genio_one_resource_connections(tenant_id, resource_id, connection_id) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_model_entitlements
    ADD CONSTRAINT genio_one_model_entitlements_tenant_id_public_model_id_fkey FOREIGN KEY (tenant_id, public_model_id) REFERENCES genio_one_public_models(tenant_id, model_id);

ALTER TABLE ONLY genio_one_model_price_catalog
    ADD CONSTRAINT genio_one_model_price_catalog_source_source_version_fkey FOREIGN KEY (source, source_version) REFERENCES genio_one_price_catalog_versions(source, source_version) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_model_route_transition_tenant_id_public_model_id_fkey FOREIGN KEY (tenant_id, public_model_id) REFERENCES genio_one_public_models(tenant_id, model_id);

ALTER TABLE ONLY genio_one_model_routing_policies
    ADD CONSTRAINT genio_one_model_routing_polic_tenant_id_owner_organization_fkey FOREIGN KEY (tenant_id, owner_organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id);

ALTER TABLE ONLY genio_one_model_routing_policies
    ADD CONSTRAINT genio_one_model_routing_policies_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_public_models
    ADD CONSTRAINT genio_one_models_resource_fk FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_notification_subscriptions
    ADD CONSTRAINT genio_one_notification_subscr_tenant_id_created_by_subject_fkey FOREIGN KEY (tenant_id, created_by_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_notification_subscriptions
    ADD CONSTRAINT genio_one_notification_subscriptions_tenant_id_subject_id_fkey FOREIGN KEY (tenant_id, subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_organization_membership_sources
    ADD CONSTRAINT genio_one_organization_membersh_tenant_id_organization_id_fkey1 FOREIGN KEY (tenant_id, organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_organization_memberships
    ADD CONSTRAINT genio_one_organization_membershi_tenant_id_organization_id_fkey FOREIGN KEY (tenant_id, organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_organization_memberships
    ADD CONSTRAINT genio_one_organization_memberships_tenant_id_subject_id_fkey FOREIGN KEY (tenant_id, subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_personal_password_credentials
    ADD CONSTRAINT genio_one_personal_password_c_tenant_id_resource_id_connec_fkey FOREIGN KEY (tenant_id, resource_id, connection_id) REFERENCES genio_one_resource_connections(tenant_id, resource_id, connection_id) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_observed_states
    ADD CONSTRAINT genio_one_platform_runtime_a_tenant_id_runtime_kind_runti_fkey1 FOREIGN KEY (tenant_id, runtime_kind, runtime_id) REFERENCES genio_one_platform_runtime_registrations(tenant_id, runtime_kind, runtime_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_observed_states
    ADD CONSTRAINT genio_one_platform_runtime_a_tenant_id_runtime_kind_runti_fkey2 FOREIGN KEY (tenant_id, runtime_kind, runtime_id, command_id) REFERENCES genio_one_platform_runtime_aggregate_commands(tenant_id, runtime_kind, runtime_id, command_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_report_history
    ADD CONSTRAINT genio_one_platform_runtime_a_tenant_id_runtime_kind_runti_fkey3 FOREIGN KEY (tenant_id, runtime_kind, runtime_id) REFERENCES genio_one_platform_runtime_registrations(tenant_id, runtime_kind, runtime_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_report_history
    ADD CONSTRAINT genio_one_platform_runtime_a_tenant_id_runtime_kind_runti_fkey4 FOREIGN KEY (tenant_id, runtime_kind, runtime_id, command_id) REFERENCES genio_one_platform_runtime_aggregate_commands(tenant_id, runtime_kind, runtime_id, command_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_platform_runtime_aggregate_commands
    ADD CONSTRAINT genio_one_platform_runtime_ag_tenant_id_runtime_kind_runti_fkey FOREIGN KEY (tenant_id, runtime_kind, runtime_id) REFERENCES genio_one_platform_runtime_registrations(tenant_id, runtime_kind, runtime_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_platform_runtime_capabilities
    ADD CONSTRAINT genio_one_platform_runtime_ca_tenant_id_runtime_kind_runti_fkey FOREIGN KEY (tenant_id, runtime_kind, runtime_id) REFERENCES genio_one_platform_runtime_registrations(tenant_id, runtime_kind, runtime_id) ON DELETE RESTRICT;

ALTER TABLE ONLY genio_one_platform_runtime_session_leases
    ADD CONSTRAINT genio_one_platform_runtime_se_tenant_id_runtime_kind_runti_fkey FOREIGN KEY (tenant_id, runtime_kind, runtime_id) REFERENCES genio_one_platform_runtime_registrations(tenant_id, runtime_kind, runtime_id);

ALTER TABLE ONLY genio_one_provider_credential_profile_revisions
    ADD CONSTRAINT genio_one_provider_credential_tenant_id_owner_organization_fkey FOREIGN KEY (tenant_id, owner_organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id);

ALTER TABLE ONLY genio_one_publication_build_attempts
    ADD CONSTRAINT genio_one_publication_build_attem_tenant_id_publication_id_fkey FOREIGN KEY (tenant_id, publication_id) REFERENCES genio_one_publications(tenant_id, publication_id);

ALTER TABLE ONLY genio_one_publications
    ADD CONSTRAINT genio_one_publications_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_resource_connections
    ADD CONSTRAINT genio_one_resource_connection_tenant_id_provider_profile_i_fkey FOREIGN KEY (tenant_id, provider_profile_id) REFERENCES genio_one_provider_profiles(tenant_id, profile_id);

ALTER TABLE ONLY genio_one_resource_connections
    ADD CONSTRAINT genio_one_resource_connections_mcp_tool_selection_source_fk FOREIGN KEY (tenant_id, mcp_tool_selection_operation_id) REFERENCES genio_one_mcp_discovery_operations(tenant_id, operation_id);

ALTER TABLE ONLY genio_one_resource_connections
    ADD CONSTRAINT genio_one_resource_connections_tenant_id_resource_id_fkey FOREIGN KEY (tenant_id, resource_id) REFERENCES genio_one_resources(tenant_id, resource_id);

ALTER TABLE ONLY genio_one_resources
    ADD CONSTRAINT genio_one_resources_tenant_id_owner_organization_id_fkey FOREIGN KEY (tenant_id, owner_organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id);

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_route_transition_from_connection_fk FOREIGN KEY (tenant_id, resource_id, from_connection_id) REFERENCES genio_one_resource_connections(tenant_id, resource_id, connection_id);

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_route_transition_from_mapping_fk FOREIGN KEY (tenant_id, resource_id, from_mapping_id) REFERENCES genio_one_connection_model_mappings(tenant_id, resource_id, mapping_id);

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_route_transition_from_model_fk FOREIGN KEY (tenant_id, resource_id, from_model_id) REFERENCES genio_one_public_models(tenant_id, resource_id, model_id);

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_route_transition_public_model_fk FOREIGN KEY (tenant_id, resource_id, public_model_id) REFERENCES genio_one_public_models(tenant_id, resource_id, model_id);

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_route_transition_to_connection_fk FOREIGN KEY (tenant_id, resource_id, to_connection_id) REFERENCES genio_one_resource_connections(tenant_id, resource_id, connection_id);

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_route_transition_to_mapping_fk FOREIGN KEY (tenant_id, resource_id, to_mapping_id) REFERENCES genio_one_connection_model_mappings(tenant_id, resource_id, mapping_id);

ALTER TABLE ONLY genio_one_model_route_transitions
    ADD CONSTRAINT genio_one_route_transition_to_model_fk FOREIGN KEY (tenant_id, resource_id, to_model_id) REFERENCES genio_one_public_models(tenant_id, resource_id, model_id);

ALTER TABLE ONLY genio_one_self_service_configuration_projections
    ADD CONSTRAINT genio_one_self_service_configuration_pr_tenant_id_revision_fkey FOREIGN KEY (tenant_id, revision) REFERENCES genio_one_tenant_configuration_revisions(tenant_id, revision);

ALTER TABLE ONLY genio_one_siem_destinations
    ADD CONSTRAINT genio_one_siem_destinations_tenant_id_configured_by_subjec_fkey FOREIGN KEY (tenant_id, configured_by_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_subject_roles
    ADD CONSTRAINT genio_one_subject_roles_tenant_id_subject_id_fkey FOREIGN KEY (tenant_id, subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id) ON DELETE CASCADE;

ALTER TABLE ONLY genio_one_tenant_configuration_revisions
    ADD CONSTRAINT genio_one_tenant_configuratio_tenant_id_created_by_subject_fkey FOREIGN KEY (tenant_id, created_by_subject_id) REFERENCES genio_one_subjects(tenant_id, subject_id);

ALTER TABLE ONLY genio_one_usage_policy_revisions
    ADD CONSTRAINT genio_one_usage_policy_revisi_tenant_id_owner_organization_fkey FOREIGN KEY (tenant_id, owner_organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id);

ALTER TABLE ONLY genio_one_usage_quantities
    ADD CONSTRAINT genio_one_usage_quantities_tenant_id_invocation_id_fkey FOREIGN KEY (tenant_id, invocation_id) REFERENCES genio_one_canonical_invocation_accounting(tenant_id, invocation_id);

ALTER TABLE ONLY genio_one_use_cases
    ADD CONSTRAINT genio_one_use_cases_tenant_id_organization_id_fkey FOREIGN KEY (tenant_id, organization_id) REFERENCES genio_one_organizations(tenant_id, organization_id);

