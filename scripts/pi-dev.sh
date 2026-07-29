#!/bin/sh
set -eu

instance=pi-dev
config=$(dirname "$0")/lima.yaml

if limactl list --quiet | grep -qx "$instance"; then
  limactl start "$instance"
else
  limactl start --name "$instance" "$config"
fi

exec limactl shell --workdir "$PWD" "$instance" -- pi "$@"
