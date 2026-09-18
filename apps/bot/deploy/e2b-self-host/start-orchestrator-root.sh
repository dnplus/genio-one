#!/usr/bin/env bash
# Run on 156 as root. API and client-proxy stay unprivileged.
set -euo pipefail
export PATH="/home/dnplus/.local/share/mise/shims:${PATH}"
cd /home/dnplus/genio-e2b-infra/packages/orchestrator
mkdir -p tmp/fc-vm tmp/local-build-cache tmp/local-template-storage tmp/sandbox-cache-dir .data/test-volume
set -a
# shellcheck disable=SC1091
source .env.local
set +a
export SANDBOX_DIR="${PWD}/tmp/fc-vm"
export NODE_ID="${NODE_ID:-$(hostname)}"
export ALLOW_SANDBOX_INTERNAL_CIDRS="${ALLOW_SANDBOX_INTERNAL_CIDRS:-169.254.0.22/32}"
exec ./bin/orchestrator
