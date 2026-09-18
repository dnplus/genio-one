#!/bin/sh
set -eu

case "${GENIO_ONE_GRAVITEE_POSTGRES_DB}" in
  *[!a-zA-Z0-9_]*) echo "invalid Gravitee PostgreSQL database name" >&2; exit 2 ;;
esac
case "${GENIO_ONE_GRAVITEE_POSTGRES_USER}" in
  *[!a-zA-Z0-9_]*) echo "invalid Gravitee PostgreSQL role name" >&2; exit 2 ;;
esac

export PGPASSWORD="${GENIO_ONE_POSTGRES_PASSWORD}"

psql \
  --host postgres \
  --username "${GENIO_ONE_POSTGRES_USER}" \
  --dbname "${GENIO_ONE_POSTGRES_DB}" \
  --set ON_ERROR_STOP=1 \
  --set gravitee_role="${GENIO_ONE_GRAVITEE_POSTGRES_USER}" \
  --set gravitee_password="${GENIO_ONE_GRAVITEE_POSTGRES_PASSWORD}" \
  --set gravitee_database="${GENIO_ONE_GRAVITEE_POSTGRES_DB}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'gravitee_role', :'gravitee_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = :'gravitee_role')
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'gravitee_role', :'gravitee_password')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'gravitee_database', :'gravitee_role')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = :'gravitee_database')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'gravitee_database', :'gravitee_role')
\gexec
SQL
