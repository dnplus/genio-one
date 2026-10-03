ALTER TABLE genio_one_endpoint_lifecycle_events
  ADD COLUMN old_credential_id text,
  ADD COLUMN new_credential_id text;

ALTER TABLE genio_one_endpoint_lifecycle_events
  DROP CONSTRAINT genio_one_endpoint_lifecycle_events_check,
  ADD CONSTRAINT genio_one_endpoint_lifecycle_events_check CHECK (
    (kind = 'ENROLLED' AND reason IS NULL AND old_credential_id IS NULL AND new_credential_id IS NULL)
    OR (kind = 'REVOKED' AND reason IS NOT NULL AND length(trim(reason)) > 0
      AND old_credential_id IS NULL AND new_credential_id IS NULL)
    OR (kind = 'ROTATED' AND reason IS NULL AND old_credential_id IS NOT NULL AND new_credential_id IS NOT NULL
      AND length(trim(old_credential_id)) > 0 AND length(trim(new_credential_id)) > 0
      AND old_credential_id <> new_credential_id)
  ),
  DROP CONSTRAINT genio_one_endpoint_lifecycle_events_kind_check,
  ADD CONSTRAINT genio_one_endpoint_lifecycle_events_kind_check CHECK (kind IN ('ENROLLED', 'ROTATED', 'REVOKED'));

ALTER TABLE genio_one_endpoint_lifecycle_events
  DROP CONSTRAINT genio_one_endpoint_lifecycle_event_tenant_id_device_id_kind_key;

CREATE UNIQUE INDEX genio_one_endpoint_lifecycle_terminal_kind_idx
  ON genio_one_endpoint_lifecycle_events (tenant_id, device_id, kind)
  WHERE kind IN ('ENROLLED', 'REVOKED');

CREATE UNIQUE INDEX genio_one_endpoint_lifecycle_events_rotated_old_credential_idx
  ON genio_one_endpoint_lifecycle_events (tenant_id, old_credential_id)
  WHERE kind = 'ROTATED';
