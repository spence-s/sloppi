import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';

export type PermissionAction = 'allow' | 'ask' | 'deny' | 'stage';
export type PermissionScope = 'global' | 'project';

export type PermissionRule = {
  action: PermissionAction;
  command: string;
  passthrough?: string[] | undefined;
};

type ScopedConfig = {
  commands?: PermissionRule[] | undefined;
};

type Config = ScopedConfig & {
  projects?: Record<string, ScopedConfig> | undefined;
};

let configWriteQueue = Promise.resolve();

/** Checks the deliberately small literal selector alphabet. */
function isSelectorWord(word: string, hasSlash: boolean): boolean {
  const punctuation = hasSlash ? '%+,-./:=@' : '%+,-.:=@';
  return word.length > 0 && [...word].every(character => /\w/v.test(character) || punctuation.includes(character));
}

/** Normalizes one whitespace-separated literal argv sequence. */
function parseSequence(value: unknown, description: string, hasExecutable: boolean): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${description} must be a string.`);
  }

  const sequence = value.trim().replaceAll(/ +/gv, ' ');
  const words = sequence.split(' ');
  const hasInvalidControl = [...value].some(character => (character.codePointAt(0) ?? 0) < 32 || character.codePointAt(0) === 127);
  const hasInvalidWord = words.some((word, index) => !isSelectorWord(word, !hasExecutable || index > 0));
  if (sequence.length === 0 || hasInvalidControl || hasInvalidWord) {
    throw new TypeError(`Invalid permission command: ${value.length === 0 ? '<empty>' : value}`);
  }

  return sequence;
}

/** Fully validates command rules before any policy becomes active. */
function parseRules(value: unknown): PermissionRule[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TypeError('Permission commands must be a JSON array.');
  }

  const candidates: unknown[] = value;
  const rules: PermissionRule[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new TypeError('Every permission command must be an object.');
    }

    const entries: Array<[string, unknown]> = Object.entries(candidate);
    const fields = new Map(entries);
    const unknown = fields.keys().find(key => !['action', 'command', 'passthrough'].includes(key));
    if (unknown !== undefined) {
      throw new TypeError(`Unknown permission command field: ${unknown}`);
    }

    const command = parseSequence(fields.get('command'), 'permission command', true);
    const action = fields.get('action');
    if (action !== 'allow' && action !== 'ask' && action !== 'deny' && action !== 'stage') {
      throw new TypeError(`Invalid permission action for ${command}`);
    }

    const passthroughValue = fields.get('passthrough');
    if (passthroughValue !== undefined && !Array.isArray(passthroughValue)) {
      throw new TypeError(`Passthrough rules for ${command} must be a JSON array.`);
    }

    const passthroughEntries: unknown[] = passthroughValue ?? [];
    const passthrough = [...new Set(passthroughEntries.map(entry => parseSequence(entry, `passthrough for ${command}`, false)))];
    if (rules.some(rule => rule.command === command)) {
      throw new TypeError(`Duplicate permission command: ${command}`);
    }

    rules.push({action, command, ...(passthrough.length > 0 && {passthrough})});
  }

  return rules;
}

/** Rejects unknown fields so malformed policy never becomes partially active. */
function assertKnownFields(value: Record<string, unknown>, allowed: string[], description: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new TypeError(`Unknown ${description} field: ${unknown}`);
  }
}

export class PermissionConfig {
  config: Config = {};
  cwd: string;
  path: string;

  /** Creates the central permission store alongside the user's Pi configuration. */
  constructor(cwd: string, path?: string) {
    this.cwd = cwd;
    this.path = path ?? resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), '..', 'permissions.json');
  }

  /** Reloads and fully validates policy, treating a missing file as empty. */
  async reload(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new TypeError(`${this.path} must contain a JSON object.`);
      }

      const rootEntries: Array<[string, unknown]> = Object.entries(parsed);
      const root = new Map(rootEntries);
      assertKnownFields(Object.fromEntries(root), ['commands', 'projects'], 'permission configuration');
      const projects: Record<string, ScopedConfig> = {};
      const projectValue = root.get('projects');
      if (projectValue !== undefined) {
        if (typeof projectValue !== 'object' || projectValue === null || Array.isArray(projectValue)) {
          throw new TypeError('Permission projects must be a JSON object.');
        }

        const projectEntries: Array<[string, unknown]> = Object.entries(projectValue);
        for (const [path, value] of projectEntries) {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new TypeError(`Invalid project permission policy: ${path}`);
          }

          const scopeEntries: Array<[string, unknown]> = Object.entries(value);
          const scope = new Map(scopeEntries);
          assertKnownFields(Object.fromEntries(scope), ['commands'], `project permission policy for ${path}`);
          projects[path] = {commands: parseRules(scope.get('commands'))};
        }
      }

      this.config = {commands: parseRules(root.get('commands')), projects};
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }

      this.config = {};
    }
  }

  /** Returns independent copies of rules configured in one scope. */
  getScopedRules(scope: PermissionScope): PermissionRule[] {
    const rules = scope === 'global' ? this.config.commands ?? [] : this.config.projects?.[this.cwd]?.commands ?? [];
    return rules.map(rule => ({...rule, ...(rule.passthrough !== undefined && {passthrough: [...rule.passthrough]})}));
  }

  /** Combines scopes, allowing project rules to replace equal non-denied global selectors. */
  getEffectiveRules(): PermissionRule[] {
    const rules = new Map((this.config.commands ?? []).map(rule => [rule.command, rule]));
    for (const rule of this.config.projects?.[this.cwd]?.commands ?? []) {
      if (rules.get(rule.command)?.action !== 'deny') {
        rules.set(rule.command, rule);
      }
    }

    return rules.values().map(rule => ({...rule, ...(rule.passthrough !== undefined && {passthrough: [...rule.passthrough]})})).toArray();
  }

  /** Atomically replaces one scope after reloading changes made by another editor. */
  async replaceRules(scope: PermissionScope, rules: unknown): Promise<void> {
    const validated = parseRules(rules);
    const write = configWriteQueue.then(async () => {
      await this.reload();
      if (scope === 'global') {
        this.config.commands = validated;
      } else {
        this.config.projects ??= {};
        this.config.projects[this.cwd] = {commands: validated};
      }

      await mkdir(dirname(this.path), {recursive: true});
      const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(this.config, undefined, 2)}\n`, {mode: 0o600});
        await rename(temporaryPath, this.path);
      } finally {
        await rm(temporaryPath, {force: true});
      }
    });

    configWriteQueue = write.catch(() => undefined);
    await write;
  }
}
