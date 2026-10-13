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
Before evaluation, a startup-disabled Zsh child records the original input with
native history builtins. Only this recorder is interactive, because fc does not
write files in non-interactive shells; it does not load .zshrc or prompt plugins.
Completion is published after Pi can record the Bash result. A synchronous
operations handoff lets other extensions wrap execution without relying on the
load order of Pi's short-circuiting user_bash handlers.
*/
export default function zshrc(pi: ExtensionAPI): void {
  const userShell = process.env.SHELL;
  if (userShell === undefined || basename(userShell) !== 'zsh') {
    return;
  }

  const local = createLocalBashOperations({shellPath: userShell});
  /**
  Prepends only a native history append to the existing alias-aware evaluation.
  Passing the original input as an argument prevents it from executing in the
  recorder, and recording first retains commands that exit or are terminated.
  */
  pi.on('user_bash', event => {
    // Inherit history settings as arguments, not exported environment variables.
    // Keep the entry in the child only, avoiding a duplicate save by the parent.
    const record = `if [[ -n $HISTFILE && $HISTSIZE -gt 0 && $SAVEHIST -gt 0 ]]; then
  '${userShell.replaceAll('\'', '\'"\'"\'')}' -fi -c 'HISTFILE=$1 HISTSIZE=$2 SAVEHIST=$3; builtin print -rs -- "$4"; builtin fc -AI; SAVEHIST=0' sloppi-history "$HISTFILE" "$HISTSIZE" "$SAVEHIST" '${event.command.replaceAll('\'', '\'"\'"\'')}' || true
fi`;
    const command = `source ~/.zshrc\neval -- '${`${record}\n${event.command}`.replaceAll('\'', '\'"\'"\'')}'`;
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
