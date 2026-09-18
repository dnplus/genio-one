alter table genio_one_resources
  add column if not exists extension_metadata jsonb;

alter table genio_one_resources
  drop constraint if exists genio_one_resources_extension_metadata_object;

alter table genio_one_resources
  add constraint genio_one_resources_extension_metadata_object
  check (extension_metadata is null or jsonb_typeof(extension_metadata) = 'object');
