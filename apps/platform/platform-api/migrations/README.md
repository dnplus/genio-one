# Platform database baseline

`001_platform_baseline.sql` is the complete schema for a new GenioOne Platform database.

Databases created from the former `001`–`105` migration chain are unsupported and must be rebuilt. The migration runner compares the exact migration name and checksum and intentionally rejects that earlier history.

New schema changes start at migration `002`. Do not add data conversion or compatibility SQL for the retired chain.

`021_shared_memory_confirmation.sql` adds nullable confirmation timestamps to shared memory and nullable reviewer identity to mutation metadata. Existing rows remain unconfirmed. Run the migration runner before deploying the shared memory confirmation writer; it applies schema changes and migration history in one transaction.

Application rollback to a release without shared memory confirmation leaves these additive columns and stored review metadata in place. Do not remove the columns or modify an applied migration checksum. After confirmation has been written, writers that update shared memory must clear or replace its confirmation timestamp together with the record revision.
