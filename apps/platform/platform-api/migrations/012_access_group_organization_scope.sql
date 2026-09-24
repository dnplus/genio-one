ALTER TABLE genio_one_access_groups
  ADD COLUMN IF NOT EXISTS organization_id text;

ALTER TABLE genio_one_access_group_revisions
  ADD COLUMN IF NOT EXISTS organization_id text;

UPDATE genio_one_access_groups
   SET organization_id = nullif(value ->> 'organization_id', '')
 WHERE organization_id IS DISTINCT FROM nullif(value ->> 'organization_id', '');

UPDATE genio_one_access_group_revisions
   SET organization_id = nullif(value ->> 'organization_id', '')
 WHERE organization_id IS DISTINCT FROM nullif(value ->> 'organization_id', '');

UPDATE genio_one_access_groups
   SET value = jsonb_set(
     value,
     '{organization_id}',
     CASE WHEN organization_id IS NULL THEN 'null'::jsonb ELSE to_jsonb(organization_id) END,
     true
   )
 WHERE NOT (value ? 'organization_id');

UPDATE genio_one_access_group_revisions
   SET value = jsonb_set(
     value,
     '{organization_id}',
     CASE WHEN organization_id IS NULL THEN 'null'::jsonb ELSE to_jsonb(organization_id) END,
     true
   )
 WHERE NOT (value ? 'organization_id');

ALTER TABLE genio_one_access_groups
  ADD CONSTRAINT genio_one_access_groups_organization_id_check
  CHECK (organization_id IS NULL OR length(trim(organization_id)) > 0);

ALTER TABLE genio_one_access_group_revisions
  ADD CONSTRAINT genio_one_access_group_revisions_organization_id_check
  CHECK (organization_id IS NULL OR length(trim(organization_id)) > 0);

ALTER TABLE genio_one_access_groups
  ADD CONSTRAINT genio_one_access_groups_value_organization_id_check
  CHECK ((value ->> 'organization_id') IS NOT DISTINCT FROM organization_id);

ALTER TABLE genio_one_access_group_revisions
  ADD CONSTRAINT genio_one_access_group_revisions_value_organization_id_check
  CHECK ((value ->> 'organization_id') IS NOT DISTINCT FROM organization_id);

ALTER TABLE genio_one_access_groups
  ADD CONSTRAINT genio_one_access_groups_tenant_id_organization_id_fkey
  FOREIGN KEY (tenant_id, organization_id)
  REFERENCES genio_one_organizations(tenant_id, organization_id);

ALTER TABLE genio_one_access_group_revisions
  ADD CONSTRAINT genio_one_access_group_revisions_tenant_id_organization_id_fkey
  FOREIGN KEY (tenant_id, organization_id)
  REFERENCES genio_one_organizations(tenant_id, organization_id);

CREATE INDEX IF NOT EXISTS genio_one_access_groups_owner_idx
  ON genio_one_access_groups (tenant_id, organization_id, access_group_id);
