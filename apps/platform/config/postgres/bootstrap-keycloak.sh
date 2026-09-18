#!/bin/sh
set -eu

case "${GENIO_ONE_KEYCLOAK_POSTGRES_DB}" in
  *[!a-zA-Z0-9_]*) echo "invalid Keycloak PostgreSQL database name" >&2; exit 2 ;;
esac
case "${GENIO_ONE_KEYCLOAK_POSTGRES_USER}" in
  *[!a-zA-Z0-9_]*) echo "invalid Keycloak PostgreSQL role name" >&2; exit 2 ;;
esac

export PGPASSWORD="${GENIO_ONE_POSTGRES_PASSWORD}"

psql \
  --host postgres \
  --username "${GENIO_ONE_POSTGRES_USER}" \
  --dbname "${GENIO_ONE_POSTGRES_DB}" \
  --set ON_ERROR_STOP=1 \
  --set keycloak_role="${GENIO_ONE_KEYCLOAK_POSTGRES_USER}" \
  --set keycloak_password="${GENIO_ONE_KEYCLOAK_POSTGRES_PASSWORD}" \
  --set keycloak_database="${GENIO_ONE_KEYCLOAK_POSTGRES_DB}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'keycloak_role', :'keycloak_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = :'keycloak_role')
\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'keycloak_role', :'keycloak_password')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'keycloak_database', :'keycloak_role')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = :'keycloak_database')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'keycloak_database', :'keycloak_role')
\gexec
SQL
