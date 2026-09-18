-- Gateway release v2 carries one signed, runtime-neutral model-routing
-- artifact beside the authorization and processor artifacts.  There is no
-- safe v1 value to infer for existing aggregate releases, so fail closed
-- instead of silently creating a mixed-format release history.

do $$
begin
  if exists (select 1 from genio_one_gateway_policy_releases limit 1) then
    raise exception
      'genio_one_gateway_policy_releases contains v1 rows; run an explicit Gateway release v2 converter before migration 012';
  end if;
end
$$;

alter table genio_one_gateway_policy_releases
  add column gateway_routing_artifact bytea not null,
  add column gateway_routing_artifact_sha256 text not null,
  add column gateway_routing_artifact_key_id text not null;

alter table genio_one_gateway_policy_releases
  add constraint genio_one_gateway_policy_releases_routing_artifact_nonempty_check
    check (octet_length(gateway_routing_artifact) > 0),
  add constraint genio_one_gateway_policy_releases_routing_artifact_sha256_check
    check (gateway_routing_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  add constraint genio_one_gateway_policy_releases_routing_artifact_key_id_check
    check (length(trim(gateway_routing_artifact_key_id)) > 0);
