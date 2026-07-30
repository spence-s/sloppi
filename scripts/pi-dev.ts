#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import {$} from 'execa';

const $$ = $({stdio: 'inherit'});

const instance = 'pi-dev';
const configPath = path.join(import.meta.dirname, 'lima.yaml');
const configureGit = `
git config --global --unset-all include.path || true
git config --global user.name 'Pi Agent'
git config --global user.email 'pi-agent@localhost'
git config --global commit.gpgsign false
`;

const installDependencies = String.raw`
modules="$HOME/.cache/pi-dev/node_modules/$(printf %s "$PWD" | sha256sum | cut -d ' ' -f 1)"
stamp="$modules/.package-lock"
signature="$(sha256sum package-lock.json | cut -d ' ' -f 1)-$(node --version)-$(uname -sm)"

mkdir -p "$modules" node_modules
if ! mountpoint -q node_modules; then
  sudo mount --bind "$modules" node_modules
fi

if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$signature" ]; then
  npm i
  printf '%s\n' "$signature" > "$stamp"
fi
`;

const {stdout: limaInstanceList} = await $`limactl list --quiet`;

if (limaInstanceList.split('\n').map(line => line.trim()).includes(instance)) {
  await $$`limactl start ${instance}`;
} else {
  await $$`limactl start --name ${instance} ${configPath}`;
}

await $$`limactl shell ${instance} -- sh -ceu ${configureGit}`;
await $$`limactl shell --workdir ${process.cwd()} ${instance} -- sh -ceu ${installDependencies}`;
await $$`limactl shell --workdir ${process.cwd()} ${instance} -- env PI_DEV=true pi ${process.argv.slice(2)}`;
