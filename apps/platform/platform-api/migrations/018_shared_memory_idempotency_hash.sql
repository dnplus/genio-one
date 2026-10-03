ALTER TABLE genio_one_shared_memory_mutations
    ADD COLUMN idempotency_key_digest text;

UPDATE genio_one_shared_memory_mutations
   SET idempotency_key_digest = CASE
         WHEN idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           THEN encode(sha256(convert_to(idempotency_key, 'UTF8')), 'hex')
         ELSE md5(random()::text || clock_timestamp()::text || txid_current()::text || mutation_id)
           || md5(random()::text || clock_timestamp()::text || txid_current()::text || mutation_id)
       END,
       request_digest = md5(random()::text || clock_timestamp()::text || txid_current()::text || mutation_id)
                     || md5(random()::text || clock_timestamp()::text || txid_current()::text || mutation_id);

ALTER TABLE genio_one_shared_memory_mutations
    DROP CONSTRAINT genio_one_shared_memory_mutations_idempotency_unique;

ALTER TABLE genio_one_shared_memory_mutations
    DROP COLUMN idempotency_key;

ALTER TABLE genio_one_shared_memory_mutations
    ALTER COLUMN idempotency_key_digest SET NOT NULL;

ALTER TABLE genio_one_shared_memory_mutations
    ADD CONSTRAINT genio_one_shared_memory_mutations_idempotency_digest_check
        CHECK (idempotency_key_digest ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT genio_one_shared_memory_mutations_idempotency_digest_unique
        UNIQUE (tenant_id, scope_target_key, idempotency_key_digest);
