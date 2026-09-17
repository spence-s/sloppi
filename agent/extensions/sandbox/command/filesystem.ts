import {homedir} from 'node:os';
import {
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  type SettingItem,
  SettingsList,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import type {ConfigScope, ConfigStore, FilesystemPermission} from '../config.ts';
import type {SandboxSessionManager} from '../session-manager.ts';

type FilesystemAccess = 'readWrite' | 'readOnly' | 'none';
type FilesystemAction =
  | {action: 'set'; access: FilesystemAccess; path: string}
  | {action: 'remove'; path: string};

/**
 Returns a relative path only when the target is below the parent directory.
 */
const relativeDescendantPath = (parent: string, target: string): string | undefined => {
  const relativePath = relative(parent, target);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
    ? relativePath
    : undefined;
};

export class SandboxFilesystemCommand {
  config: ConfigStore;
  sandbox: SandboxSessionManager;

  /**
   Keeps filesystem configuration and its custom TUI behind one command boundary.
   */
  constructor(config: ConfigStore, sandbox: SandboxSessionManager) {
    this.config = config;
    this.sandbox = sandbox;
  }

  /**
   Shows effective locations while allowing scoped rules to be added or removed directly.
   */
  async manage(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
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
        const projectRelativePath = relativeDescendantPath(projectRoot, path);
        const homeRelativePath = relativeDescendantPath(home, path);
        const displayPath = path === home
          ? '~'
          : (homeRelativePath === undefined ? path : `~/${homeRelativePath.split(sep).join('/')}`);
        let accessLabel = 'Read only';
        let description = sources.length === 0 ? 'Built into the sandbox.' : `Configured by ${sources.join(' and ')}.`;
        let label = scope === 'project'
          && projectPaths.has(path)
          && !globalPaths.has(path)
          && projectRelativePath !== undefined
          ? projectRelativePath
          : displayPath;
        switch (path) {
          case systemRoot: {
            label = `Filesystem root (${displayPath})`;
            description = `The filesystem is always available for reading. More specific locations below may be restricted.${fixedSourceNote}`;
            break;
          }

          case projectRoot: {
            accessLabel = 'Read/Write';
            label = `Project folder (${displayPath})`;
            description = `The project folder is always available for reading and changes.${fixedSourceNote}`;
            break;
          }

          case home: {
            accessLabel = 'No access';
            label = `Home folder (${displayPath})`;
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
          currentValue: `${''.padEnd(16)}${scope === 'global' ? 'Global' : 'Local'}`,
          values: [`${''.padEnd(16)}${scope === 'global' ? 'Global' : 'Local'}`],
          description: 'Enter an absolute path or a path relative to this project, then choose its access.',
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
        {value: 'readWrite', label: 'Read/Write', description: 'Pi can view, create, edit, and delete files.'},
        {value: 'none', label: 'No access', description: 'Pi cannot view or change files.'},
      ];
      const locationAccessList = new SelectList(locationAccessChoices, locationAccessChoices.length, getSelectListTheme());
      locationAccessList.onSelect = choice => {
        const access: FilesystemAccess = choice.value === 'none' ? 'none' : 'readWrite';
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
      await this.sandbox.restartSession();
      ctx.ui.notify(`Removed ${result.path} from ${scope === 'global' ? 'global' : 'project'} filesystem rules.`, 'info');
    } else {
      const access = {
        readWrite: {permissions: ['allowRead', 'allowWrite'], label: 'readable and writable'},
        readOnly: {permissions: ['allowRead', 'denyWrite'], label: 'read-only'},
        none: {permissions: ['denyRead', 'denyWrite'], label: 'blocked'},
      } as const;
      const setting = access[result.access];
      await this.config.updateFilesystem(scope, setting.permissions, 'add', result.path);
      await this.sandbox.restartSession();
      ctx.ui.notify(`${result.path} is now ${setting.label}.`, 'info');
    }

    return this.manage(ctx, scope);
  }
}
