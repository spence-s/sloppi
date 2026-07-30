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

await mkdir(sharedGitConfigDirectory, {recursive: true});
await copyFile(hostGitConfig, sharedGitConfig);

const {stdout: limaInstanceList} = await $`limactl list --quiet`;

if (limaInstanceList.split('\n').map(line => line.trim()).includes(instance)) {
  await $$`limactl start ${instance}`;
} else {
  await $$`limactl start --name ${instance} ${configPath}`;
}

await $$`limactl shell --workdir ${process.cwd()} ${instance} -- pi ${process.argv.slice(2)}`;
