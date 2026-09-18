alter table tenant_control_plane_authority
  alter column authority set default 'TYPESCRIPT';

update tenant_control_plane_authority
   set authority = 'TYPESCRIPT', row_revision = row_revision + 1, updated_at = now()
 where authority = 'RUST';
