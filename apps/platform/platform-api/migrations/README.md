# Platform database baseline

`001_platform_baseline.sql` is the complete schema for a new GenioOne Platform database.

Databases created from the former `001`–`105` migration chain are unsupported and must be rebuilt. The migration runner compares the exact migration name and checksum and intentionally rejects that earlier history.

New schema changes start at migration `002`. Do not add data conversion or compatibility SQL for the retired chain.
