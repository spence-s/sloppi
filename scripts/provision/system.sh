#!/bin/sh
set -eu

# Package changes arrive through deliberate VM rebuilds, not background jobs.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer
systemctl mask --now apt-daily.service apt-daily-upgrade.service
rm -f /etc/apt/apt.conf.d/20auto-upgrades

if [ ! -f /var/lib/sloppi/packages-installed ]; then
  apt-get update
  apt-get install -y \
    bat build-essential curl dnsutils eza fd-find file fzf git jq lsof \
    netcat-openbsd nftables postgresql-client procps psmisc python3 python3-pip \
    ripgrep shellcheck sqlite3 tmux tree unzip wget yq zip zoxide
  curl --fail --silent --show-error --location \
    https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-aarch64.tar.gz \
    | tar -xz -C /usr/local/bin mitmdump mitmproxy mitmweb
  mkdir -p /var/lib/sloppi
  touch /var/lib/sloppi/packages-installed
fi
ln -sf /usr/bin/batcat /usr/local/bin/bat
ln -sf /usr/bin/fdfind /usr/local/bin/fd

for command in n node npm npx pi; do
  ln -sf "{{.Home}}/n/bin/$command" "/usr/local/bin/$command"
done

if ! id sloppi-proxy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/sloppi-proxy --shell /usr/sbin/nologin sloppi-proxy
fi

/usr/bin/python3 /etc/sloppi/proxy.py --self-test
/usr/sbin/visudo -cf /etc/sudoers
sysctl -p /etc/sysctl.d/90-sloppi-hardening.conf
/usr/sbin/sshd -t
systemctl reload ssh
systemctl daemon-reload
nft --check --file /etc/nftables.conf
systemctl enable nftables sloppi-proxy
systemctl restart nftables sloppi-proxy

attempt=0
while [ ! -s /var/lib/sloppi-proxy/mitmproxy-ca-cert.pem ] && [ "$attempt" -lt 30 ]; do
  attempt=$((attempt + 1))
  sleep 1
done
test -s /var/lib/sloppi-proxy/mitmproxy-ca-cert.pem
install -m 644 /var/lib/sloppi-proxy/mitmproxy-ca-cert.pem \
  /usr/local/share/ca-certificates/sloppi-proxy.crt
update-ca-certificates

cat > /etc/apt/apt.conf.d/90sloppi-proxy <<'EOF'
Acquire::http::Proxy "http://127.0.0.1:39080";
Acquire::https::Proxy "http://127.0.0.1:39080";
EOF

curl --fail --silent --show-error --max-time 15 http://127.0.0.1:39081/ >/dev/null
proxy=http://127.0.0.1:39080
curl --fail --silent --show-error --max-time 15 --proxy "$proxy" \
  --cacert /usr/local/share/ca-certificates/sloppi-proxy.crt https://example.com/ >/dev/null
headers=$(mktemp)
curl --silent --max-time 15 --proxy "$proxy" \
  --cacert /usr/local/share/ca-certificates/sloppi-proxy.crt \
  --request POST --dump-header "$headers" --output /dev/null https://example.com/
grep -qi '^X-Sloppi-Network-Policy: denied' "$headers"
rm "$headers"
if curl --silent --max-time 5 --noproxy '*' https://example.com/ >/dev/null 2>&1; then
  echo 'Direct public egress bypassed the proxy' >&2
  exit 1
fi
