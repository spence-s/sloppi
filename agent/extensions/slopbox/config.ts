import {realpathSync, statSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {NetworkConfigSchema} from '@anthropic-ai/sandbox-runtime';

export type Config = Record<string, unknown>;
export type ConfigScope = 'global' | 'project';

export function isConfig(value: unknown): value is Config {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getStrings(value: unknown): string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : [];
}

export function mergeSandboxConfig(base: Config, override: Config): Config {
  const merged = {...base};
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      merged[key] = [...new Set([...(current as unknown[]), ...(value as unknown[])])];
    } else if (isConfig(current) && isConfig(value)) {
      merged[key] = mergeSandboxConfig(current, value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function getProjectConfig(config: Config, cwd: string): Config {
  if (isConfig(config.projects) && isConfig(config.projects[cwd])) {
    return config.projects[cwd];
  }

  // Read the former {"/project": ["/directory"]} format until it is next saved.
  const directories = getStrings(config[cwd]);
  return directories.length > 0
    ? {filesystem: {allowRead: directories, allowWrite: directories}}
    : {};
}

export function getEffectiveConfig(config: Config, cwd: string): Config {
  const {projects: _projects, slopbox: _slopbox, ...global} = config;
  const {slopbox: _projectSlopbox, ...project} = getProjectConfig(config, cwd);
  return mergeSandboxConfig(global, project);
}

export function getAllowedDirectories(config: unknown, cwd: string): string[] {
  if (!isConfig(config)) {
    return [];
  }

  const {filesystem} = getEffectiveConfig(config, cwd);
  return isConfig(filesystem)
    ? [...new Set([...getStrings(filesystem.allowRead), ...getStrings(filesystem.allowWrite)])]
    : [];
}

export function shouldPromptOnNetworkDeny(config: unknown, cwd: string): boolean {
  if (!isConfig(config)) {
    return true;
  }

  const global = isConfig(config.slopbox) ? config.slopbox.promptOnNetworkDeny : undefined;
  const projectConfig = getProjectConfig(config, cwd);
  const project = isConfig(projectConfig.slopbox) ? projectConfig.slopbox.promptOnNetworkDeny : undefined;
  if (typeof project === 'boolean') {
    return project;
  }

  return typeof global === 'boolean' ? global : true;
}

export function resolveAllowedDirectory(cwd: string, path: string): string {
  const directory = realpathSync(resolve(cwd, path));
  if (!statSync(directory).isDirectory()) {
    throw new Error(`Not a directory: ${path}`);
  }

  return directory;
}

export function createConfigStore(
  cwd: string,
  configPath = join(homedir(), '.pi', 'slopbox.json'),
) {
  let config: Config = {};
  let hasLoaded = false;

  const reload = async (): Promise<Config> => {
    try {
      const loaded = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
      if (!isConfig(loaded)) {
        throw new Error(`${configPath} must contain a JSON object.`);
      }

      config = loaded;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }

      config = {};
    }

    hasLoaded = true;
    return config;
  };

  const load = async (): Promise<Config> => hasLoaded ? config : reload();

  const getScope = (scope: ConfigScope): Config => {
    if (scope === 'global') {
      return config;
    }

    const {projects: savedProjects} = config;
    const projects: Config = isConfig(savedProjects) ? savedProjects : {};
    config.projects = projects;

    const existing = projects[cwd];
    if (isConfig(existing)) {
      return existing;
    }

    const project = getProjectConfig(config, cwd);
    projects[cwd] = project;
    return project;
  };

  const update = async (mutate: () => void): Promise<void> => {
    // Reload so a long-running Pi session does not overwrite changes made by another session.
    // ponytail: simultaneous writes can still race; add a file lock if config commands become concurrent.
    await reload();
    mutate();
    const {[cwd]: _legacy, ...currentConfig} = config;
    config = currentConfig;
    await mkdir(dirname(configPath), {recursive: true});
    await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`);
  };

  return {
    load,
    reload,
    async addDirectory(scope: ConfigScope, directory: string): Promise<void> {
      await update(() => {
        const scoped = getScope(scope);
        const filesystem = isConfig(scoped.filesystem) ? scoped.filesystem : {};
        filesystem.allowRead = [...new Set([...getStrings(filesystem.allowRead), directory])];
        filesystem.allowWrite = [...new Set([...getStrings(filesystem.allowWrite), directory])];
        scoped.filesystem = filesystem;
      });
    },
    async addDomain(scope: ConfigScope, domain: string): Promise<void> {
      const validation = NetworkConfigSchema.safeParse({allowedDomains: [domain], deniedDomains: []});
      if (!validation.success) {
        throw new Error(`Invalid SRT domain pattern: ${domain}`);
      }

      await update(() => {
        const scoped = getScope(scope);
        const network = isConfig(scoped.network) ? scoped.network : {};
        network.allowedDomains = [...new Set([...getStrings(network.allowedDomains), domain])];
        scoped.network = network;
      });
    },
    async setPrompting(scope: ConfigScope, isEnabled: boolean): Promise<void> {
      await update(() => {
        const scoped = getScope(scope);
        const slopbox = isConfig(scoped.slopbox) ? scoped.slopbox : {};
        slopbox.promptOnNetworkDeny = isEnabled;
        scoped.slopbox = slopbox;
      });
    },
    shouldPrompt(): boolean {
      return shouldPromptOnNetworkDeny(config, cwd);
    },
  };
}

export type ConfigStore = ReturnType<typeof createConfigStore>;
