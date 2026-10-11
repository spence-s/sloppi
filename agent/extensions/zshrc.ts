import {basename} from 'node:path';
import process from 'node:process';
import {
  createLocalBashOperations,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

/**
Runs user-entered host commands through the user's zsh startup file so aliases
and shell functions behave as they do in an interactive terminal. Completion is
published after Pi can record the Bash result; the structured event also lets
optional integrations such as Atuin retain the real exit status.
*/
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
          let exitCode = 1;

          try {
            const result = await local.exec(command, commandCwd, options);
            exitCode = result.exitCode ?? 1;
            return result;
          } finally {
            // Let Pi record the Bash result before listeners start a continuation turn.
            setImmediate(() => {
              pi.events.emit('sloppi:user-bash-result', {
                command: event.command,
                cwd: commandCwd,
                exitCode,
              });
              pi.events.emit('sloppi:user-bash-end', event.command);
            });
          }
        },
      },
    };
  });
}
