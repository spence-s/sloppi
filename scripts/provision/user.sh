#!/bin/sh
export N_PREFIX="$HOME/n"
export PATH="$N_PREFIX/bin:$PATH"
curl -L https://bit.ly/n-install | bash -s -- -y -
n lts

git config --global user.name 'Pi Agent'
git config --global user.email 'pi-agent@localhost'
git config --global commit.gpgsign false
