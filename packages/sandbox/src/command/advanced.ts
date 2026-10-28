import process from 'node:process';
import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  type SettingItem,
  SettingsList,
  SelectList,
  Text,
  visibleWidth,
} from '@earendil-works/pi-tui';
import type {ConfigScope, ConfigStore} from '../config.ts';

type EnvironmentAction =
  | {action: 'add'}
  | {action: 'remove'; name: string};

const builtInEnvironment = new Set([
  'CLAUDE_CODE_TMPDIR',
  'HOME',
  'LANG',
  'NODE_USE_ENV_PROXY',
  'PATH',
  'TMPDIR',
  'USER',
]);

export class SandboxAdvancedCommand {
  config: ConfigStore;

  /**
   Keeps lower-frequency sandbox settings behind one menu while sharing the
   same global and project scope selected on the main sandbox screen.
   */
  constructor(config: ConfigStore) {
    this.config = config;
  }

  /**
   Shows every fixed and explicitly exposed environment-variable name without
   revealing host values. Only entries owned by the selected scope can be removed.
   */
  async manageEnvironment(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Environment Variables requires interactive TUI mode.', 'error');
      return;
    }

    /* eslint-disable no-await-in-loop -- The list reloads after each persisted edit. */
    while (true) {
      await this.config.reload();
      const globalNames = new Set(this.config.getScopedExposedEnv('global').filter(name => name !== 'HOME'));
      const projectNames = new Set(this.config.getScopedExposedEnv('project').filter(name => name !== 'HOME'));
      const configuredNames = globalNames.union(projectNames);
      const names = [...builtInEnvironment.union(configuredNames)].toSorted((a, b) => a.localeCompare(b));
      const editableNames = scope === 'global' ? globalNames : projectNames;
      const result = await ctx.ui.custom<EnvironmentAction | undefined>((tui, theme, _keybindings, done) => {
        const items: SettingItem[] = names.map(name => {
          const sources = [
            builtInEnvironment.has(name) ? 'Built in' : '',
            globalNames.has(name) ? 'Global' : '',
            projectNames.has(name) ? 'Local' : '',
          ].filter(Boolean);
          const isEditable = editableNames.has(name);
          const isAvailable = builtInEnvironment.has(name) || process.env[name] !== undefined;
          const currentValue = `${(isAvailable ? 'Available' : 'Missing').padEnd(12)}${sources.join(' + ')}`;
          let description = isAvailable
            ? 'The host variable will be passed through when sandboxed commands run.'
            : 'The host variable is not currently set, so it will be ignored.';
          if (builtInEnvironment.has(name)) {
            description = name === 'HOME'
              ? 'The sandbox always provides HOME. Use “Share host home directory” on the Advanced screen to choose its value.'
              : 'Provided by the sandbox with a fixed safe value; configured exposure cannot override it.';
          }

          const item: SettingItem = {
            id: name,
            label: isEditable ? name : theme.fg('dim', name),
            currentValue: isEditable ? currentValue : theme.fg('dim', currentValue),
            description: `${description} Values are never displayed here.`,
          };
          if (!isEditable) {
            return item;
          }

          item.submenu = () => {
            const choices = [{
              value: 'remove',
              label: 'Stop exposing variable',
              description: `Remove ${name} from ${scope === 'global' ? 'global' : 'local'} environment settings.`,
            }];
            const list = new SelectList(choices, choices.length, getSelectListTheme());
            list.onSelect = () => {
              done({action: 'remove', name});
            };

            list.onCancel = () => {
              done(undefined);
            };

            return list;
          };

          return item;
        });
        const source = scope === 'global' ? 'Global' : 'Local';
        items.push({
          id: 'add',
          label: 'Expose an environment variable…',
          currentValue: `${''.padEnd(12)}${source}`,
          values: [`${''.padEnd(12)}${source}`],
          description: 'Pass a named host variable to sandboxed commands without storing its value.',
        });

        const container = new Container();
        const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
        const title = theme.bold(`Environment Variables — ${scopeLabel}`);
        const description = 'Names and sources are shown; secret values are never rendered. Dimmed rows belong to another scope.';
        container.addChild(new Text(theme.fg('accent', title), 0, 0));
        container.addChild(new Text(theme.fg('muted', description), 0, 1));
        const labelWidth = Math.min(38, Math.max(...items.map(item => visibleWidth(item.label))));
        const tableHeader = `  ${'Variable'.padEnd(labelWidth)}  ${'Status'.padEnd(12)}Source`;
        container.addChild(new Text(theme.fg('dim', tableHeader), 0, 0));
        const settings = new SettingsList(
          items,
          15,
          getSettingsListTheme(),
          id => {
            if (id === 'add') {
              done({action: 'add'});
            }
          },
          () => {
            done(undefined);
          },
        );
        container.addChild(settings);
        return {
          render(width: number) {
            return container.render(width);
          },
          handleInput(data: string) {
            settings.handleInput(data);
            tui.requestRender();
          },
          handleMouse(event) {
            return settings.handleMouse(event);
          },
          invalidate() {
            container.invalidate();
          },
        };
      });
      if (result === undefined) {
        return;
      }

      if (result.action === 'remove') {
        await this.config.updateExposedEnv(scope, 'remove', result.name);
        ctx.ui.notify(`${result.name} is no longer exposed by ${scope === 'global' ? 'global' : 'local'} settings.`, 'info');
        continue;
      }

      const enteredName = await ctx.ui.input('Environment variable name');
      if (enteredName === undefined || enteredName.trim().length === 0) {
        continue;
      }

      const name = enteredName.trim();
      if (name === 'HOME') {
        ctx.ui.notify('Use “Share host home directory” on the Advanced screen to configure HOME.', 'info');
        continue;
      }

      await this.config.updateExposedEnv(scope, 'add', name);
      ctx.ui.notify(`${name} will be exposed by ${scope === 'global' ? 'global' : 'local'} settings.`, 'info');
    }
    /* eslint-enable no-await-in-loop */
  }

  /**
   Toggles the existing HOME exposure entry through a dedicated, plain-language
   control so the environment list can keep presenting HOME as a built-in variable.
   */
  async manageHostHome(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    await this.config.reload();
    const isSharedInScope = this.config.getScopedExposedEnv(scope).includes('HOME');
    const isSharedGlobally = this.config.getScopedExposedEnv('global').includes('HOME');
    if (scope === 'project' && isSharedGlobally && !isSharedInScope) {
      ctx.ui.notify('Host home directory sharing is enabled by global settings. Manage it under Global.', 'info');
      return;
    }

    const selection = await ctx.ui.select(
      `Share host home directory — ${scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects'}`,
      [isSharedInScope ? 'Off' : 'On'],
    );
    if (selection === undefined) {
      return;
    }

    await this.config.updateExposedEnv(scope, selection === 'On' ? 'add' : 'remove', 'HOME');
    const isEffective = this.config.getExposedEnv().includes('HOME');
    ctx.ui.notify(`Host home directory sharing is ${isEffective ? 'on' : 'off'} for this project.`, 'info');
  }

  /**
   Selects the scoped fallback model used only when a research profile does not
   declare its own model. Clearing a local value restores global inheritance.
   */
  async manageResearchScoutModel(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    await this.config.reload();
    const models = new Map(ctx.modelRegistry.getAvailable().map(model => [`${model.provider}/${model.id}`, model]));
    const choices = [
      ...models.keys(),
      scope === 'project' ? 'Use global model' : 'Clear model',
    ];
    const selection = await ctx.ui.select(
      `Research Scout model — ${scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects'}`,
      choices,
    );
    if (selection === undefined) {
      return;
    }

    if (selection === 'Use global model' || selection === 'Clear model') {
      await this.config.setResearchScoutModel(scope, undefined);
      ctx.ui.notify(scope === 'project' ? 'Research Scout now uses the global model.' : 'Global Research Scout model cleared.', 'info');
      return;
    }

    const model = models.get(selection);
    if (model === undefined) {
      throw new Error('Selected Research Scout model is unavailable.');
    }

    await this.config.setResearchScoutModel(scope, {provider: model.provider, id: model.id});
    ctx.ui.notify(`Research Scout will use ${model.provider}/${model.id} in ${scope === 'global' ? 'global' : 'local'} scope.`, 'info');
  }

  /**
   Applies a scoped research-agent choice and immediately synchronizes the
   active tool set with the effective setting for the current project.
   */
  async manageResearchAgents(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const choices = scope === 'global' ? ['On', 'Off'] : ['On', 'Off', 'Use global setting'];
    const selection = await ctx.ui.select(
      `Research agents — ${scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects'}`,
      choices,
    );
    if (selection === undefined) {
      return;
    }

    await this.config.setResearchAgentsEnabled(
      scope,
      selection === 'Use global setting' ? undefined : selection === 'On',
    );
    const isEnabled = this.config.areResearchAgentsEnabled();
    const activeTools = pi.getActiveTools().filter(name => name !== 'research_scout');
    pi.setActiveTools(isEnabled ? [...activeTools, 'research_scout'] : activeTools);
    ctx.ui.notify(`Research agents are ${isEnabled ? 'on' : 'off'} for this project.`, 'info');
  }

  /**
   Presents advanced settings for the selected scope and rebuilds the menu after
   each edit so inherited values and conditional model visibility stay accurate.
   */
  // One menu derives all conditional scoped labels and routes their child screens.
  async manage(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    /* eslint-disable no-await-in-loop, unicorn/no-break-in-nested-loop -- Each completed child screen may change the next menu. */
    while (true) {
      await this.config.reload();
      const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';

      const exposedCount = this.config.getExposedEnv().filter(name => name !== 'HOME').length;
      const environmentAction = `Environment Variables — ${exposedCount} exposed`;

      const globalEnvironment = this.config.getScopedExposedEnv('global');
      const localEnvironment = this.config.getScopedExposedEnv('project');
      const isHomeSharedGlobally = globalEnvironment.includes('HOME');
      const isHomeSharedLocally = localEnvironment.includes('HOME');
      const isHostHomeShared = scope === 'global'
        ? isHomeSharedGlobally
        : isHomeSharedGlobally || isHomeSharedLocally;
      const homeSource = scope === 'project' && isHomeSharedLocally ? 'Local' : 'Global';
      const hostHomeAction = `Share host home directory — ${isHostHomeShared ? 'On' : 'Off'} (${homeSource})`;

      const scopedResearch = this.config.getResearchAgentsSetting(scope);
      const isResearchEnabled = scope === 'global'
        ? (scopedResearch ?? false)
        : this.config.areResearchAgentsEnabled();
      const researchSource = scope === 'global' || scopedResearch === undefined ? 'Global' : 'Local';
      const researchAction = `Research agents — ${isResearchEnabled ? 'On' : 'Off'} (${researchSource})`;

      const scopedModel = this.config.getResearchScoutModelSetting(scope);
      const effectiveModel = scope === 'global' ? scopedModel : this.config.getResearchScoutModel();
      const modelSource = scope === 'global' || scopedModel === undefined ? 'Global' : 'Local';
      const modelAction = `Research Scout model — ${effectiveModel === undefined ? 'Not selected' : `${effectiveModel.provider}/${effectiveModel.id}`} (${modelSource})`;
      const action = await ctx.ui.select(`Advanced — ${scopeLabel}`, [
        environmentAction,
        hostHomeAction,
        researchAction,
        ...(isResearchEnabled ? [modelAction] : []),
      ]);
      if (action === undefined) {
        return;
      }

      switch (action) {
        case environmentAction: {
          await this.manageEnvironment(ctx, scope);
          break;
        }

        case hostHomeAction: {
          await this.manageHostHome(ctx, scope);
          break;
        }

        case researchAction: {
          await this.manageResearchAgents(pi, ctx, scope);
          break;
        }

        case modelAction: {
          await this.manageResearchScoutModel(ctx, scope);
          break;
        }

        default: {
          break;
        }
      }
    }
    /* eslint-enable no-await-in-loop, unicorn/no-break-in-nested-loop */
  }
}
