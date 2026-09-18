#!/usr/bin/env bash
set -euo pipefail
export PATH="${HOME}/.local/share/mise/shims:${PATH}"
infra="${HOME}/genio-e2b-infra"
logs=/tmp/e2b-start-logs
mkdir -p "${logs}"
node_id="$(hostname)"

need() { [[ -x "$1" ]] || { echo "MISSING $1" >&2; exit 1; }; }
need "${infra}/packages/api/bin/api"
need "${infra}/packages/client-proxy/bin/client-proxy"
need "${infra}/packages/orchestrator/bin/orchestrator"
mkdir -p \
  "${infra}/packages/orchestrator/tmp/fc-vm" \
  "${infra}/packages/orchestrator/tmp/local-build-cache" \
  "${infra}/packages/orchestrator/tmp/local-template-storage" \
  "${infra}/packages/orchestrator/tmp/sandbox-cache-dir" \
  "${infra}/packages/orchestrator/.data/test-volume" \
  "${HOME}/.data/test-volume"

for pidfile in "${logs}/api.pid" "${logs}/client-proxy.pid" "${logs}/orchestrator.pid"; do
  if [[ -f "${pidfile}" ]]; then
    kill "$(cat "${pidfile}")" 2>/dev/null || true
    rm -f "${pidfile}"
  fi
done
sleep 1

cd "${infra}/packages/local-dev"
docker compose up -d postgres redis clickhouse
for _ in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
POSTGRES_CONNECTION_STRING="postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable" \
  go run seed-local-database.go || true

set -a
# shellcheck disable=SC1091
source "${infra}/packages/api/.env.local"
set +a
nohup env NODE_ID="${node_id}" "${infra}/packages/api/bin/api" --port 3000 \
  >"${logs}/api.log" 2>&1 &
echo $! >"${logs}/api.pid"

set -a
# shellcheck disable=SC1091
source "${infra}/packages/client-proxy/.env.local"
set +a
nohup env NODE_ID="${node_id}" "${infra}/packages/client-proxy/bin/client-proxy" \
  >"${logs}/client-proxy.log" 2>&1 &
echo $! >"${logs}/client-proxy.pid"

set -a
# shellcheck disable=SC1091
source "${infra}/packages/orchestrator/.env.local"
set +a
nohup env NODE_ID="${node_id}" ALLOW_SANDBOX_INTERNAL_CIDRS="${E2B_ALLOW_SANDBOX_INTERNAL_CIDRS:-169.254.0.22/32}" \
  "${infra}/packages/orchestrator/bin/orchestrator" \
  >"${logs}/orchestrator.log" 2>&1 &
echo $! >"${logs}/orchestrator.pid"

for endpoint in http://127.0.0.1:3000/health http://127.0.0.1:3003/health http://127.0.0.1:5008/health; do
  ok=0
  for _ in $(seq 1 60); do
    if curl --fail --silent "${endpoint}" >/dev/null; then ok=1; break; fi
    sleep 1
  done
  if [[ "${ok}" != 1 ]]; then
    echo "E2B_SERVICE_NOT_READY ${endpoint}" >&2
    tail -40 "${logs}"/*.log >&2 || true
    exit 1
  fi
done
echo E2B_LOCAL_CONTROL_PLANE_READY
ss -lptn | rg "3000|3003|5008" || true
