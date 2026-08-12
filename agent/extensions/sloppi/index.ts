import {realpathSync} from 'node:fs';
import process from 'node:process';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {
  ConfigStore,
  type ConfigScope,
} from './config.ts';
import {Sandbox} from './sandbox.ts';
import {SandboxTools} from './tools.ts';

// Only these tools may execute commands; everything else stays explicitly allowlisted.
const sandboxedTools = new Set(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
// These provider-backed tools intentionally stay on the credential-holding host.
const hostTools = new Set(['fetch_content', 'get_search_content', 'source_check', 'web_search']);

const sandboxSystemPrompt = `
## Sloppi Sandbox

Filesystem tools can write only the current project, explicitly allowed directories,
and private temporary storage; global skills are read-only. Network access is
allowlisted, and host credentials, signing agents, and other host services are
unavailable unless explicitly configured. Treat a sandbox denial as a real boundary:
do not retry outside it or seek a workaround.
`.trim();

export function getBlockedDomain(message: string, command = ''): string | undefined {
  const violation = /deny network-outbound (?<host>.+):(?<port>\d+) \(host is not on the allow list\)/v.exec(message);
  if (violation?.groups !== undefined) {
    return `${violation.groups.host}:${violation.groups.port}`;
  }

  if (!/connection blocked by network allowlist|connect tunnel failed, response 403/iv.test(message)) {
    return undefined;
  }

  const url = /https?:\/\/[^\s"'`]+/v.exec(command)?.[0];
  if (url === undefined) {
    return undefined;
  }

  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port.length > 0 ? parsed.port : (parsed.protocol === 'https:' ? '443' : '80')}`;
}

export class Slopbox {
  pi: ExtensionAPI;
  cwd: string;
  config: ConfigStore;
  sandbox: Sandbox;
  isPromptInProgress = false;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.cwd = realpathSync(process.cwd());
    this.config = new ConfigStore(this.cwd);
    this.sandbox = new Sandbox(this.cwd, this.config);
  }

  register(): void {
    const {pi, cwd, config, sandbox} = this;
    new SandboxTools(pi, cwd, sandbox).register();

    pi.registerCommand('slopbox', {
      description: 'Configure sandbox access. Usage: /slopbox [global] add|allow|status <value>',
      async handler(args, ctx) {
        const parts = args.trim().split(/\s+/v).filter(Boolean);
        const scope: ConfigScope = parts[0] === 'global' ? 'global' : 'project';
        if (scope === 'global') {
          parts.shift();
        }

        const command = parts.shift();
        try {
          if (command === 'status' && parts.length === 0) {
            await config.reload();
            await sandbox.restartSession();
            ctx.ui.notify(JSON.stringify(SandboxManager.getConfig(), undefined, 2), 'info');
            return;
          }

          if (command === 'add' && parts.length > 0) {
            const directory = config.resolveAllowedDirectory(parts.join(' '));
            await config.addDirectory(scope, directory);
            await sandbox.restartSession();
            ctx.ui.notify(`slopbox allows ${directory} (${scope}).`, 'info');
            return;
          }

          if (command === 'allow' && parts.length === 1) {
            await config.addDomain(scope, parts[0] ?? '');
            await sandbox.restartSession();
            ctx.ui.notify(`slopbox allows ${parts[0]} (${scope}).`, 'info');
            return;
          }

          if (command === 'prompt' && (parts[0] === 'on' || parts[0] === 'off')) {
            await config.setPrompting(scope, parts[0] === 'on');
            await sandbox.restartSession();
            ctx.ui.notify(`slopbox network prompts are ${parts[0]} (${scope}).`, 'info');
            return;
          }

          ctx.ui.notify('Usage: /slopbox [global] add <directory> | allow <domain> | prompt on|off | status', 'info');
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });

    pi.on('before_agent_start', event => ({
      systemPrompt: `${event.systemPrompt}\n\n${sandboxSystemPrompt}`,
    }));

    pi.on('tool_call', event => {
      if (!sandboxedTools.has(event.toolName) && !hostTools.has(event.toolName)) {
        return {block: true, reason: `Tool ${event.toolName} is not approved for host execution.`};
      }
    });

    pi.on('tool_result', async (event, ctx) => {
      if (!sandboxedTools.has(event.toolName) || !ctx.hasUI || this.isPromptInProgress) {
        return;
      }

      await config.reload();
      const message = event.content
        .filter(entry => entry.type === 'text')
        .map(entry => entry.text)
        .join('\n');
      const command = typeof event.input.command === 'string' ? event.input.command : '';
      const suggestedDomain = getBlockedDomain(message, command);
      if (suggestedDomain === undefined || !config.shouldPrompt() || config.isDomainAllowed(suggestedDomain)) {
        return;
      }

      this.isPromptInProgress = true;
      try {
        const projectChoice = `Allow ${suggestedDomain} for this project`;
        const globalChoice = `Allow ${suggestedDomain} for all projects`;
        const customChoice = 'Customize the SRT domain pattern…';
        const choice = await ctx.ui.select('Slopbox blocked a network request', [
          projectChoice,
          globalChoice,
          customChoice,
          'Deny',
        ]);
        if (choice === undefined || choice === 'Deny') {
          return;
        }

        const scope: ConfigScope = choice === globalChoice ? 'global' : 'project';
        const domain = choice === customChoice
          ? await ctx.ui.input('SRT domain pattern', suggestedDomain)
          : suggestedDomain;
        if (domain === undefined || domain.trim().length === 0) {
          return;
        }

        await config.addDomain(scope, domain.trim());
        await sandbox.restartSession();
        ctx.ui.notify(`Added ${domain.trim()} to ${scope} network.allowedDomains. Retry the command.`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        this.isPromptInProgress = false;
      }
    });

    pi.on('session_start', async (_event, ctx) => {
      ctx.ui.setStatus('0:slopbox', `${ctx.ui.theme.fg('accent', 'sloppi')} ${ctx.ui.theme.bold(ctx.ui.theme.fg('warning', '●'))} ${ctx.ui.theme.fg('dim', '│')}`);
      try {
        await sandbox.startSession();
        const result = await sandbox.run`true`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : 'Sandbox command failed');
        }

        ctx.ui.setStatus('0:slopbox', `${ctx.ui.theme.fg('accent', 'sloppi')} ${ctx.ui.theme.bold(ctx.ui.theme.fg('success', '●'))} ${ctx.ui.theme.fg('dim', '│')}`);
        ctx.ui.notify(`Sandboxed tools can access only ${cwd}.`, 'info');
      } catch (error) {
        ctx.ui.setStatus('0:slopbox', `${ctx.ui.theme.fg('accent', 'sloppi')} ${ctx.ui.theme.bold(ctx.ui.theme.fg('error', '●'))} ${ctx.ui.theme.fg('dim', '│')}`);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    });
    pi.on('session_shutdown', async () => {
      await sandbox.stopSession();
    });
  }
}

export default function slopbox(pi: ExtensionAPI): void {
  new Slopbox(pi).register();
}
