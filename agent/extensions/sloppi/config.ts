import {realpathSync, statSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {
  FilesystemConfigSchema,
  NetworkConfigSchema,
  type FilesystemConfig,
  type NetworkConfig,
} from '@anthropic-ai/sandbox-runtime';
import {merge} from 'object-deep-merge';

export type Config = {
  filesystem?: Partial<FilesystemConfig> | undefined;
  network?: Partial<NetworkConfig> | undefined;
  projects?: Record<string, Config> | undefined;
  slopbox?: {promptOnNetworkDeny?: boolean | undefined} | undefined;
  [key: string]: unknown;
};
export type ConfigScope = 'global' | 'project';

export class ConfigStore {
  config: Config = {};
  hasLoaded = false;
  cwd: string;
  path: string;

  /** Creates a store for the current project's Slopbox configuration. */
  constructor(cwd: string, path?: string) {
    this.cwd = cwd;
    this.path = path ?? resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), '..', 'slopbox.json');
  }

  /** Reloads the configuration file, treating a missing file as an empty configuration. */
  async reload(): Promise<Config> {
    try {
      const parsedConfig = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (typeof parsedConfig !== 'object' || parsedConfig === null || Array.isArray(parsedConfig)) {
        throw new Error(`${this.path} must contain a JSON object.`);
      }

      this.config = {};
      for (const [key, value] of Object.entries(parsedConfig)) {
        this.config[key] = value;
      }
    } catch (error) {
      const errorCode = error instanceof Error && 'code' in error ? error.code : undefined;
      if (errorCode !== 'ENOENT') {
        throw error;
      }

      this.config = {};
    }

    this.hasLoaded = true;
    return this.config;
  }

  /** Returns the cached configuration, loading it on first use. */
  async load(): Promise<Config> {
    return this.hasLoaded ? this.config : this.reload();
  }

  /** Returns configuration for a scope, migrating legacy project directories. */
  getScopedConfig(scope: ConfigScope): Config {
    if (scope === 'global') {
      return this.config;
    }

    const projectConfigs = this.config.projects ?? {};
    this.config.projects = projectConfigs;

    const existingProjectConfig = projectConfigs[this.cwd];
    if (existingProjectConfig !== undefined) {
      return existingProjectConfig;
    }

    const legacyDirectories = this.config[this.cwd];
    const directories = Array.isArray(legacyDirectories)
      && legacyDirectories.every(entry => typeof entry === 'string')
      ? legacyDirectories
      : [];
    const projectConfig = directories.length > 0
      ? {filesystem: {allowRead: directories, allowWrite: directories}}
      : {};
    projectConfigs[this.cwd] = projectConfig;
    return projectConfig;
  }

  /** Merges global SRT settings with the current project's overrides. */
  getEffectiveConfig(): Config {
    const {projects: _projects, slopbox: _slopbox, ...globalConfig} = this.config;
    const {slopbox: _projectSlopbox, ...projectConfig} = this.getScopedConfig('project');
    return merge(globalConfig, projectConfig);
  }

  /** Adds a directory to the selected scope's read and write allowlists. */
  async addDirectory(scope: ConfigScope, directory: string): Promise<void> {
    await this.reload();
    const scopedConfig = this.getScopedConfig(scope);
    const filesystemValidation = FilesystemConfigSchema.safeParse({
      ...scopedConfig.filesystem,
      allowRead: scopedConfig.filesystem?.allowRead ?? [],
      allowWrite: scopedConfig.filesystem?.allowWrite ?? [],
      denyRead: scopedConfig.filesystem?.denyRead ?? [],
      denyWrite: scopedConfig.filesystem?.denyWrite ?? [],
    });
    if (!filesystemValidation.success) {
      throw new Error(`Invalid SRT filesystem configuration: ${filesystemValidation.error.message}`);
    }

    const filesystemConfig = filesystemValidation.data;
    const allowedReadDirectories = filesystemConfig.allowRead ?? [];
    const {allowWrite: allowedWriteDirectories} = filesystemConfig;
    filesystemConfig.allowRead = [...new Set([...allowedReadDirectories, directory])];
    filesystemConfig.allowWrite = [...new Set([...allowedWriteDirectories, directory])];
    scopedConfig.filesystem = filesystemConfig;
    const {[this.cwd]: _legacy, ...updatedConfig} = this.config;
    this.config = updatedConfig;
    await mkdir(dirname(this.path), {recursive: true});
    await writeFile(this.path, `${JSON.stringify(this.config, undefined, 2)}\n`);
  }

  /** Validates and persists a network domain allowlist entry for the selected scope. */
  async addDomain(scope: ConfigScope, domain: string): Promise<void> {
    const domainValidation = NetworkConfigSchema.safeParse({allowedDomains: [domain], deniedDomains: []});
    if (!domainValidation.success) {
      throw new Error(`Invalid SRT domain pattern: ${domain}`);
    }

    await this.reload();
    const scopedConfig = this.getScopedConfig(scope);
    const networkConfigValidation = NetworkConfigSchema.safeParse({
      ...scopedConfig.network,
      allowedDomains: scopedConfig.network?.allowedDomains ?? [],
      deniedDomains: scopedConfig.network?.deniedDomains ?? [],
    });
    if (!networkConfigValidation.success) {
      throw new Error(`Invalid SRT network configuration: ${networkConfigValidation.error.message}`);
    }

    const networkConfig = networkConfigValidation.data;
    const {allowedDomains} = networkConfig;
    networkConfig.allowedDomains = [...new Set([...allowedDomains, domain])];
    scopedConfig.network = networkConfig;
    const {[this.cwd]: _legacy, ...updatedConfig} = this.config;
    this.config = updatedConfig;
    await mkdir(dirname(this.path), {recursive: true});
    await writeFile(this.path, `${JSON.stringify(this.config, undefined, 2)}\n`);
  }

  /** Sets whether blocked network requests prompt for access in the selected scope. */
  async setPrompting(scope: ConfigScope, isEnabled: boolean): Promise<void> {
    await this.reload();
    const scopedConfig = this.getScopedConfig(scope);
    const slopboxConfig = scopedConfig.slopbox ?? {};
    slopboxConfig.promptOnNetworkDeny = isEnabled;
    scopedConfig.slopbox = slopboxConfig;
    const {[this.cwd]: _legacy, ...updatedConfig} = this.config;
    this.config = updatedConfig;
    await mkdir(dirname(this.path), {recursive: true});
    await writeFile(this.path, `${JSON.stringify(this.config, undefined, 2)}\n`);
  }

  /** Returns the current project's prompt setting, falling back to global and then true. */
  shouldPrompt(): boolean {
    const globalPromptSetting = this.config.slopbox?.promptOnNetworkDeny;
    const projectConfig = this.getScopedConfig('project');
    const projectPromptSetting = projectConfig.slopbox?.promptOnNetworkDeny;
    return typeof projectPromptSetting === 'boolean'
      ? projectPromptSetting
      : (typeof globalPromptSetting === 'boolean' ? globalPromptSetting : true);
  }

  /** Checks whether an SRT domain pattern allows a host and optional port. */
  isDomainAllowed(domain: string): boolean {
    const separator = domain.lastIndexOf(':');
    const host = separator === -1 ? domain : domain.slice(0, separator);
    const port = separator === -1 ? undefined : Number(domain.slice(separator + 1));
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
      return false;
    }

    const effectiveConfig = this.getEffectiveConfig();
    const networkConfigValidation = NetworkConfigSchema.safeParse({
      ...effectiveConfig.network,
      allowedDomains: effectiveConfig.network?.allowedDomains ?? [],
      deniedDomains: effectiveConfig.network?.deniedDomains ?? [],
    });
    if (!networkConfigValidation.success) {
      return false;
    }

    return networkConfigValidation.data.allowedDomains.some(pattern => {
      const patternSeparator = pattern.lastIndexOf(':');
      const patternHost = patternSeparator === -1 ? pattern : pattern.slice(0, patternSeparator);
      const patternPort = patternSeparator === -1 ? undefined : Number(pattern.slice(patternSeparator + 1));
      return (patternPort === undefined || patternPort === port)
        && (patternHost === host || (patternHost.startsWith('*.') && host.endsWith(`.${patternHost.slice(2)}`)));
    });
  }

  /** Resolves a project-relative directory and confirms it exists. */
  resolveAllowedDirectory(path: string): string {
    const directory = realpathSync(resolve(this.cwd, path));
    if (!statSync(directory).isDirectory()) {
      throw new Error(`Not a directory: ${path}`);
    }

    return directory;
  }
}
