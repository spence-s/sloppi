import {realpathSync} from 'node:fs';
import process from 'node:process';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {ConfigStore} from './config.ts';
import {SandboxCommand} from './command.ts';
import {SandboxSessionManager} from './session-manager.ts';
import {SandboxSubagent} from './subagent.ts';
import {SandboxTools} from './tools.ts';

// Only these tools may execute commands; everything else stays explicitly allowlisted.
const sandboxedTools = new Set(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
// Provider-backed tools and delegation keep model credentials on the host; delegation filesystem access is SRT-backed.
const hostTools = new Set(['research_scout', 'fetch_content', 'get_search_content', 'source_check', 'web_search']);

export class Sandbox {
  pi: ExtensionAPI;
  cwd: string;
  config: ConfigStore;
  sandbox: SandboxSessionManager;
  isPromptInProgress = false;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.cwd = realpathSync(process.cwd());
    this.config = new ConfigStore(this.cwd);
    this.sandbox = new SandboxSessionManager(this.cwd, this.config);
  }

  register(): void {
    const {pi, cwd, config, sandbox} = this;
    new SandboxTools(pi, cwd, sandbox).register();
    new SandboxSubagent(pi, cwd, sandbox, config).register();

    new SandboxCommand(config, sandbox).register(pi);

    pi.on('before_agent_start', async event => {
      const sandboxSystemPrompt = `
      ## Sloppi Sandbox

      Filesystem tools can write only to the paths listed below and private temporary
      storage; global skills are read-only. Sandboxed network access is allowlisted, and
      host credentials, signing agents, and other host services are unavailable unless
      explicitly configured. Treat a sandbox denial as a real boundary: do not retry
      outside it or seek a workaround.
      `.trim();

      await config.load();
      if (!config.areResearchAgentsEnabled()) {
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'research_scout'));
      }

      const effectiveConfig = config.getEffectiveConfig();
      const writePaths = [...new Set([cwd, ...(effectiveConfig.filesystem?.allowWrite ?? [])])];
      const allowedDomains = effectiveConfig.network?.allowedDomains ?? [];
      const requestPolicyDestinations = [...new Set(config.getRequestPolicies().map(policy => policy.destination))];
      const accessSummary = [
        'Writable paths:',
        ...writePaths.map(path => `- ${JSON.stringify(path)}`),
        '',
        allowedDomains.length > 0
          ? `Allowed sandboxed network destinations: ${allowedDomains.map(domain => JSON.stringify(domain)).join(', ')}`
          : 'No sandboxed network destinations are allowed.',
        ...requestPolicyDestinations.map(destination => `Request-filtered destination: ${JSON.stringify(destination)}`),
      ].join('\n');

      return {systemPrompt: `${event.systemPrompt}\n\n${sandboxSystemPrompt}\n\n${accessSummary}`};
    });

    pi.on('tool_call', event => {
      if (event.toolName === 'research_scout' && !config.areResearchAgentsEnabled()) {
        return {block: true, reason: 'Research agents are disabled. Enable them with /sandbox global.'};
      }

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
      const violation = /deny network-outbound (?<host>.+):(?<port>\d+) \(host is not on the allow list\)/v.exec(message);
      let suggestedDomain: string | undefined;
      if (violation?.groups === undefined) {
        if (!/connection blocked by network allowlist|connect tunnel failed, response 403/iv.test(message)) {
          return;
        }

        const command = typeof event.input.command === 'string' ? event.input.command : '';
        const url = /https?:\/\/[^\s"'`]+/v.exec(command)?.[0];
        if (url === undefined) {
          return;
        }

        const parsed = new URL(url);
        suggestedDomain = `${parsed.hostname}:${parsed.port.length > 0 ? parsed.port : (parsed.protocol === 'https:' ? '443' : '80')}`;
      } else {
        suggestedDomain = `${violation.groups.host}:${violation.groups.port}`;
      }

      if (!config.shouldPrompt() || config.isDomainAllowed(suggestedDomain)) {
        return;
      }

      this.isPromptInProgress = true;
      try {
        const projectChoice = `Allow ${suggestedDomain} for this project`;
        const customChoice = 'Customize the SRT domain pattern…';
        const choice = await ctx.ui.select('Sandbox blocked a network request', [
          projectChoice,
          customChoice,
          'Deny',
        ]);
        if (choice === undefined || choice === 'Deny') {
          return;
        }

        const domain = choice === customChoice
          ? await ctx.ui.input('SRT domain pattern', suggestedDomain)
          : suggestedDomain;
        if (domain === undefined || domain.trim().length === 0) {
          return;
        }

        const approvedDomain = domain.trim();
        await config.updateDomain('project', 'allow', 'add', approvedDomain);
        await sandbox.restartSession();
        const approvalMessage = `Sandbox access to ${approvedDomain} was approved and is now active. Retry the failed tool call.`;
        ctx.ui.notify(approvalMessage, 'info');
        return {content: [...event.content, {type: 'text', text: approvalMessage}]};
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        this.isPromptInProgress = false;
      }
    });

    pi.on('session_start', async (_event, ctx) => {
      await config.load();
      if (!config.areResearchAgentsEnabled()) {
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'research_scout'));
      }

      ctx.ui.setStatus('sandbox', `${ctx.ui.theme.bold(ctx.ui.theme.fg('warning', '󰂪'))} ${ctx.ui.theme.fg('muted', 'sandbox starting')}`);
      try {
        await sandbox.startSession();
        const result = await sandbox.run`true`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : 'Sandbox command failed');
        }

        ctx.ui.setStatus('sandbox', `${ctx.ui.theme.bold(ctx.ui.theme.fg('success', '󰕥'))} ${ctx.ui.theme.fg('muted', 'sandbox')}`);
        ctx.ui.notify(`Sandboxed tools can access only ${cwd}.`, 'info');
      } catch (error) {
        ctx.ui.setStatus('sandbox', `${ctx.ui.theme.bold(ctx.ui.theme.fg('error', '󰻌'))} ${ctx.ui.theme.fg('muted', 'sandbox failed')}`);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    });

    pi.on('session_shutdown', async () => {
      await sandbox.stopSession();
    });
  }
}

export default function sandboxExtension(pi: ExtensionAPI): void {
  new Sandbox(pi).register();
}
