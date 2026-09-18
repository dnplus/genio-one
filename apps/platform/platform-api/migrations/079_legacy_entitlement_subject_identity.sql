insert into genio_one_subjects (
  tenant_id,
  subject_id,
  kind,
  display_name
)
select distinct
  entitlement.tenant_id,
  entitlement.subject_id,
  'PERSON',
  entitlement.subject_id
from genio_one_model_entitlements entitlement
left join genio_one_subjects subject
  on subject.tenant_id = entitlement.tenant_id
 and subject.subject_id = entitlement.subject_id
where entitlement.subject_id is not null
  and subject.subject_id is null
on conflict (tenant_id, subject_id) do nothing;
