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
  mkdir -p /var/lib/sloppi
  touch /var/lib/sloppi/packages-installed
fi
ln -sf /usr/bin/batcat /usr/local/bin/bat
ln -sf /usr/bin/fdfind /usr/local/bin/fd

for command in n node npm npx pi; do
  ln -sf "{{.Home}}/n/bin/$command" "/usr/local/bin/$command"
done

/usr/sbin/visudo -cf /etc/sudoers
sysctl -p /etc/sysctl.d/90-sloppi-hardening.conf
/usr/sbin/sshd -t
systemctl reload ssh
nft --check --file /etc/nftables.conf
systemctl enable nftables
systemctl restart nftables
