#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gettext-base git make gcc g++ libc6-dev pkg-config docker.io docker-compose-v2 qemu-kvm nbd-client jq socat unzip
systemctl enable --now docker

if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  usermod -aG docker "${SUDO_USER}"
fi

modprobe nbd nbds_max=64
sysctl -w vm.nr_hugepages=10240
install -d -m 0755 /etc/modules-load.d /etc/sysctl.d
printf '%s\n' 'nbd' > /etc/modules-load.d/e2b-nbd.conf
printf '%s\n' 'options nbd nbds_max=64' > /etc/modprobe.d/e2b-nbd.conf
printf '%s\n' 'vm.nr_hugepages=10240' > /etc/sysctl.d/99-e2b-hugepages.conf

if [[ "$(/usr/local/go/bin/go version 2>/dev/null || true)" != *"go1.26.6"* ]]; then
  curl --fail --location --retry 3 https://go.dev/dl/go1.26.6.linux-amd64.tar.gz --output /tmp/go1.26.6.linux-amd64.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go1.26.6.linux-amd64.tar.gz
fi

if [[ "$(/usr/local/bin/node --version 2>/dev/null || true)" != v22.* ]]; then
  curl --fail --location --retry 3 https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.xz --output /tmp/node-v22.18.0-linux-x64.tar.xz
  tar -C /usr/local --strip-components=1 -xJf /tmp/node-v22.18.0-linux-x64.tar.xz
fi

install -d -m 0755 /opt/genioone
if [[ ! -d /opt/genioone/e2b-infra/.git ]]; then
  git clone https://github.com/e2b-dev/infra.git /opt/genioone/e2b-infra
fi
git -C /opt/genioone/e2b-infra fetch origin 16bd4e3ccec5b9d1f4e8fb9b5c79c92ea49e193f
git -C /opt/genioone/e2b-infra checkout --detach 16bd4e3ccec5b9d1f4e8fb9b5c79c92ea49e193f

if [[ ! -d /opt/genioone/e2b-desktop/.git ]]; then
  git clone https://github.com/e2b-dev/desktop.git /opt/genioone/e2b-desktop
fi
git -C /opt/genioone/e2b-desktop fetch origin 89a545e22343aa1c40f28338bf3281a6c04b1d4a
git -C /opt/genioone/e2b-desktop checkout --detach 89a545e22343aa1c40f28338bf3281a6c04b1d4a

/usr/local/go/bin/go version
/usr/local/bin/node --version
docker version --format '{{.Server.Version}}'
docker compose version
ls -l /dev/kvm
grep -E 'HugePages_Total|Hugepagesize' /proc/meminfo
