import {basename} from 'node:path';
import process from 'node:process';
import {
  createLocalBashOperations,
  type BashOperations,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

/**
Runs user-entered host commands through the user's zsh startup file so aliases
and shell functions remain available without enabling interactive terminal UI.
The shell stays non-interactive because Pi uses pipes, not a terminal; enabling
interactive mode can trigger prompt plugins' job-control initialization errors.
Completion is
published after Pi can record the Bash result. A synchronous operations handoff
lets other extensions wrap execution without relying on the
load order of Pi's short-circuiting user_bash handlers.
*/
export default function zshrc(pi: ExtensionAPI): void {
  const userShell = process.env.SHELL;
  if (userShell === undefined || basename(userShell) !== 'zsh') {
    return;
  }

  const local = createLocalBashOperations({shellPath: userShell});
  pi.on('user_bash', event => {
    const command = `source ~/.zshrc\neval -- '${event.command.replaceAll('\'', '\'"\'"\'')}'`;
    const execution: {command: string; operations: BashOperations} = {
      command: event.command,
      operations: {
        /**
        Executes the alias-aware command while preserving Pi's streaming and
        cancellation options. Completion remains deferred so permission staging
        and UI listeners cannot start a continuation before Pi records the result.
        */
        async exec(_prefixedCommand, commandCwd, options) {
          try {
            return await local.exec(command, commandCwd, options);
          } finally {
            // Let Pi record the Bash result before listeners start a continuation turn.
            setImmediate(() => {
              pi.events.emit('sloppi:user-bash-end', event.command);
            });
          }
        },
      },
    };
    // Event-bus listeners run synchronously even if their extension loaded later.
    pi.events.emit('sloppi:user-bash-operations', execution);
    return {operations: execution.operations};
  });
}
