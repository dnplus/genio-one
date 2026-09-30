ALTER TABLE genio_one_access_requests
    ADD COLUMN IF NOT EXISTS request_correlation_id text,
    ADD COLUMN IF NOT EXISTS decision_correlation_id text;

CREATE INDEX IF NOT EXISTS genio_one_access_requests_request_correlation_idx
    ON genio_one_access_requests (tenant_id, request_correlation_id)
    WHERE request_correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS genio_one_access_requests_decision_correlation_idx
    ON genio_one_access_requests (tenant_id, decision_correlation_id)
    WHERE decision_correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS genio_one_model_entitlements_revocation_correlation_idx
    ON genio_one_model_entitlements (tenant_id, revocation_correlation_id)
    WHERE revocation_correlation_id IS NOT NULL;
