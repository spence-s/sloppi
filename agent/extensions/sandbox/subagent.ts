import {Buffer} from 'node:buffer';
import {join} from 'node:path';
import {
  createAgentSession,
  createExtensionRuntime,
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
import {SandboxTools} from './tools.ts';

const maxOutputBytes = 12 * 1024;
const maxCollapsedResultLines = 8;
const investigatingStatus = 'Investigating...';
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

type ScoutUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextTokens: number;
  cost: number;
  turns: number;
};

type ScoutActivity = {
  currentAction: string;
  elapsedMs: number;
  spinnerIndex: number;
  filesRead: number;
  searches: number;
  listings: number;
};

const scoutParameters = Type.Object({
  // TypeBox uses a capitalized function for optional schema fields.
  // eslint-disable-next-line new-cap
  agent: Type.Optional(Type.String({minLength: 1, description: 'Research agent profile. Defaults to scout.'})),
  task: Type.String({minLength: 1, description: 'The focused repository task for the selected agent'}),
});

type ScoutDetails = {
  agent: string;
  model: string;
  progress: string;
  activity?: ScoutActivity;
  usage?: ScoutUsage;
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
      // eslint-disable-next-line complexity -- this is the single renderer for compact, expanded, pending, and completed states.
      renderResult(result, {expanded, isPartial}, theme) {
        const {details} = result;
        const content = result.content.find(part => part.type === 'text');
        const finalResultText = content?.text ?? '(no output)';
        const isAborted = details?.activity === undefined
          && details?.progress === undefined
          && /aborted/iv.test(finalResultText);
        const progress = details?.progress ?? (isAborted ? '' : finalResultText);
        const activity = details?.activity;
        const usage = details?.usage;
        const elapsedSeconds = Math.max(0, Math.floor((activity?.elapsedMs ?? 0) / 1000));
        const elapsed = elapsedSeconds < 60
          ? `${String(elapsedSeconds)}s`
          : `${String(Math.floor(elapsedSeconds / 60))}m ${String(elapsedSeconds % 60).padStart(2, '0')}s`;
        const spinner = spinnerFrames[activity?.spinnerIndex ?? 0] ?? spinnerFrames[0] ?? '⠋';
        let status: string;
        if (isPartial) {
          status = `${spinner} ${activity?.currentAction ?? investigatingStatus} · ${elapsed}`;
        } else if (isAborted) {
          status = `⚠ ${finalResultText.replace(/[!.]$/v, '')}`;
        } else {
          status = `✓ Completed${activity === undefined ? '' : ` in ${elapsed}`}`;
        }

        const counters: string[] = [];
        if (activity?.filesRead !== undefined && activity.filesRead > 0) {
          counters.push(`${String(activity.filesRead)} file${activity.filesRead === 1 ? '' : 's'}`);
        }

        if (activity?.searches !== undefined && activity.searches > 0) {
          counters.push(`${String(activity.searches)} search${activity.searches === 1 ? '' : 'es'}`);
        }

        if (activity?.listings !== undefined && activity.listings > 0) {
          counters.push(`${String(activity.listings)} listing${activity.listings === 1 ? '' : 's'}`);
        }

        if (usage !== undefined && usage.turns > 0) {
          counters.push(`${String(usage.turns)} turn${usage.turns === 1 ? '' : 's'}`);
        }

        const container = new Container();
        const activityResult = new Box(4, 1, text => theme.bg('toolPendingBg', text));
        let statusColor: 'warning' | 'dim' | 'success' = isPartial ? 'dim' : 'success';
        if (isAborted) {
          statusColor = 'warning';
        }

        const statusText = theme.fg(statusColor, status);
        activityResult.addChild(new Text(statusText, 0, 0));
        if (counters.length > 0) {
          const counterText = theme.fg('dim', counters.join(' · '));
          activityResult.addChild(new Text(counterText, 0, 0));
        }

        if (usage !== undefined && usage.turns > 0) {
          const metrics = [
            `↑${usage.input.toLocaleString('en-US')}`,
            `↓${usage.output.toLocaleString('en-US')}`,
            `R${usage.cacheRead.toLocaleString('en-US')}`,
            `W${usage.cacheWrite.toLocaleString('en-US')}`,
            `$${usage.cost.toFixed(4)}`,
            `ctx:${usage.contextTokens.toLocaleString('en-US')}`,
          ].join(' ');
          activityResult.addChild(new Text(theme.fg('dim', metrics), 0, 0));
          if (expanded) {
            const modelText = theme.fg('dim', details?.model ?? '');
            activityResult.addChild(new Text(modelText, 0, 0));
          }
        }

        if (expanded) {
          activityResult.addChild(new Spacer(1));
          activityResult.addChild(new Text(progress, 0, 0));
          const expandedHint = isPartial
            ? `${keyHint('app.interrupt', 'to cancel')} · ${keyHint('app.tools.expand', 'to collapse')}`
            : keyHint('app.tools.expand', 'to collapse');
          activityResult.addChild(new Text(theme.fg('dim', expandedHint), 0, 0));
        } else if (isPartial) {
          activityResult.addChild(new Spacer(1));
          const pendingHint = `${keyHint('app.interrupt', 'to cancel')} · ${keyHint('app.tools.expand', 'activity')}`;
          activityResult.addChild(new Text(theme.fg('dim', pendingHint), 0, 0));
        } else {
          const completedHint = keyHint('app.tools.expand', 'activity');
          activityResult.addChild(new Text(theme.fg('dim', completedHint), 0, 0));
        }

        container.addChild(activityResult);
        if (isPartial || isAborted) {
          return container;
        }

        container.addChild(new Spacer(1));
        const finalResult = new Box(1, 0);
        const resultAgent = details?.agent ?? 'scout';
        const resultLabel = resultAgent.charAt(0).toUpperCase() + resultAgent.slice(1);
        const finalResultHeading = theme.fg('success', theme.bold(`${resultLabel} Research Result`));
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
  // eslint-disable-next-line complexity -- the child lifecycle owns setup, streaming, abort, and cleanup.
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
    const startedAt = Date.now();
    let progress = '';
    let currentAction = 'Starting agent...';
    let spinnerIndex = 0;
    let streamType: 'thinking' | undefined;
    const filesRead = new Set<string>();
    let searches = 0;
    let listings = 0;
    const usage: ScoutUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextTokens: 0,
      cost: 0,
      turns: 0,
    };
    const updateProgress = (): void => {
      const visibleProgress = progress.slice(-maxOutputBytes);
      onUpdate?.({
        content: [{type: 'text', text: visibleProgress}],
        details: {
          agent: agent.name,
          model: `${model.provider}/${model.id}`,
          progress: visibleProgress,
          activity: {
            currentAction,
            elapsedMs: Date.now() - startedAt,
            spinnerIndex,
            filesRead: filesRead.size,
            searches,
            listings,
          },
          usage: {...usage},
        },
      });
    };

    updateProgress();

    const enabledTools = new Set<string>(agent.tools);
    const tools = new SandboxTools(this.pi, this.cwd, this.sandbox);
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
      customTools: [tools.read, tools.find, tools.grep, tools.ls].filter(tool => enabledTools.has(tool.name)),
    });

    const abort = (): void => {
      void session.abort();
    };

    const spinnerInterval = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      updateProgress();
    }, 80);
    spinnerInterval.unref();

    // eslint-disable-next-line complexity -- one event stream owns all live child-session state.
    const unsubscribe = session.subscribe(event => {
      // The scout only needs streaming, tool-start, and completed-message events.
      // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
      switch (event.type) {
        case 'message_update': {
          const update = event.assistantMessageEvent;
          if (update.type === 'thinking_start' || update.type === 'thinking_delta') {
            currentAction = 'Thinking...';
            if (streamType !== 'thinking') {
              progress += '\n\nThinking:\n';
              streamType = 'thinking';
            }

            if (update.type === 'thinking_delta') {
              progress += update.delta;
            }

            updateProgress();
          } else if (update.type === 'text_start' || update.type === 'text_delta') {
            currentAction = 'Writing findings...';
            if (streamType === 'thinking') {
              progress += '\n\nWriting findings...';
              streamType = undefined;
            }

            updateProgress();
          }

          break;
        }

        case 'tool_execution_start': {
          const args: unknown = event.args as unknown;
          const path = typeof args === 'object' && args !== null && !Array.isArray(args) && 'path' in args && typeof args.path === 'string'
            ? args.path
            : undefined;
          const pattern = typeof args === 'object' && args !== null && !Array.isArray(args) && 'pattern' in args && typeof args.pattern === 'string'
            ? args.pattern
            : undefined;
          const shownPattern = pattern === undefined
            ? 'matches'
            : JSON.stringify(pattern.length > 80 ? `${pattern.slice(0, 77)}...` : pattern);
          const location = path === undefined ? '' : ` in ${path}`;
          let action: string;
          switch (event.toolName) {
            case 'read': {
              action = `Reading ${path ?? 'file'}`;
              break;
            }

            case 'grep': {
              action = `Searching for ${shownPattern}${location}`;
              break;
            }

            case 'find': {
              action = `Finding ${shownPattern}${location}`;
              break;
            }

            case 'ls': {
              action = `Listing ${path ?? 'directory'}`;
              break;
            }

            default: {
              action = `Running ${event.toolName}`;
              break;
            }
          }

          currentAction = action;
          if (event.toolName === 'read' && path !== undefined) {
            filesRead.add(path);
          } else if (event.toolName === 'grep' || event.toolName === 'find') {
            searches++;
          } else if (event.toolName === 'ls') {
            listings++;
          }

          streamType = undefined;
          progress += `\n\n→ ${event.toolName} ${JSON.stringify(event.args)}`;
          updateProgress();
          break;
        }

        case 'tool_execution_end': {
          currentAction = event.isError ? 'Reviewing tool error...' : 'Analyzing results...';
          updateProgress();
          break;
        }

        case 'message_end': {
          if (event.message.role === 'assistant') {
            if (currentAction !== 'Writing findings...') {
              currentAction = 'Analyzing results...';
            }

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

      if (message.stopReason === 'aborted') {
        throw new Error('Research Scout aborted.');
      }

      if (message.stopReason === 'error') {
        throw new Error(message.errorMessage ?? 'Research Scout failed.');
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
          progress: progress.slice(-maxOutputBytes),
          activity: {
            currentAction,
            elapsedMs: Date.now() - startedAt,
            spinnerIndex,
            filesRead: filesRead.size,
            searches,
            listings,
          },
          usage: {...usage},
        },
      };
    } catch (error) {
      if (signal?.aborted ?? (error instanceof Error && /aborted/iv.test(error.message))) {
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        const elapsed = elapsedSeconds < 60
          ? `${String(elapsedSeconds)}s`
          : `${String(Math.floor(elapsedSeconds / 60))}m ${String(elapsedSeconds % 60).padStart(2, '0')}s`;
        throw new Error(`Aborted after ${elapsed}.`, {cause: error});
      }

      throw error;
    } finally {
      clearInterval(spinnerInterval);
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      session.dispose();
    }
  }
}
