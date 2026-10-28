import {realpathSync} from 'node:fs';
import process from 'node:process';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {ConfigStore, filesystemPath} from './config.ts';
import {SandboxCommand} from './command/index.ts';
import {PlaywrightBridge} from './playwright.ts';
import {SandboxSessionManager} from './session-manager.ts';
import {SandboxSubagent} from './subagent.ts';
import {SandboxTools} from './tools.ts';

// Sloppi replaces these tools with implementations backed by the SRT session.
const sandboxedTools = new Set(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);

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

  /**
   Registers the tools and lifecycle hooks that Sloppi can actually isolate.

   Pi extensions themselves share Pi's host process and permissions. This extension
   therefore replaces a fixed set of tools rather than claiming to sandbox tools
   registered by unrelated extensions. The prompt below makes that boundary visible
   to the model, while users remain responsible for trusting additional extensions.
   */
  register(): void {
    const {pi, cwd, config, sandbox} = this;
    new SandboxTools(pi, cwd, sandbox).register();
    new SandboxSubagent(pi, cwd, sandbox, config).register();
    const playwright = new PlaywrightBridge(config, sandbox);
    new SandboxCommand(config, sandbox, playwright).register(pi);
    playwright.register(pi);

    pi.on('before_agent_start', async event => {
      const sandboxSystemPrompt = `
## Sandbox

Sloppi sandboxes its replacements for bash, edit, find, grep, ls, read, and write,
plus filesystem operations performed by research_scout. Their filesystem access is
limited to the paths listed below and private temporary storage; global skills are
read-only. Their network access is allowlisted, and host credentials, signing agents,
and other host services are unavailable unless explicitly configured.

Other Pi extensions and tools are outside this boundary and run with their normal
host permissions unless they provide their own isolation. Treat a sandbox denial as
a real boundary: do not retry outside it or seek a workaround.
      `.trim();

      await config.load();

      if (!config.areResearchAgentsEnabled()) {
        pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'research_scout'));
      }

      if (!sandbox.isEnabled) {
        const hostPrompt = `
## Sloppi Sandbox

Sandbox is OFF. Sloppi's managed tools execute directly on the host with the current user permissions.
Sloppi filesystem, network, credential, and host-service restrictions do not apply.
        `.trim();

        return {systemPrompt: `${event.systemPrompt}\n\n${hostPrompt}`};
      }

      const effectiveConfig = config.getEffectiveConfig();
      const writePaths = [...new Set([
        cwd,
        ...(effectiveConfig.filesystem?.allowWrite ?? []).map(entry => filesystemPath(entry)),
      ])];
      const allowedDomains = effectiveConfig.network?.allowedDomains ?? [];
      const requestPolicyDestinations = [...new Set(config.getRequestPolicies().map(policy => policy.destination))];
      const accessSummary = [
        'Writable paths:',
        ...writePaths.map(path => `- ${JSON.stringify(path)}`),
        '',
        'Allowed sandboxed network destinations:',
        ...(allowedDomains.length > 0
          ? allowedDomains.map(domain => `- ${JSON.stringify(domain)}`)
          : ['No sandboxed network destinations are allowed.']),
        '',
        'Request-filtered destinations:',
        ...(requestPolicyDestinations.length > 0
          ? requestPolicyDestinations.map(destination => `- ${JSON.stringify(destination)}`)
          : ['No request-filtered destinations are configured.']),
      ].join('\n');

      return {systemPrompt: `${event.systemPrompt}\n\n${sandboxSystemPrompt}\n\n${accessSummary}`};
    });

    pi.on('tool_call', event => {
      if (!sandbox.isEnabled) {
        return;
      }

      if (event.toolName === 'research_scout' && !config.areResearchAgentsEnabled()) {
        return {block: true, reason: 'Research agents are disabled in sandbox configuration.'};
      }
    });

    pi.on('tool_result', async (event, ctx) => {
      if (!sandbox.isEnabled || !sandboxedTools.has(event.toolName)) {
        return;
      }

      const message = event.content
        .filter(entry => entry.type === 'text')
        .map(entry => entry.text)
        .join('\n');
      const reference = /Sandbox denial reference: (?<id>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/v.exec(message)?.groups?.id;
      const denial = reference === undefined ? undefined : sandbox.consumeNetworkDenial(reference);
      if (denial === undefined || !ctx.hasUI || this.isPromptInProgress) {
        return;
      }

      const violation = /deny network-outbound (?<host>.+):(?<port>\d+) \(host is not on the allow list\)/v.exec(denial);
      if (violation?.groups === undefined) {
        return;
      }

      await config.reload();
      const suggestedDomain = `${violation.groups.host}:${violation.groups.port}`;
      if (!config.shouldPrompt() || config.isDomainAllowed(suggestedDomain)) {
        return;
      }

      this.isPromptInProgress = true;
      try {
        const projectChoice = `Allow ${suggestedDomain} for this project? This will permanently alter the sandbox configuration for this project only. Use the "/sandbox" command to further customize sandbox settings.`;
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
