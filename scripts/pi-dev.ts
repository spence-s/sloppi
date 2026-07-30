#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import {$} from 'execa';

const instance = 'pi-dev';

const configPath = path.join(import.meta.dirname, 'lima.yaml');

const {stdout: limaInstanceList} = await $`limactl list --quiet`;

if (limaInstanceList.split('\n').map(line => line.trim()).includes(instance)) {
  await $`limactl start ${instance}`;
} else {
  await $`limactl start --name ${instance} ${configPath}`;
}

await $`limactl shell --workdir ${process.cwd()} ${instance} -- pi ${process.argv.slice(2)}`;
