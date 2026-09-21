import process from 'node:process';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type {
  ConfigScope,
  ConfigStore,
  NetworkPermission,
  RequestAllowRule,
  RequestPolicy,
} from '../config.ts';
import type {SandboxSessionManager} from '../session-manager.ts';

type NetworkDraft = {
  access: NetworkPermission;
  destination: string;
  policy?: RequestPolicy;
  previousDestination?: string;
};

type NetworkAction =
  | {action: 'add'}
  | {action: 'edit'; draft: NetworkDraft}
  | {action: 'save'; draft: NetworkDraft}
  | {action: 'remove'; destination: string}
  | {action: 'set-local-binding'; enabled: boolean};

export class SandboxNetworkCommand {
  config: ConfigStore;
  sandbox: SandboxSessionManager;

  /**
   Keeps scoped network and request-policy workflows together.
   */
  constructor(config: ConfigStore, sandbox: SandboxSessionManager) {
    this.config = config;
    this.sandbox = sandbox;
  }

  /**
   Shows every effective destination and edits its access and request filters together.
   */
  async manage(ctx: ExtensionCommandContext, scope: ConfigScope, draft?: NetworkDraft): Promise<void> {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Network Access requires interactive TUI mode.', 'error');
      return;
    }

    await this.config.reload();
    const globalConfig = this.config.getScopedSrtConfig('global');
    const projectConfig = this.config.getScopedSrtConfig('project');
    const effectiveConfig = this.config.getEffectiveConfig();
    const runtimeConfig = SandboxManager.getConfig();
    const globalPolicies = this.config.getScopedRequestPolicies('global');
    const projectPolicies = this.config.getScopedRequestPolicies('project');
    const result = await ctx.ui.custom<NetworkAction | undefined>((tui, theme, keybindings, done) => {
      let isFocused = false;
      let isFormOpen = draft !== undefined;
      let activeField = 0;
      let formAccess: NetworkPermission = draft?.access ?? 'allow';
      const initialRule = draft?.policy?.allow[0];
      const fields = [
        {
          label: 'Destination',
          hint: 'domain pattern; HTTPS port 443 is assumed',
          value: draft?.destination?.endsWith(':443') === true ? draft.destination.slice(0, -4) : (draft?.destination ?? ''),
        },
        {label: 'Methods', hint: 'optional: GET, POST', value: initialRule?.methods?.join(', ') ?? ''},
        {label: 'Exact paths', hint: 'optional: /health, /v1/jobs', value: initialRule?.paths?.join(', ') ?? ''},
        {label: 'Path prefixes', hint: 'optional: /v1/jobs', value: initialRule?.pathPrefixes?.join(', ') ?? ''},
        {
          label: 'Required headers',
          hint: 'optional: Name=value1|value2; Other=value',
          value: Object.entries(initialRule?.headers ?? {})
            .map(([name, entries]) => `${name}=${entries.join('|')}`).join('; '),
        },
      ];
      const inputs = fields.map(field => {
        const input = new Input({
          prompt: `${field.label}: `,
          placeholder: field.hint,
          placeholderStyle: text => theme.fg('dim', text),
        });
        input.setValue(field.value);
        return input;
      });
      const formError = new Text('', 0, 0);
      const save = () => {
        const enteredDestination = inputs[0]?.getValue().trim() ?? '';
        const destination = enteredDestination.endsWith(']') || !enteredDestination.includes(':')
          ? `${enteredDestination}:443`
          : enteredDestination;
        let policy: RequestPolicy | undefined;
        if (formAccess === 'allow') {
          const methods = inputs[1]?.getValue().split(',').map(entry => entry.trim()).filter(Boolean) ?? [];
          const paths = inputs[2]?.getValue().split(',').map(entry => entry.trim()).filter(Boolean) ?? [];
          const pathPrefixes = inputs[3]?.getValue().split(',').map(entry => entry.trim()).filter(Boolean) ?? [];
          const rule: RequestAllowRule = {};
          if (methods.length > 0) {
            rule.methods = methods;
          }

          if (paths.length > 0) {
            rule.paths = paths;
          }

          if (pathPrefixes.length > 0) {
            rule.pathPrefixes = pathPrefixes;
          }

          const headers: Record<string, string[]> = {};
          const headerEntries = inputs[4]?.getValue().split(';').map(entry => entry.trim()).filter(Boolean) ?? [];
          for (const header of headerEntries) {
            const separator = header.indexOf('=');
            const name = header.slice(0, separator).trim();
            const acceptedValues = header.slice(separator + 1).split('|').map(entry => entry.trim()).filter(Boolean);
            if (separator <= 0 || name.length === 0 || acceptedValues.length === 0) {
              formError.setText(theme.fg('error', `Invalid header ${JSON.stringify(header)}. Use Name=value1|value2.`));
              tui.requestRender();
              return;
            }

            headers[name] = [...new Set([...(headers[name] ?? []), ...acceptedValues])];
          }

          if (Object.keys(headers).length > 0) {
            rule.headers = headers;
          }

          if (Object.keys(rule).length > 0) {
            try {
              policy = this.config.validateRequestPolicy({destination, allow: [rule]});
            } catch (caughtError) {
              formError.setText(theme.fg('error', caughtError instanceof Error ? caughtError.message : String(caughtError)));
              tui.requestRender();
              return;
            }
          }
        }

        const savedDraft: NetworkDraft = {access: formAccess, destination};
        if (policy !== undefined) {
          savedDraft.policy = policy;
        }

        if (draft?.previousDestination !== undefined) {
          savedDraft.previousDestination = draft.previousDestination;
        }

        try {
          this.config.validateNetworkDestination({
            destination: savedDraft.destination,
            permission: savedDraft.access,
            ...(savedDraft.policy !== undefined && {policy: savedDraft.policy}),
            ...(savedDraft.previousDestination !== undefined && {previousDestination: savedDraft.previousDestination}),
          });
        } catch (caughtError) {
          formError.setText(theme.fg('error', caughtError instanceof Error ? caughtError.message : String(caughtError)));
          tui.requestRender();
          return;
        }

        done({action: 'save', draft: savedDraft});
      };

      for (const input of inputs) {
        input.onSubmit = save;
      }

      const inlineForm = {
        render(width: number) {
          if (!isFormOpen) {
            return [];
          }

          const heading = draft?.previousDestination === undefined ? 'Add network destination' : 'Edit network destination';
          const instructions = 'Tab/Shift+Tab moves · Type in the › row · Space toggles access · Enter saves · Esc cancels';
          const inputWidth = Math.max(1, width - 2);
          const destinationValue = inputs[0]!.getValue();
          const destinationLine = activeField === 0
            ? (inputs[0]!.render(inputWidth)[0] ?? '')
            : truncateToWidth(`Destination: ${destinationValue === '' ? theme.fg('dim', fields[0]!.hint) : destinationValue}`, inputWidth, '');
          const accessLine = `Access: ${formAccess === 'allow' ? 'Allowed' : 'Blocked'} (Space to toggle)`;
          const selectedAccessLine = activeField === 1
            ? theme.bg('selectedBg', theme.fg('accent', theme.bold(`› ${accessLine}`)))
            : `  ${accessLine}`;
          const lines = [
            '',
            truncateToWidth(theme.fg('accent', theme.bold(heading)), width),
            ...wrapTextWithAnsi(theme.fg('muted', instructions), width),
            `${activeField === 0 ? theme.fg('accent', '› ') : '  '}${destinationLine}`,
            truncateToWidth(selectedAccessLine, width),
          ];
          if (formAccess === 'allow') {
            for (const [index, input] of inputs.slice(1).entries()) {
              const fieldIndex = index + 2;
              const field = fields[index + 1]!;
              const value = input.getValue();
              const inputLine = activeField === fieldIndex
                ? (input.render(inputWidth)[0] ?? '')
                : truncateToWidth(`${field.label}: ${value === '' ? theme.fg('dim', field.hint) : value}`, inputWidth, '');
              lines.push(`${activeField === fieldIndex ? theme.fg('accent', '› ') : '  '}${inputLine}`);
            }
          } else {
            lines.push(...wrapTextWithAnsi(
              theme.fg('dim', '  Request filters are unavailable while this destination is blocked.'),
              width,
            ));
          }

          lines.push(...formError.render(width));
          return lines;
        },
        invalidate() {
          for (const input of inputs) {
            input.invalidate();
          }

          formError.invalidate();
        },
      };
      const globalAllowed = new Set(globalConfig.network?.allowedDomains);
      const globalDenied = new Set(globalConfig.network?.deniedDomains);
      const projectAllowed = new Set(projectConfig.network?.allowedDomains);
      const projectDenied = new Set(projectConfig.network?.deniedDomains);
      const effectiveAllowed = new Set([
        ...(effectiveConfig.network?.allowedDomains ?? []),
        ...(runtimeConfig?.network?.allowedDomains ?? []),
      ]);
      const effectiveDenied = new Set([
        ...(effectiveConfig.network?.deniedDomains ?? []),
        ...(runtimeConfig?.network?.deniedDomains ?? []),
      ]);
      const destinations = new Set([
        ...effectiveAllowed,
        ...effectiveDenied,
        ...globalPolicies.map(policy => policy.destination),
        ...projectPolicies.map(policy => policy.destination),
      ]);
      const globalDestinations = new Set([
        ...globalAllowed,
        ...globalDenied,
        ...globalPolicies.map(policy => policy.destination),
      ]);
      const sortedDestinations = [...destinations].toSorted((a, b) => {
        const sourceOrder = Number(globalDestinations.has(b)) - Number(globalDestinations.has(a));
        return sourceOrder === 0 ? a.localeCompare(b) : sourceOrder;
      });
      const items: SettingItem[] = [];
      for (const destination of sortedDestinations) {
        const destinationGlobalPolicies = globalPolicies.filter(policy => policy.destination === destination);
        const destinationProjectPolicies = projectPolicies.filter(policy => policy.destination === destination);
        const policies = [...destinationGlobalPolicies, ...destinationProjectPolicies];
        const isBlocked = effectiveDenied.has(destination);
        const isAllowed = effectiveAllowed.has(destination) || policies.length > 0;
        let access = 'Unavailable';
        if (isBlocked) {
          access = 'Blocked';
        } else if (policies.length > 0) {
          access = 'Filtered';
        } else if (isAllowed) {
          access = 'Allowed';
        }

        let requestLabel = 'All';
        if (isBlocked) {
          requestLabel = '—';
        } else if (policies.length > 0) {
          requestLabel = `${policies.length} ${policies.length === 1 ? 'filter' : 'filters'}`;
        }

        const isGlobalOwner = globalAllowed.has(destination) || globalDenied.has(destination) || destinationGlobalPolicies.length > 0;
        const isProjectOwner = projectAllowed.has(destination) || projectDenied.has(destination) || destinationProjectPolicies.length > 0;
        const isEditable = scope === 'global' ? isGlobalOwner : isProjectOwner;
        const sources = [
          isGlobalOwner ? 'Global' : '',
          isProjectOwner ? 'Local' : '',
          !isGlobalOwner && !isProjectOwner ? 'Built in' : '',
        ].filter(Boolean);
        const currentValue = `${access.padEnd(12)}${requestLabel.padEnd(12)}${sources.join(' + ')}`;
        const summaries = policies.flatMap(policy => policy.allow.map(rule => [
          rule.methods?.join('/'),
          ...(rule.paths ?? []).map(path => `=${path}`),
          ...(rule.pathPrefixes ?? []).map(path => `${path}/**`),
          ...Object.entries(rule.headers ?? {}).map(([name, values]) => `${name} (${values.length})`),
        ].filter(Boolean).join(' · ')));
        const item: SettingItem = {
          id: destination,
          label: isEditable
            ? truncateToWidth(destination.endsWith(':443') ? destination.slice(0, -4) : destination, 36, '…')
            : theme.fg('dim', truncateToWidth(destination.endsWith(':443') ? destination.slice(0, -4) : destination, 36, '…')),
          currentValue: isEditable ? currentValue : theme.fg('dim', currentValue),
          description: isBlocked
            ? 'Connections are blocked. Request filters cannot be configured until access is allowed.'
            : (summaries.length === 0 ? 'All requests to this allowed destination may connect.' : `Allowed when any filter matches: ${summaries.join(' OR ')}.`),
        };
        if (isEditable) {
          const scopedPolicies = scope === 'global' ? destinationGlobalPolicies : destinationProjectPolicies;
          item.submenu = () => {
            const canEdit = scopedPolicies.length <= 1 && (scopedPolicies[0]?.allow.length ?? 1) === 1;
            const choices = [
              ...(canEdit ? [{value: 'edit', label: 'Edit destination', description: 'Change access and request filters together.'}] : []),
              {value: 'remove', label: 'Remove destination', description: `Remove its access and request filters from ${scope} settings.`},
            ];
            const list = new SelectList(choices, choices.length, getSelectListTheme());
            list.onSelect = choice => {
              if (choice.value === 'remove') {
                done({action: 'remove', destination});
                return;
              }

              const editDraft: NetworkDraft = {
                access: isBlocked ? 'deny' : 'allow',
                destination,
                previousDestination: destination,
              };
              if (scopedPolicies[0] !== undefined) {
                editDraft.policy = scopedPolicies[0];
              }

              done({action: 'edit', draft: editDraft});
            };

            list.onCancel = () => {
              done(undefined);
            };

            return list;
          };
        }

        items.push(item);
      }

      const source = scope === 'global' ? 'Global' : 'Local';
      items.push({
        id: 'add',
        label: 'Add a network destination…',
        currentValue: `${''.padEnd(24)}${source}`,
        values: [`${''.padEnd(24)}${source}`],
        description: 'Configure connection access and optional request filters in one form.',
      });
      if (process.platform === 'darwin') {
        const scopedLocalBinding = (scope === 'global' ? globalConfig : projectConfig).network?.allowLocalBinding;
        const isLocalBindingEnabled = effectiveConfig.network?.allowLocalBinding ?? false;
        const localBindingSource = scopedLocalBinding === undefined
          ? (globalConfig.network?.allowLocalBinding === undefined ? 'Built in' : 'Global')
          : source;
        const localBindingOff = `${'Off'.padEnd(12)}${'—'.padEnd(12)}${localBindingSource}`;
        const localBindingOn = `${'On'.padEnd(12)}${'—'.padEnd(12)}${localBindingSource}`;
        items.push({
          id: 'allow-local-connections',
          label: 'Allow local connections',
          currentValue: isLocalBindingEnabled ? localBindingOn : localBindingOff,
          values: [localBindingOff, localBindingOn],
          description: 'Allows sandboxed commands to access every localhost service and open listening ports on this Mac.',
        });
      }

      const container = new Container();
      const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
      const heading = theme.bold(`Network Access — ${scopeLabel}`);
      container.addChild(new Text(theme.fg('accent', heading), 0, 0));
      container.addChild(new Text(theme.fg('muted', 'Every configured destination is shown. Blocked destinations cannot have request filters.'), 0, 1));
      const labelWidth = Math.min(36, Math.max(...items.map(item => visibleWidth(item.label))));
      const tableHeader = `  ${'Destination / setting'.padEnd(labelWidth)}  ${'Access'.padEnd(12)}${'Requests'.padEnd(12)}Source`;
      container.addChild(new Text(theme.fg('dim', tableHeader), 0, 0));
      const settings = new SettingsList(
        items,
        isFormOpen ? 7 : 15,
        getSettingsListTheme(),
        (id, newValue) => {
          if (id === 'add') {
            done({action: 'add'});
          } else if (id === 'allow-local-connections') {
            done({action: 'set-local-binding', enabled: newValue.startsWith('On')});
          }
        },
        () => {
          done(undefined);
        },
      );
      container.addChild(settings);
      container.addChild(inlineForm);
      return {
        get focused() {
          return isFocused;
        },
        set focused(value: boolean) {
          isFocused = value;
          for (const [index, input] of inputs.entries()) {
            const fieldIndex = index === 0 ? 0 : index + 1;
            input.focused = value && isFormOpen && fieldIndex === activeField;
          }
        },
        render(width: number) {
          return container.render(width);
        },
        handleInput(data: string) {
          if (!isFormOpen) {
            settings.handleInput(data);
            tui.requestRender();
            return;
          }

          if (keybindings.matches(data, 'tui.select.cancel')) {
            isFormOpen = false;
            formError.setText('');
            for (const input of inputs) {
              input.focused = false;
            }

            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
            formError.setText('');
            const direction = matchesKey(data, Key.shift('tab')) ? -1 : 1;
            const fieldCount = formAccess === 'allow' ? 6 : 2;
            for (const input of inputs) {
              input.focused = false;
            }

            activeField = (activeField + direction + fieldCount) % fieldCount;
            const inputIndex = activeField === 0 ? 0 : activeField - 1;
            if (activeField !== 1) {
              inputs[inputIndex]!.focused = isFocused;
            }

            tui.requestRender();
            return;
          }

          if (activeField === 1) {
            if (matchesKey(data, Key.space) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
              formAccess = formAccess === 'allow' ? 'deny' : 'allow';
              formError.setText('');
              tui.requestRender();
            } else if (keybindings.matches(data, 'tui.select.confirm')) {
              save();
            }

            return;
          }

          const inputIndex = activeField === 0 ? 0 : activeField - 1;
          formError.setText('');
          inputs[inputIndex]?.handleInput(data);
          tui.requestRender();
        },
        handleMouse(event) {
          if (!isFormOpen || activeField === 1) {
            return isFormOpen ? {handled: false} : settings.handleMouse(event);
          }

          const inputIndex = activeField === 0 ? 0 : activeField - 1;
          return inputs[inputIndex]?.handleMouse(event);
        },
        invalidate() {
          container.invalidate();
        },
      };
    });
    if (result === undefined) {
      return;
    }

    switch (result.action) {
      case 'add': {
        return this.manage(ctx, scope, {access: 'allow', destination: ''});
      }

      case 'edit': {
        return this.manage(ctx, scope, result.draft);
      }

      case 'remove': {
        await this.config.removeNetworkDestination(scope, result.destination);
        break;
      }

      case 'save': {
        const setting = {
          destination: result.draft.destination,
          permission: result.draft.access,
          ...(result.draft.policy !== undefined && {policy: result.draft.policy}),
          ...(result.draft.previousDestination !== undefined && {previousDestination: result.draft.previousDestination}),
        };
        await this.config.setNetworkDestination(scope, setting);
        break;
      }

      case 'set-local-binding': {
        if (result.enabled && !await ctx.ui.confirm(
          'Allow local connections?',
          'Sandboxed commands will be able to access every localhost service and open listening ports on this Mac.',
        )) {
          return this.manage(ctx, scope);
        }

        await this.config.setAllowLocalBinding(scope, result.enabled);
        break;
      }
    }

    await this.sandbox.restartSession();
    ctx.ui.notify('Network settings updated.', 'info');
    return this.manage(ctx, scope);
  }
}
