import {basename} from 'node:path';
import process from 'node:process';
import {
  createLocalBashOperations,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

export default function zshrc(pi: ExtensionAPI): void {
  const userShell = process.env.SHELL;
  if (userShell === undefined || basename(userShell) !== 'zsh') {
    return;
  }

  const local = createLocalBashOperations({shellPath: userShell});
  pi.on('user_bash', event => {
    const command = `source ~/.zshrc\neval -- '${event.command.replaceAll('\'', '\'"\'"\'')}'`;
    return {
      operations: {
        async exec(_prefixedCommand, commandCwd, options) {
          return local.exec(command, commandCwd, options);
        },
      },
    };
  });
}
