import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';

export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type PermissionScope = 'global' | 'project';

type ScopedConfig = {
  commands?: Record<string, PermissionDecision> | undefined;
};

type Config = ScopedConfig & {
  projects?: Record<string, ScopedConfig> | undefined;
};

/** Validates one command-decision map at the configuration boundary. */
function parseCommands(value: unknown): Record<string, PermissionDecision> {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Permission policy must be a JSON object.');
  }

  const commands: Record<string, PermissionDecision> = {};
  const entries: Array<[string, unknown]> = Object.entries(value);
  for (const [command, decision] of entries) {
    const isValidCommand = command.length > 0
      && [...command].every(character => /\w/v.test(character) || '.+-'.includes(character));
    if (!isValidCommand || (decision !== 'allow' && decision !== 'ask' && decision !== 'deny')) {
      throw new Error(`Invalid permission rule: ${command}`);
    }

    commands[command] = decision;
  }

  return commands;
}

const defaultCommands: Record<string, PermissionDecision> = {
  helm: 'ask',
  kubectl: 'ask',
  terraform: 'ask',
};

export class PermissionConfig {
  config: Config = {};
  cwd: string;
  path: string;

  /** Creates a central permission store that cannot be changed by project files. */
  constructor(cwd: string, path?: string) {
    this.cwd = cwd;
    this.path = path ?? resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), '..', 'permissions.json');
  }

  /** Reloads permission policy, treating a missing file as empty configuration. */
  async reload(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${this.path} must contain a JSON object.`);
      }

      const rootEntries: Array<[string, unknown]> = Object.entries(parsed);
      const root = new Map(rootEntries);
      const projectValue = root.get('projects');
      const projects: Record<string, ScopedConfig> = {};
      if (projectValue !== undefined) {
        if (typeof projectValue !== 'object' || projectValue === null || Array.isArray(projectValue)) {
          throw new Error('permissions.json projects must be a JSON object.');
        }

        const projectEntries: Array<[string, unknown]> = Object.entries(projectValue);
        for (const [path, value] of projectEntries) {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error(`Invalid project permission policy: ${path}`);
          }

          const scopedEntries: Array<[string, unknown]> = Object.entries(value);
          projects[path] = {commands: parseCommands(new Map(scopedEntries).get('commands'))};
        }
      }

      this.config = {
        commands: parseCommands(root.get('commands')),
        projects,
      };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }

      this.config = {};
    }
  }

  /** Returns commands explicitly configured in one scope. */
  getScopedCommands(scope: PermissionScope): Record<string, PermissionDecision> {
    return {...(scope === 'global' ? this.config.commands : this.config.projects?.[this.cwd]?.commands)};
  }

  /** Resolves defaults and scoped policy while keeping global denials final. */
  getEffectiveCommands(): Record<string, PermissionDecision> {
    const globalCommands = {...defaultCommands, ...this.config.commands};
    const projectCommands = this.config.projects?.[this.cwd]?.commands ?? {};

    for (const [command, decision] of Object.entries(projectCommands)) {
      if (globalCommands[command] !== 'deny') {
        globalCommands[command] = decision;
      }
    }

    return globalCommands;
  }

  /** Validates and replaces command policy for one scope. */
  async replaceCommands(scope: PermissionScope, commands: unknown): Promise<void> {
    const validated = parseCommands(commands);

    await this.reload();
    if (scope === 'global') {
      this.config.commands = validated;
    } else {
      this.config.projects ??= {};
      this.config.projects[this.cwd] = {commands: validated};
    }

    await mkdir(dirname(this.path), {recursive: true});
    await writeFile(this.path, `${JSON.stringify(this.config, undefined, 2)}\n`);
  }
}
