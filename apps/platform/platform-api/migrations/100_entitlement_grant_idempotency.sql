alter table genio_one_model_entitlements
  add column if not exists grant_idempotency_key text,
  add column if not exists grant_request_digest text;

create unique index genio_one_entitlement_grant_idempotency_key_unique
  on genio_one_model_entitlements (tenant_id, grant_idempotency_key)
  where grant_idempotency_key is not null;
