#!/usr/bin/env node
import {createHash} from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import {parseArgs} from 'node:util';
import {$} from 'execa';

const $$ = $({stdio: 'inherit'});

const project = process.cwd();
const suffix = createHash('sha256').update(project).digest('hex').slice(0, 8);
const name = path.basename(project).toLowerCase().replaceAll(/[^0-9a-z]+/gv, '-');
const instance = `sloppi-${name}-${suffix}`;
const configPath = path.join(import.meta.dirname, 'lima.yaml');

const help = `
Usage: sloppi [command] [pi options]

Commands:
start (default) Start the project VM and run host Pi with tools routed into Lima
destroy         Delete this project's VM
list            List Lima VMs

Options:
-h, --help  Show this help
`
  .trimStart();

const {positionals, values} = parseArgs({
  allowPositionals: true,
  options: {
    help: {
      type: 'boolean',
      short: 'h',
      default: false,
    },
  },
});

if (values.help) {
  console.log(help);
  process.exit(0);
}

const command = positionals[0] ?? 'start';

const isValidCommand = ['destroy', 'help', 'list', 'start'].includes(command);

if (!isValidCommand) {
  console.log(`Invalid command: ${command}`);
  console.log();
  console.log(help);
  process.exit(0);
}

switch (command) {
  case 'list': {
    await $$`limactl list`;
    break;
  }

  case 'destroy': {
    await $$`limactl delete --force ${instance}`;
    break;
  }

  default: {
    const {stdout: limaInstanceList} = await $`limactl list --quiet`;

    if (limaInstanceList.split('\n').map(line => line.trim()).includes(instance)) {
      await $$`limactl start ${instance} -y`;
    } else {
      await $$`limactl start --name ${instance} --mount-only ${`${project}:w`} ${configPath} -y`;
    }

    const installDependencies = String.raw`
    if [ -f package-lock.json ]; then
      project="$(pwd -P)"
      modules="$HOME/.cache/pi-dev/node_modules/$(printf %s "$project" | sha256sum | cut -d ' ' -f 1)"
      stamp="$modules/.package-lock"
      signature="$(sha256sum package-lock.json | cut -d ' ' -f 1)-$(node --version)-$(uname -sm)"

      mkdir -p "$modules" node_modules
      sudo -n /usr/local/sbin/sloppi-mount-node-modules

      if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$signature" ]; then
        npm i
        printf '%s\n' "$signature" > "$stamp"
      fi
    fi
    `;

    await $$`limactl shell --workdir ${process.cwd()} ${instance} -- sh -ceu ${installDependencies}`;
    const piArguments = process.argv.slice(2);
    if (process.argv[2] === command) {
      piArguments.shift();
    }

    await $({
      env: {
        ...process.env,
        PI_DEV: 'true',
        SLOPPI_LIMA_INSTANCE: instance,
      },
      stdio: 'inherit',
    })`pi ${piArguments}`;
  }
}
