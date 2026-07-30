#!/usr/bin/env node
import {copyFile, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {$} from 'execa';

const $$ = $({stdio: 'inherit'});

const instance = 'pi-dev';
const hostGitConfig = path.join(os.homedir(), '.gitconfig');
const sharedGitConfigDirectory = path.join(os.homedir(), '.lima-git');
const sharedGitConfig = path.join(sharedGitConfigDirectory, 'config');
const configPath = path.join(import.meta.dirname, 'lima.yaml');
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

await mkdir(sharedGitConfigDirectory, {recursive: true});
await copyFile(hostGitConfig, sharedGitConfig);

const {stdout: limaInstanceList} = await $`limactl list --quiet`;

if (limaInstanceList.split('\n').map(line => line.trim()).includes(instance)) {
  await $$`limactl start ${instance}`;
} else {
  await $$`limactl start --name ${instance} ${configPath}`;
}

await $$`limactl shell --workdir ${process.cwd()} ${instance} -- sh -ceu ${installDependencies}`;
await $$`limactl shell --workdir ${process.cwd()} ${instance} -- env PI_DEV=true pi ${process.argv.slice(2)}`;
