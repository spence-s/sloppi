#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import {parseArgs} from 'node:util';
import {$} from 'execa';

const $$ = $({stdio: 'inherit'});

const instance = 'pi-dev';
const configPath = path.join(import.meta.dirname, 'lima.yaml');

const help = `
Usage: sloppi [command] [pi options]

Commands:
destroy  Delete the pi-dev VM

Options:
-h, --help  Show this help
`
  .trimStart();

const {positionals, values} = parseArgs({
  allowPositionals: true,
  options: {help: {type: 'boolean', short: 'h'}},
  strict: false,
});

const command = (positionals[0] ?? '').toLowerCase().trim();

const isValidCommand = ['destroy', 'help', ''].includes(command);

if (!isValidCommand) {
  console.log(`Invalid command: ${command}`);
  console.log();
  console.log(help);
  process.exit(0);
}

switch (command) {
  case 'help': {
    process.stdout.write(help);
    break;
  }

  case 'destroy': {
    await $$`limactl delete --force ${instance}`;
    break;
  }

  default: {
    const {stdout: limaInstanceList} = await $`limactl list --quiet`;

    if (limaInstanceList.split('\n').map(line => line.trim()).includes(instance)) {
      await $$`limactl start ${instance}`;
    } else {
      await $$`limactl start --name ${instance} ${configPath}`;
    }

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

    await $$`limactl shell --workdir ${process.cwd()} ${instance} -- sh -ceu ${installDependencies}`;
    await $$`limactl shell --workdir ${process.cwd()} ${instance} -- env PI_DEV=true pi ${process.argv.slice(2)}`;
  }
}
