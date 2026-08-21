import {Buffer} from 'node:buffer';
import {join} from 'node:path';
import {
  createAgentSession,
  createExtensionRuntime,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  Box,
  Container,
  Markdown,
  Spacer,
  Text,
} from '@earendil-works/pi-tui';
import {Type} from 'typebox';
import {discoverResearchAgents} from './agents.ts';
import type {ConfigStore} from './config.ts';
import type {SandboxSessionManager} from './session-manager.ts';

const maxOutputBytes = 12 * 1024;
const maxCollapsedLines = 14;
const maxCollapsedResultLines = 8;
const investigatingStatus = 'Investigating...';
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const scoutParameters = Type.Object({
  // TypeBox uses a capitalized function for optional schema fields.
  // eslint-disable-next-line new-cap
  agent: Type.Optional(Type.String({minLength: 1, description: 'Research agent profile. Defaults to scout.'})),
  task: Type.String({minLength: 1, description: 'The focused repository task for the selected agent'}),
});

type ScoutDetails = {
  agent: string;
  model: string;
  task: string;
  truncated: boolean;
  progress: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextTokens: number;
    cost: number;
    turns: number;
  };
};

/**
 Gives each research agent an isolated context and only SRT-backed inspection tools.
 */
export class SandboxSubagent {
  pi: ExtensionAPI;
  cwd: string;
  sandbox: SandboxSessionManager;
  config: ConfigStore;

  /**
   Keeps delegation coupled to the sandbox and user-owned profile configuration.
   */
  constructor(pi: ExtensionAPI, cwd: string, sandbox: SandboxSessionManager, config: ConfigStore) {
    this.pi = pi;
    this.cwd = cwd;
    this.sandbox = sandbox;
    this.config = config;
  }

  /**
   Registers configurable research profiles behind one read-only tool.
   */
  register(): void {
    this.pi.registerTool<typeof scoutParameters, ScoutDetails>({
      name: 'research_scout',
      label: 'Research Scout',
      description: [
        'Send a focused repository task to an isolated, configurable read-only agent.',
        'Built-in profiles: scout, planner, reviewer.',
        'User profiles load from ~/.pi/agent/agents/*.md.',
        'Every profile remains limited to sandboxed read, grep, find, and list access.',
      ].join(' '),
      promptSnippet: 'Ask an isolated read-only agent to research, plan, or review repository work',
      promptGuidelines: ['Use research_scout with the scout, planner, or reviewer profile for bounded repository work; it cannot edit files or run shell commands.'],
      parameters: scoutParameters,
      renderShell: 'self',
      renderCall({agent = 'scout', task}, theme) {
        const call = new Box(1, 0, text => theme.bg('toolPendingBg', text));
        const title = theme.fg('accent', theme.bold('Research Scout'));
        call.addChild(new Text(`${title} ${theme.fg('warning', `[${agent}]`)} ${theme.fg('muted', task)}`, 0, 0));
        return call;
      },
      renderResult(result, {expanded, isPartial}, theme) {
        const {details} = result;
        const content = result.content.find(part => part.type === 'text');
        const progress = details?.progress ?? content?.text ?? '(no output)';
        let activity = progress;
        if (!expanded) {
          const lines = progress.split('\n');
          const hiddenLines = Math.max(0, lines.length - maxCollapsedLines);
          const visibleLines = lines.slice(-maxCollapsedLines).join('\n');
          const hint = hiddenLines > 0
            ? `${theme.fg('dim', `… ${String(hiddenLines)} earlier lines · ${keyHint('app.tools.expand', 'to expand')}`)}\n`
            : '';
          activity = hint + visibleLines;
        }

        activity = activity.split(investigatingStatus).join(theme.fg('dim', investigatingStatus));
        const container = new Container();
        const activityResult = new Box(4, 1, text => theme.bg('toolPendingBg', text));
        activityResult.addChild(new Text(activity, 0, 0));
        if (details !== undefined && details.usage.turns > 0) {
          const {usage} = details;
          const turns = `${String(usage.turns)} turn${usage.turns === 1 ? '' : 's'}`;
          const metrics = [
            turns,
            `↑${usage.input.toLocaleString('en-US')}`,
            `↓${usage.output.toLocaleString('en-US')}`,
            `R${usage.cacheRead.toLocaleString('en-US')}`,
            `W${usage.cacheWrite.toLocaleString('en-US')}`,
            `$${usage.cost.toFixed(4)}`,
            `ctx:${usage.contextTokens.toLocaleString('en-US')}`,
            details.model,
          ].join(' ');
          activityResult.addChild(new Spacer(1));
          activityResult.addChild(new Text(theme.fg('dim', metrics), 0, 0));
        }

        container.addChild(activityResult);
        if (isPartial) {
          return container;
        }

        container.addChild(new Spacer(1));
        const finalResult = new Box(1, 0);
        const resultAgent = details?.agent ?? 'scout';
        const resultLabel = resultAgent.charAt(0).toUpperCase() + resultAgent.slice(1);
        const finalResultHeading = theme.fg('success', theme.bold(`${resultLabel} Research Result`));
        const finalResultText = content?.text ?? '(no output)';
        const finalResultLines = finalResultText.split('\n');
        const hiddenResultLines = expanded ? 0 : Math.max(0, finalResultLines.length - maxCollapsedResultLines);
        const visibleResult = expanded
          ? finalResultText
          : finalResultLines.slice(0, maxCollapsedResultLines).join('\n');
        finalResult.addChild(new Text(finalResultHeading, 0, 0));
        finalResult.addChild(new Markdown(visibleResult, 0, 0, getMarkdownTheme()));
        if (hiddenResultLines > 0) {
          const expandHint = `… ${String(hiddenResultLines)} more lines · ${keyHint('app.tools.expand', 'to expand')}`;
          finalResult.addChild(new Text(theme.fg('dim', expandHint), 0, 0));
        }

        container.addChild(finalResult);
        return container;
      },
      execute: async (_toolCallId, {agent = 'scout', task}, signal, onUpdate, ctx) => this.run({agent: agent.trim(), task: task.trim()}, signal, onUpdate, ctx),
    });
  }

  /**
   Runs a fresh SDK session so the selected agent cannot inherit parent context.
   */
  async run(request: {agent: string; task: string}, signal: AbortSignal | undefined, onUpdate: Parameters<ToolDefinition<typeof scoutParameters, ScoutDetails>['execute']>[3], ctx: ExtensionContext) {
    const {agent: agentName, task} = request;
    if (task.length === 0) {
      throw new Error('The read-only delegation task cannot be empty.');
    }

    if (this.sandbox.session === undefined) {
      throw new Error('Read-only delegation is unavailable because the Sloppi sandbox is not active.');
    }

    const agents = discoverResearchAgents();
    const agent = agents.find(candidate => candidate.name === agentName);
    if (agent === undefined) {
      throw new Error(`Unknown research agent ${JSON.stringify(agentName)}. Available agents: ${agents.map(candidate => candidate.name).join(', ')}.`);
    }

    await this.config.load();
    let selectedModel = this.config.getResearchScoutModel();
    if (agent.model !== undefined) {
      const separator = agent.model.indexOf('/');
      if (separator <= 0 || separator === agent.model.length - 1) {
        throw new Error(`Research agent ${agent.name} model must use provider/model format.`);
      }

      selectedModel = {
        provider: agent.model.slice(0, separator),
        id: agent.model.slice(separator + 1),
      };
    }

    if (selectedModel === undefined) {
      throw new Error('Research Scout has no model. Select one with /sandbox global or configure one in the agent profile.');
    }

    const model = ctx.modelRegistry.find(selectedModel.provider, selectedModel.id);
    if (model === undefined) {
      throw new Error(`Research agent model ${selectedModel.provider}/${selectedModel.id} is not configured.`);
    }

    if (ctx.modelRegistry.getAvailable().every(available => available.provider !== model.provider || available.id !== model.id)) {
      throw new Error(`Research Scout model ${model.provider}/${model.id} is unavailable or has no configured authentication.`);
    }

    if (ctx.scopedModels.length > 0
      && ctx.scopedModels.every(({model: scoped}) => scoped.provider !== model.provider || scoped.id !== model.id)) {
      throw new Error(`Research Scout model ${model.provider}/${model.id} is outside this session's model scope.`);
    }

    const agentDir = getAgentDir();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
      ...(signal && {signal}),
    });
    const settingsManager = SettingsManager.inMemory({compaction: {enabled: false}});
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({extensions: [], errors: [], runtime: createExtensionRuntime()}),
      getSkills: () => ({skills: [], diagnostics: []}),
      getPrompts: () => ({prompts: [], diagnostics: []}),
      getThemes: () => ({themes: [], diagnostics: []}),
      getAgentsFiles: () => ({agentsFiles: []}),
      getSystemPrompt: () => [
        `You are the ${agent.name} research agent: ${agent.description}.`,
        'Use only the supplied inspection tools. Do not attempt to edit files, execute commands, access the host, or bypass sandbox restrictions.',
        agent.systemPrompt,
      ].join('\n'),
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources() {
        return undefined;
      },
      async reload() {
        return undefined;
      },
    };
    let progress = investigatingStatus;
    let spinnerIndex = 0;
    let streamType: 'thinking' | undefined;
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextTokens: 0,
      cost: 0,
      turns: 0,
    };
    const updateProgress = (): void => {
      const animatedProgress = progress
        .split(investigatingStatus)
        .join(`${spinnerFrames[spinnerIndex]} ${investigatingStatus}`);
      const visibleProgress = animatedProgress.slice(-maxOutputBytes);
      onUpdate?.({
        content: [{type: 'text', text: visibleProgress}],
        details: {
          agent: agent.name,
          model: `${model.provider}/${model.id}`,
          task,
          truncated: false,
          progress: visibleProgress,
          usage: {...usage},
        },
      });
    };

    updateProgress();

    const enabledTools = new Set<string>(agent.tools);
    const {session} = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      model,
      thinkingLevel: ctx.thinkingLevel ?? 'off',
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager,
      tools: agent.tools,
      customTools: this.createTools().filter(tool => enabledTools.has(tool.name)),
    });

    const abort = (): void => {
      void session.abort();
    };

    const spinnerInterval = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      updateProgress();
    }, 80);
    spinnerInterval.unref();

    const unsubscribe = session.subscribe(event => {
      // The scout only needs streaming, tool-start, and completed-message events.
      // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
      switch (event.type) {
        case 'message_update': {
          const update = event.assistantMessageEvent;
          if (update.type === 'thinking_delta') {
            if (streamType !== 'thinking') {
              progress += '\n\nThinking:\n';
              streamType = 'thinking';
            }

            progress += update.delta;
            updateProgress();
          }

          break;
        }

        case 'tool_execution_start': {
          streamType = undefined;
          progress += `\n\n→ ${event.toolName} ${JSON.stringify(event.args)}`;
          updateProgress();
          break;
        }

        case 'message_end': {
          if (event.message.role === 'assistant') {
            usage.input += event.message.usage.input;
            usage.output += event.message.usage.output;
            usage.cacheRead += event.message.usage.cacheRead;
            usage.cacheWrite += event.message.usage.cacheWrite;
            usage.contextTokens = event.message.usage.totalTokens;
            usage.cost += event.message.usage.cost.total;
            usage.turns++;
            updateProgress();
          } else if (event.message.role === 'toolResult') {
            const output = event.message.content
              .filter(part => part.type === 'text')
              .map(part => part.text)
              .join('\n');
            progress += `\n${event.message.isError ? '✗' : '←'} ${output.length > 0 ? output : '(no text output)'}`;
            updateProgress();
          }

          break;
        }

        default: {
          break;
        }
      }
    });

    signal?.addEventListener('abort', abort, {once: true});

    try {
      await session.prompt(task);
      const message = session.messages.findLast(entry => entry.role === 'assistant');
      if (message === undefined) {
        throw new Error('Research Scout ended without a response.');
      }

      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new Error(message.errorMessage ?? `Research Scout ${message.stopReason}.`);
      }

      const text = message.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('');
      const output = text.length > 0 ? text : '(The scout returned no findings.)';
      const isTruncated = Buffer.byteLength(output, 'utf8') > maxOutputBytes;
      const content = isTruncated
        ? `${Buffer.from(output).subarray(0, maxOutputBytes).toString('utf8')}\n\n[Scout output truncated.]`
        : output;
      return {
        content: [{type: 'text' as const, text: content}],
        details: {
          agent: agent.name,
          model: `${model.provider}/${model.id}`,
          task,
          truncated: isTruncated,
          progress: progress.slice(-maxOutputBytes),
          usage: {...usage},
        },
      };
    } finally {
      clearInterval(spinnerInterval);
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      session.dispose();
    }
  }

  /**
   Reuses the existing SRT session for every child filesystem operation.
   */
  createTools(): ToolDefinition[] {
    const {sandbox} = this;
    const read = createReadTool(this.cwd, {
      operations: {
        async access(path) {
          const result = await sandbox.run`test -r ${path}`;
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot read ${path}`);
          }
        },
        async readFile(path) {
          const result = await sandbox.run`base64 < ${path} | tr -d '\n'`;
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot read ${path}`);
          }

          return Buffer.from(result.stdout, 'base64');
        },
        async detectImageMimeType(path) {
          const result = await sandbox.run`file --mime-type -b -- ${path}`;
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot identify ${path}`);
          }

          const mime = result.stdout.trim();
          return ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(mime) ? mime : null;
        },
      },
    });
    const find = createFindTool(this.cwd, {
      operations: {
        async exists(path) {
          const result = await sandbox.run`test -e ${path}`;
          return result.exitCode === 0;
        },
        async glob(pattern, path, {ignore, limit}) {
          const name = pattern.includes('/') ? '-path' : '-name';
          const match = name === '-path' ? `*${pattern}` : pattern;
          const result = await sandbox.run`${['find', path, '-type', 'f', ...ignore.flatMap(entry => ['!', '-path', `*${entry}`]), name, match, '-print']}`;
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot find ${pattern}`);
          }

          return result.stdout.trim().split('\n').filter(Boolean).slice(0, limit);
        },
      },
    });
    const ls = createLsTool(this.cwd, {
      operations: {
        async exists(path) {
          const result = await sandbox.run`test -e ${path}`;
          return result.exitCode === 0;
        },
        async stat(path) {
          const exists = await sandbox.run`test -e ${path}`;
          if (exists.exitCode !== 0) {
            throw new Error(`Path not found: ${path}`);
          }

          const directory = await sandbox.run`test -d ${path}`;
          return {isDirectory: () => directory.exitCode === 0};
        },
        async readdir(path) {
          const result = await sandbox.run`ls -1A -- ${path}`;
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot list ${path}`);
          }

          return result.stdout.trim().split('\n').filter(Boolean);
        },
      },
    });
    const grep = {
      ...createGrepTool(this.cwd),
      async execute(_id: string, {pattern, path = '.', glob, ignoreCase, literal, context, limit = 100}: {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      }) {
        const arguments_ = ['rg', '--line-number', '--color=never', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**'];
        if (ignoreCase === true) {
          arguments_.push('--ignore-case');
        }

        if (literal === true) {
          arguments_.push('--fixed-strings');
        }

        if (glob !== undefined) {
          arguments_.push('--glob', glob);
        }

        if (context !== undefined && context > 0) {
          arguments_.push('--context', String(context));
        }

        arguments_.push('--', pattern, path);

        const result = await sandbox.run`${arguments_}`;
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `rg failed (${String(result.exitCode)})`);
        }

        const output = result.stdout.trim().split('\n').filter(Boolean).slice(0, limit).join('\n');
        return {content: [{type: 'text' as const, text: output.length > 0 ? output : 'No matches found'}], details: undefined};
      },
    };

    return [read, find, grep, ls];
  }
}
