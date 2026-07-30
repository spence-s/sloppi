#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import {$} from 'execa';

const instance = 'pi-dev';

const config = path.join(import.meta.dirname, 'lima.yaml');

const {stdout} = await $`limactl list --quiet`;

if (stdout.split('\n').map(line => line.trim()).includes(instance)) {
  await $`limactl start ${instance}`;
} else {
  await $`limactl start --name ${instance} ${config}`;
}

await $`limactl shell --workdir ${process.cwd()} ${instance} -- pi ${process.argv.slice(2)}`;
