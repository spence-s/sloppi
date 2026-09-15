import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {
  Container,
  Input,
  type SettingItem,
  SettingsList,
  SelectList,
  Text,
} from '@earendil-works/pi-tui';
import type {
  ConfigScope,
  ConfigStore,
  FilesystemAccess,
  NetworkPermission,
} from './config.ts';
import type {PlaywrightBridge} from './playwright.ts';
import type {SandboxSessionManager} from './session-manager.ts';

type FilesystemAction = {
  access: FilesystemAccess;
  path: string;
};

type NetworkRuleSelection = {
  effectiveEntries: string[];
  globalEntries: Set<string>;
  projectEntries: Set<string>;
  scope: ConfigScope;
};

export class SandboxCommand {
  config: ConfigStore;
  sandbox: SandboxSessionManager;
  playwright: PlaywrightBridge | undefined;

  constructor(config: ConfigStore, sandbox: SandboxSessionManager, playwright?: PlaywrightBridge) {
    this.config = config;
    this.sandbox = sandbox;
    this.playwright = playwright;
  }

  /** Shows the current tool-execution boundary in Pi's shared status area. */
  setStatus(ctx: ExtensionCommandContext): void {
    ctx.ui.setStatus(
      'sandbox',
      this.sandbox.isEnabled
        ? `${ctx.ui.theme.bold(ctx.ui.theme.fg('success', '󰕥'))} ${ctx.ui.theme.fg('muted', 'sandbox')}`
        : `${ctx.ui.theme.bold(ctx.ui.theme.fg('warning', '󰒲'))} ${ctx.ui.theme.fg('warning', 'sandbox off')}`,
    );
  }

  /** Switches tool execution between SRT and the host for this session. */
  async setEnabled(ctx: ExtensionCommandContext, isEnabled: boolean): Promise<void> {
    if (isEnabled === this.sandbox.isEnabled) {
      ctx.ui.notify(`Sandbox is already ${isEnabled ? 'on' : 'off'}.`, 'info');
      return;
    }

    if (!isEnabled && !await ctx.ui.confirm(
      'Turn off the sandbox?',
      'All tool calls will execute directly on the host with your user permissions for this session.',
    )) {
      return;
    }

    await this.sandbox.setEnabled(isEnabled);
    if (!isEnabled) {
      await this.playwright?.stop();
    }

    this.setStatus(ctx);
    ctx.ui.notify(`Sandbox is ${isEnabled ? 'on' : 'off'} for this session.`, isEnabled ? 'info' : 'warning');
  }

  async finish(ctx: ExtensionCommandContext, message: string): Promise<void> {
    await this.sandbox.restartSession();
    ctx.ui.notify(message, 'info');
  }

  /** Shows effective access without exposing the underlying SRT configuration format. */
  async show(ctx: ExtensionCommandContext): Promise<void> {
    if (!this.sandbox.isEnabled) {
      ctx.ui.notify('Sandbox is off. Tools currently have unrestricted access to the host.', 'warning');
      return;
    }

    await this.config.reload();
    const runtime = SandboxManager.getConfig();
    const readable = runtime?.filesystem?.allowRead ?? [];
    const writable = runtime?.filesystem?.allowWrite ?? [];
    const hidden = runtime?.filesystem?.denyRead ?? [];
    const readOnly = runtime?.filesystem?.denyWrite ?? [];
    const allowed = runtime?.network?.allowedDomains ?? [];
    const blocked = runtime?.network?.deniedDomains ?? [];
    const lines = [
      'Effective sandbox access',
      '',
      'Session',
      '  Protection: On',
      '',
      'Files and folders',
      `  Readable: ${readable.length === 0 ? 'No additional locations' : readable.join(', ')}`,
      `  Writable: ${writable.length === 0 ? 'No locations' : writable.join(', ')}`,
      `  Hidden: ${hidden.length === 0 ? 'None' : hidden.join(', ')}`,
      `  Read-only: ${readOnly.length === 0 ? 'None' : readOnly.join(', ')}`,
      '',
      'Websites and services',
      `  Allowed: ${allowed.length === 0 ? 'None' : allowed.join(', ')}`,
      `  Blocked: ${blocked.length === 0 ? 'None' : blocked.join(', ')}`,
      `  Ask when blocked: ${this.config.shouldPrompt() ? 'On' : 'Off'}`,
      '',
      `Research agents: ${this.config.areResearchAgentsEnabled() ? 'On' : 'Off'}`,
    ];
    ctx.ui.notify(lines.join('\n'), 'info');
  }

  /** Lets the user configure scoped delegation or its global default model. */
  async manageResearchAgents(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    await this.config.load();
    const scopedSetting = this.config.getResearchAgentsSetting(scope);
    const action = await ctx.ui.select('Research agents', scope === 'global'
      ? [scopedSetting === true ? 'Turn off' : 'Turn on', 'Default model']
      : ['Turn on', 'Turn off', 'Use global setting']);
    if (action === undefined) {
      return;
    }

    if (action === 'Default model') {
      await this.manageResearchScoutModel(ctx);
      return;
    }

    await this.config.setResearchAgentsEnabled(scope, action === 'Use global setting' ? undefined : action === 'Turn on');
    const isNextEnabled = this.config.areResearchAgentsEnabled();
    const activeTools = pi.getActiveTools().filter(name => name !== 'research_scout');
    pi.setActiveTools(isNextEnabled ? [...activeTools, 'research_scout'] : activeTools);
    ctx.ui.notify(
      action === 'Use global setting'
        ? `Research agents now use the global setting and are ${isNextEnabled ? 'on' : 'off'}.`
        : `Research agents are ${action === 'Turn on' ? 'on' : 'off'} in ${scope} scope.`,
      'info',
    );
  }

  /** Lets the user select the default model for research profiles. */
  async manageResearchScoutModel(ctx: ExtensionCommandContext): Promise<void> {
    await this.config.load();
    const current = this.config.getResearchScoutModel();
    const models = ctx.modelRegistry.getAvailable();
    const choices = models.map(model => `${model.provider}/${model.id}`);
    const selection = await ctx.ui.select(
      `Research Scout model${current === undefined ? '' : ` (${current.provider}/${current.id})`}`,
      [...choices, 'Clear model'],
    );
    if (selection === undefined) {
      return;
    }

    if (selection === 'Clear model') {
      await this.config.setResearchScoutModel(undefined);
      ctx.ui.notify('Default Research Scout model cleared; profiles without their own model are disabled.', 'info');
      return;
    }

    const model = models[choices.indexOf(selection)];
    if (model === undefined) {
      throw new Error('Selected Research Scout model is unavailable.');
    }

    await this.config.setResearchScoutModel({provider: model.provider, id: model.id});
    ctx.ui.notify(`Research Scout will use ${model.provider}/${model.id}.`, 'info');
  }

  /** Prevents project menus from deleting inherited website settings. */
  async selectNetworkRuleToRemove(ctx: ExtensionCommandContext, selection: NetworkRuleSelection): Promise<string | undefined> {
    const {effectiveEntries, globalEntries, projectEntries, scope} = selection;
    const choices = effectiveEntries.map(entry => {
      const sources = [
        projectEntries.has(entry) ? 'project' : '',
        globalEntries.has(entry) ? 'global' : '',
      ].filter(Boolean);
      return `${entry} [${sources.length === 0 ? 'Sloppi default' : sources.join(', ')}]`;
    });
    if (choices.length === 0) {
      ctx.ui.notify('No matching website or service settings.', 'info');
      return undefined;
    }

    const choice = await ctx.ui.select('Choose a website or service setting to remove', choices);
    if (choice === undefined) {
      return undefined;
    }

    const entry = effectiveEntries[choices.indexOf(choice)];
    const scopedEntries = scope === 'global' ? globalEntries : projectEntries;
    if (entry !== undefined && scopedEntries.has(entry)) {
      return entry;
    }

    const source = projectEntries.has(entry ?? '') ? 'project' : (globalEntries.has(entry ?? '') ? 'global' : 'Sloppi default');
    const command = source === 'global' ? '/sandbox global' : '/sandbox';
    ctx.ui.notify(
      source === 'Sloppi default'
        ? 'Sloppi default rules cannot be removed from configuration.'
        : `That rule belongs to ${source} scope. Use ${command} to remove it.`,
      'info',
    );
    return undefined;
  }

  /** Shows configured locations as editable rows and adds new locations read-only. */
  async manageFilesystem(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('File and folder settings require interactive TUI mode.', 'error');
      return;
    }

    await this.config.reload();
    const {filesystem} = this.config.getScopedSrtConfig(scope);
    const readable = new Set(filesystem?.allowRead);
    const writable = new Set(filesystem?.allowWrite);
    const hidden = new Set(filesystem?.denyRead);
    const readOnly = new Set(filesystem?.denyWrite);
    const paths = [...readable.union(writable).union(hidden).union(readOnly)].toSorted((a, b) => a.localeCompare(b));
    const result = await ctx.ui.custom<FilesystemAction | undefined>((tui, theme, _keybindings, done) => {
      let activeInput: Input | undefined;
      let isFocused = false;
      const items: SettingItem[] = paths.map(path => {
        let currentValue = 'Read only';
        if (hidden.has(path)) {
          currentValue = 'No access';
        } else if (writable.has(path) && !readOnly.has(path)) {
          currentValue = 'Read and change';
        }

        return {
          id: path,
          label: path,
          currentValue,
          description: 'Select this location to change what Pi can do there.',
          submenu() {
            activeInput = undefined;
            const choices: Array<{value: FilesystemAccess; label: string; description: string}> = [
              {value: 'readWrite', label: 'Read and change', description: 'Pi can view, create, edit, and delete files.'},
              {value: 'readOnly', label: 'Read only', description: 'Pi can view files but cannot change them.'},
              {value: 'none', label: 'No access', description: 'Pi cannot view or change files.'},
            ];
            const selectList = new SelectList(choices, choices.length, getSelectListTheme());
            selectList.setSelectedIndex(Math.max(0, choices.findIndex(choice => choice.label === currentValue)));
            selectList.onSelect = choice => {
              const access: FilesystemAccess = choice.value === 'readWrite'
                ? 'readWrite'
                : (choice.value === 'none' ? 'none' : 'readOnly');

              done({path, access});
            };

            selectList.onCancel = () => {
              done(undefined);
            };

            return selectList;
          },
        };
      });
      items.push({
        id: 'add',
        label: 'Add a location…',
        currentValue: 'Read only',
        description: 'Enter an absolute file or folder path. New locations are read-only.',
        submenu() {
          const input = new Input({prompt: 'Location: ', placeholder: '/Users/me/Documents'});
          const error = new Text('', 0, 0);
          activeInput = input;
          input.focused = isFocused;
          input.onSubmit = value => {
            const path = value.trim();
            if (!path.startsWith('/')) {
              error.setText(theme.fg('error', 'Enter an absolute path beginning with /.'));
              tui.requestRender();
              return;
            }

            done({path, access: 'readOnly'});
          };

          input.onEscape = () => {
            done(undefined);
          };

          const inputContainer = new Container();
          const inputTitle = theme.fg('accent', theme.bold('Add a read-only location'));
          inputContainer.addChild(new Text(inputTitle, 0, 0));
          inputContainer.addChild(input);
          inputContainer.addChild(error);

          return {
            get focused() {
              return input.focused;
            },
            set focused(value: boolean) {
              input.focused = value;
            },
            render(width: number) {
              return inputContainer.render(width);
            },
            handleInput(data: string) {
              input.handleInput(data);
            },
            handleMouse(event) {
              return inputContainer.handleMouse(event);
            },
            invalidate() {
              inputContainer.invalidate();
            },
          };
        },
      });

      const container = new Container();
      const scopeLabel = scope === 'project' ? 'This project' : 'Global defaults';
      const title = theme.fg('accent', theme.bold(`Files and folders — ${scopeLabel}`));
      const description = theme.fg('muted', 'Select a location to change its access.');
      container.addChild(new Text(title, 0, 0));
      container.addChild(new Text(description, 0, 1));
      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (_id, _newValue) => undefined,
        () => {
          done(undefined);
        },
      );
      container.addChild(settingsList);

      return {
        get focused() {
          return isFocused;
        },
        set focused(value: boolean) {
          isFocused = value;
          if (activeInput !== undefined) {
            activeInput.focused = value;
          }
        },
        render(width: number) {
          return container.render(width);
        },
        handleInput(data: string) {
          settingsList.handleInput(data);
          tui.requestRender();
        },
        handleMouse(event) {
          return settingsList.handleMouse(event);
        },
        invalidate() {
          container.invalidate();
        },
      };
    });
    if (result === undefined) {
      return;
    }

    await this.config.setFilesystemAccess(scope, result.path, result.access);
    await this.finish(ctx, `${result.path} is now ${result.access === 'readWrite' ? 'readable and writable' : (result.access === 'readOnly' ? 'read-only' : 'blocked')}.`);
    return this.manageFilesystem(ctx, scope);
  }

  /** Adds or removes network access without exposing SRT field names. */
  async manageNetwork(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const action = await ctx.ui.select('Websites and services', ['Add destination', 'Remove destination']);
    if (action === undefined) {
      return;
    }

    const permissionChoice = await ctx.ui.select(
      'What should happen?',
      ['Allow connections', 'Block connections'],
    );
    if (permissionChoice === undefined) {
      return;
    }

    const permission: NetworkPermission = permissionChoice === 'Allow connections' ? 'allow' : 'deny';
    let domain: string | undefined;
    let reason: string | undefined;
    if (action === 'Add destination') {
      domain = await ctx.ui.input('Website or service (for example, api.example.com:443)');
      if (permission === 'deny' && domain !== undefined && domain.trim().length > 0) {
        reason = await ctx.ui.input('What should Pi tell the model when this is blocked? (optional)');
      }
    } else {
      await this.config.reload();
      const globalConfig = this.config.getScopedSrtConfig('global');
      const projectConfig = this.config.getScopedSrtConfig('project');
      const effectiveConfig = this.config.getEffectiveConfig();
      const runtimeConfig = SandboxManager.getConfig();
      const key = permission === 'allow' ? 'allowedDomains' : 'deniedDomains';
      const globalEntries = new Set(globalConfig.network?.[key]);
      const projectEntries = new Set(projectConfig.network?.[key]);
      const effectiveEntries = [...new Set([
        ...(effectiveConfig.network?.[key] ?? []),
        ...(runtimeConfig?.network?.[key] ?? []),
      ])];
      domain = await this.selectNetworkRuleToRemove(ctx, {
        effectiveEntries,
        globalEntries,
        projectEntries,
        scope,
      });
    }

    if (domain === undefined || domain.trim().length === 0) {
      return;
    }

    const normalizedReason = reason?.trim();
    const listAction = action === 'Add destination' ? 'add' : 'remove';
    await this.config.updateDomain(
      scope,
      permission,
      listAction,
      domain.trim(),
      normalizedReason === undefined || normalizedReason.length === 0 ? undefined : normalizedReason,
    );
    await this.finish(ctx, `${listAction === 'add' ? 'Added' : 'Removed'} ${domain.trim()} in ${scope} network rules.`);
  }

  /** Keeps the settings browser open until Escape is pressed at its top level. */
  async manage(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    await this.config.reload();
    const scopeLabel = scope === 'project' ? 'This project' : 'Global defaults';
    const scopedConfig = this.config.getScopedConfig(scope);
    const scopedPrompting = scopedConfig.sandbox?.promptOnNetworkDeny;
    const promptingValue = scope === 'project' && scopedPrompting === undefined
      ? `Use global setting (${this.config.shouldPrompt() ? 'On' : 'Off'})`
      : ((scopedPrompting ?? true) ? 'On' : 'Off');
    const scopedResearch = this.config.getResearchAgentsSetting(scope);
    const researchValue = scope === 'project' && scopedResearch === undefined
      ? `Use global setting (${this.config.areResearchAgentsEnabled() ? 'On' : 'Off'})`
      : ((scopedResearch ?? false) ? 'On' : 'Off');
    const toggleAction = this.sandbox.isEnabled ? 'Turn off session protection' : 'Turn on session protection';
    const promptingAction = `Ask when a website is blocked — ${promptingValue}`;
    const researchAction = `Research agents — ${researchValue}`;
    const action = await ctx.ui.select(`Sandbox — ${scopeLabel}`, [
      toggleAction,
      'View effective access',
      'Files and folders',
      'Websites and services',
      promptingAction,
      researchAction,
      scope === 'project' ? 'Manage global defaults' : 'Manage this project',
      `Reset ${scopeLabel.toLowerCase()}…`,
    ]);
    if (action === undefined) {
      return;
    }

    switch (action) {
      case 'Turn off session protection':
      case 'Turn on session protection': {
        await this.setEnabled(ctx, !this.sandbox.isEnabled);
        break;
      }

      case 'View effective access': {
        await this.show(ctx);
        break;
      }

      case 'Files and folders': {
        await this.manageFilesystem(ctx, scope);
        break;
      }

      case 'Websites and services': {
        await this.manageNetwork(ctx, scope);
        break;
      }

      case promptingAction: {
        const prompting = await ctx.ui.select('Ask when a website is blocked?', ['On', 'Off']);
        if (prompting !== undefined) {
          await this.config.setPrompting(scope, prompting === 'On');
          await this.finish(ctx, `Blocked-website prompts are ${prompting.toLowerCase()} for ${scopeLabel.toLowerCase()}.`);
        }

        break;
      }

      case researchAction: {
        await this.manageResearchAgents(pi, ctx, scope);
        break;
      }

      case 'Manage global defaults': {
        return this.manage(pi, ctx, 'global');
      }

      case 'Manage this project': {
        return this.manage(pi, ctx, 'project');
      }

      default: {
        if (action.startsWith('Reset ') && await ctx.ui.confirm(
          `Reset ${scopeLabel.toLowerCase()}?`,
          `Remove every sandbox setting stored for ${scopeLabel.toLowerCase()}?`,
        )) {
          await this.config.resetScope(scope);
          await this.finish(ctx, `Reset sandbox settings for ${scopeLabel.toLowerCase()}.`);
        }
      }
    }

    return this.manage(pi, ctx, scope);
  }

  /** Registers the interactive settings command and its non-interactive shortcuts. */
  register(pi: ExtensionAPI): void {
    pi.registerCommand('sandbox', {
      description: 'Manage sandbox protection and access in plain language.',
      handler: async (rawArguments, ctx) => {
        const argument = rawArguments.trim();
        try {
          if (['on', 'off', 'toggle'].includes(argument)) {
            await this.setEnabled(ctx, argument === 'toggle' ? !this.sandbox.isEnabled : argument === 'on');
            return;
          }

          if (argument === 'status') {
            this.setStatus(ctx);
            ctx.ui.notify(`Sandbox is ${this.sandbox.isEnabled ? 'on' : 'off'} for this session.`, 'info');
            return;
          }

          if (argument !== '' && argument !== 'global') {
            ctx.ui.notify('Use /sandbox. Optional shortcuts are global, on, off, toggle, and status.', 'error');
            return;
          }

          await this.manage(pi, ctx, argument === 'global' ? 'global' : 'project');
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  }
}
