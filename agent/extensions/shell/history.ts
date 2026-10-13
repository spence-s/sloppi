import {basename} from 'node:path';
import process from 'node:process';
import type {ExecResult, ExtensionAPI} from '@earendil-works/pi-coding-agent';

/**
Reads native history in a non-interactive Zsh, matching the restored user-command
startup path. An interactive/login child can initialize prompt plugins and change
terminal state even though its stdio is piped, so history lookup must never use
-i or -l. Sourcing ~/.zshrc non-interactively resolves the user's HISTFILE without
activating interactive prompt initialization. Zsh decodes the file itself and
saving remains disabled, making lookup read-only. The first NUL separates startup
output from entries; the empty in-memory event exposes the newest imported entry,
which Zsh's history parameter otherwise excludes. No history text is executed.
*/
export async function readZshHistory(pi: ExtensionAPI, cwd: string): Promise<ExecResult> {
  const shell = pi.getSettings().shellPath ?? process.env.SHELL ?? '/bin/zsh';
  if (basename(shell) !== 'zsh') {
    throw new Error('Configure Pi shellPath to use Zsh for native history.');
  }

  const result = await pi.exec(shell, ['-f', '-c', `
source ~/.zshrc >/dev/null
SAVEHIST=0
[[ -n $HISTFILE ]] || { builtin print -ru2 -- 'HISTFILE is not configured.'; exit 1; }
[[ -e $HISTFILE ]] || exit 0
builtin fc -R "$HISTFILE" || exit 1
builtin print -s -- ''
zmodload zsh/parameter || exit 1
builtin print -rn -- $'\\0'
for history_key in \${(Onk)history}; do
  builtin print -rn -- "$history[$history_key]"$'\\0'
done
`], {cwd, timeout: 10_000});
  // The history protocol is separate from arbitrary stdout produced by startup files.
  const start = result.stdout.indexOf('\0');
  return {...result, stdout: start === -1 ? '' : result.stdout.slice(start + 1)};
}
