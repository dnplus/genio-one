#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/local/go/bin:/usr/local/bin:${PATH}"

infra_root="${E2B_INFRA_ROOT:-/opt/genioone/e2b-infra}"
local_dev="${infra_root}/packages/local-dev"
node_id="$(hostname)"

cd "${local_dev}"
make clickhouse-config-generated.xml
docker compose up -d postgres redis clickhouse

for attempt in $(seq 1 120); do
  if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1 &&
    curl --fail --silent http://127.0.0.1:8123/ping >/dev/null; then
    break
  fi
  if [[ "${attempt}" == "120" ]]; then
    echo "E2B_LOCAL_DATA_STORES_NOT_READY" >&2
    exit 1
  fi
  sleep 1
done

make -C "${infra_root}/packages/db" migrate-local
make -C "${infra_root}/packages/clickhouse" migrate-local
go run "${local_dev}/seed-local-database.go"
docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "update public.tiers set disk_mb = 16384, default_free_disk_size_mb = 16384, max_disk_size_mb = 25600 where id = 'base_v1'"

make -C "${infra_root}/packages/envd" build
make -C "${infra_root}/packages/api" build
make -C "${infra_root}/packages/client-proxy" build
make -C "${infra_root}/packages/orchestrator" fetch-busybox
make -C "${infra_root}/packages/orchestrator" build-local

firecracker_dir="${infra_root}/packages/fc-versions/builds/v1.14-0.2.0/amd64"
kernel_dir="${infra_root}/packages/fc-kernels/vmlinux-6.1.158/amd64"
install -d "${firecracker_dir}" "${kernel_dir}"
if [[ ! -x "${firecracker_dir}/firecracker" ]]; then
  curl --fail --location --retry 3 \
    https://storage.googleapis.com/e2b-artifact-binaries/firecrackers/v1.14-0.2.0/amd64/firecracker \
    --output "${firecracker_dir}/firecracker"
  chmod 0755 "${firecracker_dir}/firecracker"
fi
if [[ ! -f "${kernel_dir}/vmlinux.bin" ]]; then
  curl --fail --location --retry 3 \
    https://storage.googleapis.com/e2b-artifact-binaries/kernels/vmlinux-6.1.158/amd64/vmlinux.bin \
    --output "${kernel_dir}/vmlinux.bin"
  chmod 0644 "${kernel_dir}/vmlinux.bin"
fi
install -d \
  "${infra_root}/packages/api/.data/test-volume" \
  "${infra_root}/packages/orchestrator/.data/test-volume"

systemctl stop genio-e2b-api.service genio-e2b-client-proxy.service genio-e2b-orchestrator.service 2>/dev/null || true
systemd-run --unit=genio-e2b-api --collect \
  --property="WorkingDirectory=${infra_root}/packages/api" \
  --property="EnvironmentFile=${infra_root}/packages/api/.env.local" \
  --setenv="NODE_ID=${node_id}" \
  "${infra_root}/packages/api/bin/api" --port 3000
systemd-run --unit=genio-e2b-client-proxy --collect \
  --property="WorkingDirectory=${infra_root}/packages/client-proxy" \
  --property="EnvironmentFile=${infra_root}/packages/client-proxy/.env.local" \
  --setenv="NODE_ID=${node_id}" \
  "${infra_root}/packages/client-proxy/bin/client-proxy"
systemd-run --unit=genio-e2b-orchestrator --collect \
  --property="WorkingDirectory=${infra_root}/packages/orchestrator" \
  --property="EnvironmentFile=${infra_root}/packages/orchestrator/.env.local" \
  --property=LimitMEMLOCK=infinity \
  --setenv="NODE_ID=${node_id}" \
  --setenv="ALLOW_SANDBOX_INTERNAL_CIDRS=${E2B_ALLOW_SANDBOX_INTERNAL_CIDRS:-169.254.0.22/32}" \
  "${infra_root}/packages/orchestrator/bin/orchestrator"

for endpoint in http://127.0.0.1:3000/health http://127.0.0.1:3003/health http://127.0.0.1:5008/health; do
  for attempt in $(seq 1 120); do
    if curl --fail --silent "${endpoint}" >/dev/null; then
      break
    fi
    if [[ "${attempt}" == "120" ]]; then
      echo "E2B_SERVICE_NOT_READY ${endpoint}" >&2
      exit 1
    fi
    sleep 1
  done
done

printf '%s\n' 'E2B_LOCAL_CONTROL_PLANE_READY'
