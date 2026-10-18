ALTER TABLE genio_one_application_api_credentials
  DROP CONSTRAINT genio_one_application_api_credentials_kind_check,
  DROP CONSTRAINT genio_one_application_api_credentials_oauth_audience_check,
  DROP CONSTRAINT genio_one_application_api_credentials_oauth_client_id_check,
  DROP CONSTRAINT genio_one_application_api_credentials_oauth_issuer_check,
  DROP CONSTRAINT genio_one_application_api_credentials_oauth_scope_check,
  ALTER COLUMN resource_id DROP NOT NULL,
  ALTER COLUMN capability_id DROP NOT NULL,
  ALTER COLUMN oauth_client_id DROP NOT NULL,
  ALTER COLUMN oauth_issuer DROP NOT NULL,
  ALTER COLUMN oauth_audience DROP NOT NULL,
  ALTER COLUMN oauth_scope DROP NOT NULL,
  ADD COLUMN display_name text,
  ADD COLUMN scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN api_key_hash text,
  ADD COLUMN api_key_prefix text,
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT genio_one_application_api_credentials_scopes_check CHECK (jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) <= 64),
  ADD CONSTRAINT genio_one_application_api_credentials_target_check CHECK ((resource_id IS NULL) = (capability_id IS NULL)),
  ADD CONSTRAINT genio_one_application_api_credentials_kind_check CHECK (
    (kind = 'OAUTH2' AND resource_id IS NOT NULL AND capability_id IS NOT NULL
      AND oauth_client_id IS NOT NULL AND length(trim(oauth_client_id)) > 0
      AND oauth_issuer IS NOT NULL AND length(trim(oauth_issuer)) > 0
      AND oauth_audience IS NOT NULL AND length(trim(oauth_audience)) > 0
      AND oauth_scope IS NOT NULL AND length(trim(oauth_scope)) > 0
      AND display_name IS NULL AND api_key_hash IS NULL AND api_key_prefix IS NULL AND expires_at IS NULL)
    OR
    (kind = 'API_KEY' AND oauth_client_id IS NULL AND oauth_issuer IS NULL
      AND oauth_audience IS NULL AND oauth_scope IS NULL AND identity_provider_id IS NULL AND external_subject_id IS NULL
      AND display_name IS NOT NULL AND length(trim(display_name)) BETWEEN 1 AND 256
      AND api_key_hash IS NOT NULL AND api_key_hash ~ '^[0-9a-f]{64}$'
      AND api_key_prefix IS NOT NULL AND api_key_prefix ~ '^genio_app_[A-Za-z0-9_-]{8,10}$'
      AND jsonb_array_length(scopes) > 0 AND expires_at IS NOT NULL AND expires_at > created_at
      AND (valid_until IS NULL OR valid_until <= expires_at))
  );

DROP INDEX genio_one_application_api_credentials_active_idx;
DROP INDEX genio_one_application_api_credentials_generation_idx;

CREATE UNIQUE INDEX genio_one_application_api_credentials_active_idx
  ON genio_one_application_api_credentials (tenant_id, application_id, resource_id, capability_id, kind)
  NULLS NOT DISTINCT WHERE state = 'ACTIVE';

CREATE UNIQUE INDEX genio_one_application_api_credentials_generation_idx
  ON genio_one_application_api_credentials (tenant_id, application_id, resource_id, capability_id, kind, generation)
  NULLS NOT DISTINCT;

CREATE UNIQUE INDEX genio_one_application_api_credentials_hash_idx
  ON genio_one_application_api_credentials (api_key_hash) WHERE api_key_hash IS NOT NULL;
