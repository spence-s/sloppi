#!/usr/bin/env node

import {realpath, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {isAbsolute, relative, resolve} from 'node:path';
import process from 'node:process';
import {parseArgs} from 'node:util';
import {$} from 'execa';

const terminal = $({stdio: 'inherit'});
const ignoreFailures = $({stdio: 'ignore', reject: false});
const template = fileURLToPath(new URL('lima.yaml', import.meta.url));

const help = `Usage:
  pi-vm [directory ...] [-- <pi options...>]
  pi-vm destroy
  pi-vm doctor

Run Pi in a disposable Lima VM. The first directory is Pi's working directory.
Every directory, plus ~/.pi, is mounted read-write in the VM.

Examples:
  pi-vm
  pi-vm ~/Code/api ~/Code/web
  pi-vm . ../shared-library -- --model sonnet
  pi-vm destroy
`;

const separator = process.argv.indexOf('--');
const cliArguments = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const piArguments = separator === -1 ? [] : process.argv.slice(separator + 1);
const {values, positionals} = parseArgs({
  args: cliArguments,
  allowPositionals: true,
  options: {
    help: {type: 'boolean', short: 'h'},
    version: {type: 'boolean', short: 'v'},
  },
});

if (values.help) {
  process.stdout.write(help);
  process.exit(0);
}

if (values.version) {
  process.stdout.write('pi-vm 0.0.0\n');
  process.exit(0);
}

if (process.platform !== 'darwin') {
  throw new Error('pi-vm currently requires macOS and Lima.');
}

const command = positionals[0];

if (command === 'destroy') {
  if (positionals.length > 1 || piArguments.length > 0) {
    throw new Error('pi-vm destroy does not accept directories or Pi options.');
  }

  await terminal({reject: false})`limactl delete --force pi-vm`;
  process.exit(0);
} else if (command === 'doctor') {
  if (positionals.length > 1 || piArguments.length > 0) {
    throw new Error('pi-vm doctor does not accept directories or Pi options.');
  }

  await terminal`limactl --version`;
  await terminal`limactl list`;
  process.exit(0);
}

const requestedDirectories = positionals.length === 0 ? [process.cwd()] : positionals;

const directories = await Promise.all(requestedDirectories.map(async directory => {
  const location = await realpath(resolve(directory));
  const details = await stat(location);
  if (!details.isDirectory()) {
    throw new Error(`${directory} is not a directory.`);
  }

  return location;
}));
const piDirectory = await realpath(resolve(homedir(), '.pi'));
const piDirectoryDetails = await stat(piDirectory);
if (!piDirectoryDetails.isDirectory()) {
  throw new Error(`${piDirectory} is not a directory.`);
}

const mountDirectories = directories.includes(piDirectory) ? directories : [...directories, piDirectory];

for (const [index, directory] of mountDirectories.entries()) {
  for (const otherDirectory of mountDirectories.slice(index + 1)) {
    const pathBetweenDirectories = relative(directory, otherDirectory);
    const reversePathBetweenDirectories = relative(otherDirectory, directory);
    const isDirectoryContainsOther = !pathBetweenDirectories.startsWith('..') && !isAbsolute(pathBetweenDirectories);
    const isOtherDirectoryContainsDirectory = !reversePathBetweenDirectories.startsWith('..') && !isAbsolute(reversePathBetweenDirectories);
    if (pathBetweenDirectories === '' || isDirectoryContainsOther || isOtherDirectoryContainsDirectory) {
      throw new Error(`Mounts overlap: ${directory} and ${otherDirectory}.`);
    }
  }
}

const mounts = mountDirectories.flatMap(directory => ['--mount-only', `${directory}:w`]);

await ignoreFailures`limactl delete --force pi-vm`;

try {
  await terminal`limactl start --name pi-vm --image-variant minimal ${mounts} ${template}`;
  await terminal`limactl shell --workdir ${directories[0]!} pi-vm -- env ${`PI_CODING_AGENT_DIR=${piDirectory}/agent`} PI_OFFLINE=1 pi --no-approve ${piArguments}`;
} finally {
  await terminal({reject: false})`limactl delete --force pi-vm`;
}

