#!/usr/bin/env bash
set -euo pipefail

mode=${1:-apply}
tools_image=${E2B_175_TOOLS_IMAGE:-us-docker.pkg.dev/e2b-artifacts/embed/tools:v0.3.202609120109-ad1cddd091b}

if [[ ! -x /usr/lib64/ld-linux-x86-64.so.2 || ! -x /usr/sbin/iptables || ! -d /usr/lib/xtables || ! -d /etc/xtables || ! -x "$(command -v docker)" ]]; then
  printf '%s\n' 'host iptables runtime is unavailable' >&2
  exit 1
fi

ipt() {
  docker run --rm --privileged --network host \
    -e XTABLES_LIBDIR=/host/usr/lib/xtables \
    -v /usr:/host/usr:ro -v /lib:/host/lib:ro -v /lib64:/host/lib64:ro \
    -v /usr/lib/xtables:/host/usr/lib/xtables:ro -v /etc/xtables:/host/etc/xtables:ro \
    "$tools_image" /host/usr/lib64/ld-linux-x86-64.so.2 \
    --library-path /host/usr/lib:/host/usr/lib64:/host/lib:/host/lib64 \
    /host/usr/sbin/xtables-nft-multi iptables "$@"
}

rule() {
  local table=$1
  local chain=$2
  local operation=$3
  shift 3
  local table_args=()
  if [[ "$table" == nat ]]; then
    table_args=(-t nat)
  fi
  if [[ "$operation" == add ]]; then
    if ! ipt "${table_args[@]}" -C "$chain" "$@"; then
      if [[ "$chain" == INPUT ]]; then
        ipt "${table_args[@]}" -I "$chain" 1 "$@"
      else
        ipt "${table_args[@]}" -A "$chain" "$@"
      fi
    fi
  else
    if ipt "${table_args[@]}" -C "$chain" "$@"; then
      ipt "${table_args[@]}" -D "$chain" "$@"
    fi
  fi
}

apply_rules() {
  rule filter INPUT add -s 10.12.0.0/16 -d 10.12.0.0/16 -p tcp -m tcp --dport 5016 -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment e2b-embed-175-outer-netd-input -j ACCEPT
  rule filter INPUT add -s 10.11.0.0/16 -d 10.12.0.0/16 -p tcp -m tcp --dport 5016 -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment e2b-embed-175-netd-input -j ACCEPT
  rule filter INPUT add -s 10.12.0.0/16 -d 10.12.0.0/16 -p tcp -m tcp --dport 5017 -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment e2b-embed-175-outer-netd-tls-input -j ACCEPT
  rule filter INPUT add -s 10.11.0.0/16 -d 10.12.0.0/16 -p tcp -m tcp --dport 5017 -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment e2b-embed-175-netd-tls-input -j ACCEPT
  rule filter FORWARD add -s 10.12.0.0/16 -o wlp0s20f3 -m conntrack --ctstate NEW,RELATED,ESTABLISHED -m comment --comment e2b-embed-175-outer-forward -j ACCEPT
  rule filter FORWARD add -s 10.11.0.0/16 -o wlp0s20f3 -m conntrack --ctstate NEW,RELATED,ESTABLISHED -m comment --comment e2b-embed-175-forward -j ACCEPT
  rule filter FORWARD add -d 10.12.0.0/16 -i wlp0s20f3 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment e2b-embed-175-outer-return -j ACCEPT
  rule filter FORWARD add -d 10.11.0.0/16 -i wlp0s20f3 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment e2b-embed-175-return -j ACCEPT
  rule nat POSTROUTING add -s 10.12.0.0/16 -o wlp0s20f3 -m comment --comment e2b-embed-175-outer-masq -j MASQUERADE
  rule nat POSTROUTING add -s 10.11.0.0/16 -o wlp0s20f3 -m comment --comment e2b-embed-175-masq -j MASQUERADE
}

remove_rules() {
  rule filter INPUT remove -s 10.12.0.0/16 -d 10.12.0.0/16 -p tcp -m tcp --dport 5016 -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment e2b-embed-175-outer-netd-input -j ACCEPT
  rule filter INPUT remove -s 10.11.0.0/16 -d 10.12.0.0/16 -p tcp -m tcp --dport 5016 -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment e2b-embed-175-netd-input -j ACCEPT
  rule filter INPUT remove -s 10.12.0.0/16 -d 10.12.0.0/16 -p tcp -m tcp --dport 5017 -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment e2b-embed-175-outer-netd-tls-input -j ACCEPT
  rule filter INPUT remove -s 10.11.0.0/16 -d 10.12.0.0/16 -p tcp -m tcp --dport 5017 -m conntrack --ctstate NEW,ESTABLISHED -m comment --comment e2b-embed-175-netd-tls-input -j ACCEPT
  rule filter FORWARD remove -s 10.12.0.0/16 -o wlp0s20f3 -m conntrack --ctstate NEW,RELATED,ESTABLISHED -m comment --comment e2b-embed-175-outer-forward -j ACCEPT
  rule filter FORWARD remove -s 10.11.0.0/16 -o wlp0s20f3 -m conntrack --ctstate NEW,RELATED,ESTABLISHED -m comment --comment e2b-embed-175-forward -j ACCEPT
  rule filter FORWARD remove -d 10.12.0.0/16 -i wlp0s20f3 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment e2b-embed-175-outer-return -j ACCEPT
  rule filter FORWARD remove -d 10.11.0.0/16 -i wlp0s20f3 -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment e2b-embed-175-return -j ACCEPT
  rule nat POSTROUTING remove -s 10.12.0.0/16 -o wlp0s20f3 -m comment --comment e2b-embed-175-outer-masq -j MASQUERADE
  rule nat POSTROUTING remove -s 10.11.0.0/16 -o wlp0s20f3 -m comment --comment e2b-embed-175-masq -j MASQUERADE
}

show_rules() {
  ipt -L INPUT -n -v --line-numbers
  ipt -L FORWARD -n -v --line-numbers
  ipt -t nat -L POSTROUTING -n -v --line-numbers
}

case "$mode" in
  apply)
    apply_rules
    ;;
  rollback)
    remove_rules
    ;;
  check)
    show_rules
    ;;
  *)
    printf 'usage: %s [apply|rollback|check]\n' "$0" >&2
    exit 2
    ;;
esac
