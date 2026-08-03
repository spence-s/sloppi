#!/bin/sh
set -a
# shellcheck source=/dev/null
. /etc/sloppi/proxy-environment
set +a
export N_PREFIX="$HOME/n"
export PATH="$N_PREFIX/bin:$PATH"
curl -L https://bit.ly/n-install | bash -s -- -y -
n lts
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

git config --global user.name 'Pi Agent'
git config --global user.email 'pi-agent@localhost'
git config --global commit.gpgsign false
