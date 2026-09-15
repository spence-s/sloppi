import {homedir} from 'node:os';
import {parse, resolve} from 'node:path';
import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  getKeybindings,
  type SettingItem,
  SettingsList,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import type {
  ConfigScope,
  ConfigStore,
  FilesystemPermission,
  NetworkPermission,
} from './config.ts';
import type {PlaywrightBridge} from './playwright.ts';
import type {SandboxSessionManager} from './session-manager.ts';

type FilesystemAccess = 'readWrite' | 'readOnly' | 'none';
type FilesystemAction =
  | {action: 'set'; access: FilesystemAccess; path: string}
  | {action: 'remove'; path: string};

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
      'Turn off session protection?',
      'Are you sure? All tool calls will execute directly on the host with your user permissions for this session.',
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

  /** Restarts SRT so a saved setting is active before reporting success. */
  async restartSessionAndNotify(ctx: ExtensionCommandContext, message: string): Promise<void> {
    await this.sandbox.restartSession();
    ctx.ui.notify(message, 'info');
  }

  /** Lets the user configure scoped delegation or its global default model. */
  async manageResearchAgents(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    await this.config.load();
    const scopedSetting = this.config.getResearchAgentsSetting(scope);
    const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
    const action = await ctx.ui.select(`Research agents — ${scopeLabel}`, scope === 'global'
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
    const models = new Map(ctx.modelRegistry.getAvailable().map(model => [`${model.provider}/${model.id}`, model]));
    const selection = await ctx.ui.select(
      `Research Scout model — 󰖟 GLOBAL${current === undefined ? '' : ` (${current.provider}/${current.id})`}`,
      [...models.keys(), 'Clear model'],
    );
    if (selection === undefined) {
      return;
    }

    if (selection === 'Clear model') {
      await this.config.setResearchScoutModel(undefined);
      ctx.ui.notify('Default Research Scout model cleared; profiles without their own model are disabled.', 'info');
      return;
    }

    const model = models.get(selection);
    if (model === undefined) {
      throw new Error('Selected Research Scout model is unavailable.');
    }

    await this.config.setResearchScoutModel({provider: model.provider, id: model.id});
    ctx.ui.notify(`Research Scout will use ${model.provider}/${model.id}.`, 'info');
  }

  /** Prevents project menus from deleting inherited website settings. */
  async selectNetworkRuleToRemove(ctx: ExtensionCommandContext, selection: NetworkRuleSelection): Promise<string | undefined> {
    const {effectiveEntries, globalEntries, projectEntries, scope} = selection;
    const entries = new Map(effectiveEntries.map(entry => {
      const sources = [
        projectEntries.has(entry) ? 'project' : '',
        globalEntries.has(entry) ? 'global' : '',
      ].filter(Boolean);
      return [`${entry} [${sources.length === 0 ? 'Sloppi default' : sources.join(', ')}]`, entry];
    }));
    if (entries.size === 0) {
      ctx.ui.notify('No matching website or service settings.', 'info');
      return undefined;
    }

    const scopeLabel = selection.scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
    const choice = await ctx.ui.select(`Remove website or service access — ${scopeLabel}`, entries.keys().toArray());
    if (choice === undefined) {
      return undefined;
    }

    const entry = entries.get(choice);
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

  /** Shows effective locations while allowing scoped rules to be added or removed directly. */
  async manageFilesystem(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('File and folder settings require interactive TUI mode.', 'error');
      return;
    }

    await this.config.reload();
    const projectRoot = this.config.cwd;
    const systemRoot = parse(projectRoot).root;
    const home = homedir();
    const globalFilesystem = this.config.getScopedSrtConfig('global').filesystem;
    const projectFilesystem = this.config.getScopedSrtConfig('project').filesystem;
    const effectiveFilesystem = this.config.getEffectiveConfig().filesystem;
    const runtimeFilesystem = SandboxManager.getConfig()?.filesystem;
    const globalPaths = new Set([
      ...(globalFilesystem?.allowRead ?? []),
      ...(globalFilesystem?.allowWrite ?? []),
      ...(globalFilesystem?.denyRead ?? []),
      ...(globalFilesystem?.denyWrite ?? []),
    ].map(path => resolve(projectRoot, path)));
    const projectPaths = new Set([
      ...(projectFilesystem?.allowRead ?? []),
      ...(projectFilesystem?.allowWrite ?? []),
      ...(projectFilesystem?.denyRead ?? []),
      ...(projectFilesystem?.denyWrite ?? []),
    ].map(path => resolve(projectRoot, path)));
    const readable = new Set([
      systemRoot,
      projectRoot,
      ...(runtimeFilesystem?.allowRead ?? effectiveFilesystem?.allowRead ?? []).map(path => resolve(projectRoot, path)),
    ]);
    const writable = new Set([
      projectRoot,
      ...(runtimeFilesystem?.allowWrite ?? effectiveFilesystem?.allowWrite ?? []).map(path => resolve(projectRoot, path)),
    ]);
    const hidden = new Set([
      home,
      ...(runtimeFilesystem?.denyRead ?? effectiveFilesystem?.denyRead ?? []).map(path => resolve(projectRoot, path)),
    ]);
    const readOnlyEntries = runtimeFilesystem?.denyWrite ?? effectiveFilesystem?.denyWrite ?? [];
    const readOnly = new Set(readOnlyEntries.map(path => resolve(projectRoot, path)));
    const allPaths = readable.union(writable).union(hidden).union(readOnly).union(globalPaths).union(projectPaths);
    const paths = [
      systemRoot,
      ...(home === systemRoot ? [] : [home]),
      ...([systemRoot, home].includes(projectRoot) ? [] : [projectRoot]),
      ...[...allPaths]
        .filter(path => path !== systemRoot && path !== projectRoot && path !== home)
        .toSorted((a, b) => a.localeCompare(b)),
    ];
    const editablePaths = scope === 'global' ? globalPaths : projectPaths;
    const result = await ctx.ui.custom<FilesystemAction | undefined>((tui, theme, keybindings, done) => {
      let isFocused = false;
      const pathItems: SettingItem[] = paths.map(path => {
        const isFixed = [systemRoot, projectRoot, home].includes(path);
        const isEditable = editablePaths.has(path) && !isFixed;
        const sources = [
          globalPaths.has(path) ? 'global defaults' : '',
          projectPaths.has(path) ? 'this project' : '',
        ].filter(Boolean);
        const fixedSourceNote = sources.length === 0
          ? ''
          : ` A stored ${sources.join(' and ')} setting also references this location, but built-in access wins.`;
        let accessLabel = 'Read only';
        let description = sources.length === 0 ? 'Built into the sandbox.' : `Configured by ${sources.join(' and ')}.`;
        let label = path;
        switch (path) {
          case systemRoot: {
            label = `Filesystem root (${path})`;
            description = `The filesystem is always available for reading. More specific locations below may be restricted.${fixedSourceNote}`;
            break;
          }

          case projectRoot: {
            accessLabel = 'Read/Write';
            label = `Project folder (${path})`;
            description = `The project folder is always available for reading and changes.${fixedSourceNote}`;
            break;
          }

          case home: {
            accessLabel = 'No access';
            label = `Home folder (${path})`;
            description = `Your home folder is blocked. Locations listed below it are explicit exceptions.${fixedSourceNote}`;
            break;
          }

          default: {
            if (hidden.has(path)) {
              accessLabel = 'No access';
            } else if (writable.has(path) && !readOnly.has(path)) {
              accessLabel = 'Read/Write';
            }

            if (sources.length > 0 && !editablePaths.has(path)) {
              description += scope === 'project'
                ? ' Change it under Global defaults.'
                : ' Change it under This project.';
            }
          }
        }

        const sourceLabels = [
          isFixed || sources.length === 0 ? 'Built in' : '',
          globalPaths.has(path) ? 'Global' : '',
          projectPaths.has(path) ? 'Local' : '',
        ].filter(Boolean);
        const currentValue = `${accessLabel.padEnd(16)}${sourceLabels.join(' + ')}`;
        const shortLabel = truncateToWidth(label, 36, '…');
        const item: SettingItem = {
          id: path,
          label: isEditable ? shortLabel : theme.fg('dim', shortLabel),
          currentValue: isEditable ? currentValue : theme.fg('dim', currentValue),
          description: `${description} Full path: ${path}`,
        };
        if (!isEditable) {
          return item;
        }

        item.submenu = () => {
          const choices: Array<{value: FilesystemAccess | 'remove'; label: string; description: string}> = [
            {value: 'readWrite', label: 'Read/Write', description: 'Pi can view, create, edit, and delete files.'},
            {value: 'readOnly', label: 'Read only', description: 'Pi can view files but cannot change them.'},
            {value: 'none', label: 'No access', description: 'Pi cannot view or change files.'},
            {
              value: 'remove',
              label: 'Remove location',
              description: `Remove this path from ${scope === 'global' ? 'global' : 'project'} filesystem rules.`,
            },
          ];
          const selectList = new SelectList(choices, choices.length, getSelectListTheme());
          selectList.setSelectedIndex(Math.max(0, choices.findIndex(choice => choice.label === accessLabel)));
          selectList.onSelect = choice => {
            if (choice.value === 'remove') {
              done({action: 'remove', path});
              return;
            }

            const access: FilesystemAccess = choice.value === 'readWrite'
              ? 'readWrite'
              : (choice.value === 'none' ? 'none' : 'readOnly');
            done({action: 'set', path, access});
          };

          selectList.onCancel = () => {
            done(undefined);
          };

          return selectList;
        };

        return item;
      });
      const builtInItems = pathItems.filter(item => {
        const path = item.id;
        return path !== projectRoot
          && (path === systemRoot || path === home || (!globalPaths.has(path) && !projectPaths.has(path)));
      });
      const builtInPaths = new Set(builtInItems.map(item => item.id));
      const globalItems = pathItems.filter(item => globalPaths.has(item.id) && !builtInPaths.has(item.id) && item.id !== projectRoot);
      const projectItem = pathItems.find(item => item.id === projectRoot);
      const localItems = pathItems.filter(item => projectPaths.has(item.id) && !builtInPaths.has(item.id) && !globalPaths.has(item.id) && item.id !== projectRoot);
      const builtInsHidden = theme.fg('dim', `${'Show'.padEnd(16)}Built in`);
      const builtInsShown = theme.fg('dim', `${'Hide'.padEnd(16)}Built in`);
      const items: SettingItem[] = [
        {
          id: 'built-in',
          label: theme.fg('dim', `Built-in locations (${builtInItems.length})…`),
          currentValue: builtInsHidden,
          values: [builtInsHidden, builtInsShown],
          description: 'Show or hide the fixed locations required by the sandbox.',
        },
        ...globalItems,
        ...(projectItem === undefined ? [] : [projectItem]),
        ...localItems,
        {
          id: 'location-spacer',
          label: '',
          currentValue: '',
        },
        {
          id: 'add',
          label: 'Add a location…',
          currentValue: `${'Read only'.padEnd(16)}${scope === 'global' ? 'Global' : 'Local'}`,
          values: [`${'Read only'.padEnd(16)}${scope === 'global' ? 'Global' : 'Local'}`],
          description: 'Enter an absolute path or a path relative to this project. New locations are read-only.',
        },
      ];

      let locationMode: 'closed' | 'path' | 'access' = 'closed';
      let pendingLocation = '';
      const locationInput = new Editor(tui, {
        borderColor: text => theme.fg('borderMuted', text),
        selectList: getSelectListTheme(),
      }, {autocompleteMaxVisible: 6});
      locationInput.setAutocompleteProvider(new CombinedAutocompleteProvider([], projectRoot));
      const locationError = new Text('', 0, 0);
      const locationInputContainer = new Container();
      locationInputContainer.addChild(new Text(theme.fg('muted', '  Location (Tab to browse):'), 0, 0));
      locationInputContainer.addChild(locationInput);
      locationInputContainer.addChild(locationError);
      locationInput.onSubmit = value => {
        let enteredPath = value.trim();
        if (enteredPath.startsWith('"') && enteredPath.endsWith('"')) {
          enteredPath = enteredPath.slice(1, -1);
        }

        if (enteredPath.length === 0) {
          locationError.setText(theme.fg('error', '  Enter a file or folder path.'));
          tui.requestRender();
          return;
        }

        const path = enteredPath === '~'
          ? home
          : (enteredPath.startsWith('~/')
            ? resolve(home, enteredPath.slice(2))
            : resolve(projectRoot, enteredPath));
        if ([systemRoot, projectRoot, home].includes(path)) {
          locationError.setText(theme.fg('error', '  Built-in project and home folder access cannot be changed.'));
          tui.requestRender();
          return;
        }

        pendingLocation = path;
        locationError.setText('');
        locationMode = 'access';
        tui.requestRender();
      };

      const locationAccessChoices: Array<{value: FilesystemAccess; label: string; description: string}> = [
        {value: 'readOnly', label: 'Read only', description: 'Pi can view files but cannot change them.'},
        {value: 'readWrite', label: 'Read/Write', description: 'Pi can view, create, edit, and delete files.'},
      ];
      const locationAccessList = new SelectList(locationAccessChoices, locationAccessChoices.length, getSelectListTheme());
      locationAccessList.onSelect = choice => {
        const access: FilesystemAccess = choice.value === 'readWrite' ? 'readWrite' : 'readOnly';
        done({action: 'set', path: pendingLocation, access});
      };

      locationAccessList.onCancel = () => {
        locationMode = 'path';
        locationInput.focused = isFocused;
        tui.requestRender();
      };

      const locationAccessTitle = new Text(theme.fg('dim', '  Access for this location:'), 0, 0);
      const inlineLocationInput = {
        render(width: number) {
          if (locationMode === 'closed') {
            return [];
          }

          const lines = locationInputContainer.render(width);
          return locationMode === 'access'
            ? [...lines, '', ...locationAccessTitle.render(width), ...locationAccessList.render(width)]
            : lines;
        },
        handleInput(data: string) {
          if (locationMode === 'access') {
            locationAccessList.handleInput(data);
          } else if (keybindings.matches(data, 'tui.select.cancel')) {
            locationMode = 'closed';
            locationInput.setText('');
            locationError.setText('');
          } else {
            locationInput.handleInput(data);
          }
        },
        invalidate() {
          locationInputContainer.invalidate();
          locationAccessList.invalidate();
        },
      };

      const container = new Container();
      const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
      const title = theme.fg('accent', theme.bold(`Files and folders — ${scopeLabel}`));
      const description = theme.fg('muted', 'Every effective location is shown. Dimmed rows cannot be changed in this scope.');
      const labelWidth = Math.min(36, Math.max(...items.map(item => visibleWidth(item.label))));
      const tableHeader = `  ${'Location'.padEnd(labelWidth)}  ${'Access'.padEnd(16)}Source`;
      container.addChild(new Text(title, 0, 0));
      container.addChild(new Text(description, 0, 1));
      container.addChild(new Text(theme.fg('dim', tableHeader), 0, 0));
      const settingsList = new SettingsList(
        items,
        15,
        getSettingsListTheme(),
        (id, newValue) => {
          if (id === 'add') {
            locationMode = 'path';
            pendingLocation = '';
            locationAccessList.setSelectedIndex(0);
            locationInput.focused = isFocused;
            locationError.setText('');
            tui.requestRender();
            return;
          }

          if (id !== 'built-in') {
            return;
          }

          if (newValue === builtInsShown) {
            items.splice(1, 0, ...builtInItems);
            return;
          }

          items.splice(1, builtInItems.length);
        },
        () => {
          done(undefined);
        },
      );
      container.addChild(settingsList);
      container.addChild(inlineLocationInput);

      return {
        get focused() {
          return isFocused;
        },
        set focused(value: boolean) {
          isFocused = value;
          locationInput.focused = value && locationMode === 'path';
        },
        render(width: number) {
          return container.render(width);
        },
        handleInput(data: string) {
          if (locationMode === 'closed') {
            settingsList.handleInput(data);
          } else {
            inlineLocationInput.handleInput(data);
          }

          tui.requestRender();
        },
        handleMouse(event) {
          if (locationMode === 'path') {
            return locationInput.handleMouse(event);
          }

          return locationMode === 'access'
            ? locationAccessList.handleMouse(event)
            : settingsList.handleMouse(event);
        },
        invalidate() {
          container.invalidate();
        },
      };
    });
    if (result === undefined) {
      return;
    }

    const permissions: FilesystemPermission[] = ['allowRead', 'allowWrite', 'denyRead', 'denyWrite'];
    await this.config.updateFilesystem(scope, permissions, 'remove', result.path);
    if (result.action === 'remove') {
      await this.restartSessionAndNotify(ctx, `Removed ${result.path} from ${scope === 'global' ? 'global' : 'project'} filesystem rules.`);
    } else {
      const access = {
        readWrite: {permissions: ['allowRead', 'allowWrite'], label: 'readable and writable'},
        readOnly: {permissions: ['allowRead', 'denyWrite'], label: 'read-only'},
        none: {permissions: ['denyRead', 'denyWrite'], label: 'blocked'},
      } as const;
      const setting = access[result.access];
      await this.config.updateFilesystem(scope, setting.permissions, 'add', result.path);
      await this.restartSessionAndNotify(ctx, `${result.path} is now ${setting.label}.`);
    }

    return this.manageFilesystem(ctx, scope);
  }

  /** Adds or removes network access without exposing SRT field names. */
  async manageNetwork(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
    const action = await ctx.ui.select(`Websites and services — ${scopeLabel}`, ['Add destination', 'Remove destination']);
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

    const normalizedDomain = domain?.trim();
    if (normalizedDomain === undefined || normalizedDomain.length === 0) {
      return;
    }

    const normalizedReason = reason?.trim();
    const listAction = action === 'Add destination' ? 'add' : 'remove';
    await this.config.updateDomain(
      scope,
      permission,
      listAction,
      normalizedDomain,
      normalizedReason === undefined || normalizedReason.length === 0 ? undefined : normalizedReason,
    );
    await this.restartSessionAndNotify(ctx, `${listAction === 'add' ? 'Added' : 'Removed'} ${normalizedDomain} in ${scope} network rules.`);
  }

  /** Keeps the settings browser open until Escape is pressed at its top level. */
  async manage(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const keybindings = getKeybindings();
    keybindings.setUserBindings({
      ...keybindings.getUserBindings(),
      'tui.select.up': [...new Set([...keybindings.getKeys('tui.select.up'), 'k' as const])],
      'tui.select.down': [...new Set([...keybindings.getKeys('tui.select.down'), 'j' as const])],
    });
    let activeScope = scope;
    /* eslint-disable no-await-in-loop, unicorn/no-break-in-nested-loop -- Each menu must finish before the next reflects its changes. */
    while (true) {
      await this.config.reload();
      const scopeName = activeScope === 'project' ? 'This project' : 'Global defaults';
      const scopeLabel = activeScope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
      const scopedConfig = this.config.getScopedConfig(activeScope);
      const scopedPrompting = scopedConfig.sandbox?.promptOnNetworkDeny;
      const promptingValue = activeScope === 'project' && scopedPrompting === undefined
        ? `Use global setting (${this.config.shouldPrompt() ? 'On' : 'Off'})`
        : ((scopedPrompting ?? true) ? 'On' : 'Off');
      const scopedResearch = this.config.getResearchAgentsSetting(activeScope);
      const researchValue = activeScope === 'project' && scopedResearch === undefined
        ? `Use global setting (${this.config.areResearchAgentsEnabled() ? 'On' : 'Off'})`
        : ((scopedResearch ?? false) ? 'On' : 'Off');
      const toggleAction = this.sandbox.isEnabled ? 'Turn off session protection' : 'Turn on session protection';
      const promptingAction = `Ask when a website is blocked — ${promptingValue}`;
      const researchAction = `Research agents — ${researchValue}`;
      const statusIcon = this.sandbox.isEnabled ? '󰕥' : '󰒲';
      const statusLabel = this.sandbox.isEnabled ? 'On' : 'Off';
      const title = `${statusIcon} Sandbox: ${statusLabel} — ${scopeLabel}`;
      const action = await ctx.ui.select(title, [
        'Files and folders',
        'Websites and services',
        promptingAction,
        researchAction,
        toggleAction,
        '',
        activeScope === 'project' ? '← Manage global settings' : '← Manage local settings',
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

        case 'Files and folders': {
          await this.manageFilesystem(ctx, activeScope);
          break;
        }

        case 'Websites and services': {
          await this.manageNetwork(ctx, activeScope);
          break;
        }

        case promptingAction: {
          const prompting = await ctx.ui.select(`Ask when a website is blocked? — ${scopeLabel}`, ['On', 'Off']);
          if (prompting !== undefined) {
            await this.config.setPrompting(activeScope, prompting === 'On');
            await this.restartSessionAndNotify(ctx, `Blocked-website prompts are ${prompting.toLowerCase()} for ${scopeName.toLowerCase()}.`);
          }

          break;
        }

        case researchAction: {
          await this.manageResearchAgents(pi, ctx, activeScope);
          break;
        }

        case '← Manage global settings': {
          activeScope = 'global';
          break;
        }

        case '← Manage local settings': {
          activeScope = 'project';
          break;
        }

        default: {
          break;
        }
      }
    }
    /* eslint-enable no-await-in-loop, unicorn/no-break-in-nested-loop */
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
