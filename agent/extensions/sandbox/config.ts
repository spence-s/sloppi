import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {
  type SandboxRuntimeConfig,
  FilesystemConfigSchema,
  NetworkConfigSchema,
  SandboxRuntimeConfigSchema,
} from '@anthropic-ai/sandbox-runtime';
import {merge} from 'object-deep-merge';
import {z} from 'zod';

type PartialWithUndefined<T> = T extends ReadonlyArray<infer Item>
  ? Array<PartialWithUndefined<Item>>
  : T extends Record<string, unknown>
    ? {[Key in keyof T]?: PartialWithUndefined<T[Key]> | undefined}
    : T;

const nonEmptyStringSchema = z.string().min(1);
const researchScoutModelSchema = z.strictObject({
  provider: nonEmptyStringSchema,
  id: nonEmptyStringSchema,
});
const pathSchema = nonEmptyStringSchema.refine(path => path.startsWith('/'), 'paths must start with /');
const headerValuesSchema = z.array(z.string()).min(1);
const headersSchema = z.record(nonEmptyStringSchema, headerValuesSchema).transform(headers => {
  const normalized: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = values;
  }

  return normalized;
});
const requestAllowRuleSchema = z.strictObject({
  headers: headersSchema.optional(),
  methods: z.array(nonEmptyStringSchema).min(1).transform(methods => methods.map(method => method.toUpperCase())).optional(),
  pathPrefixes: z.array(pathSchema).min(1).optional(),
  paths: z.array(pathSchema).min(1).optional(),
}).refine(rule => Object.values(rule).some(value => value !== undefined), 'at least one predicate is required');
const requestDestinationSchema = z.string().transform((destination, context) => {
  let url: URL;
  try {
    url = new URL(`http://${destination}`);
  } catch {
    context.addIssue({code: 'custom', message: 'use an exact host:port'});
    return z.NEVER;
  }

  const portSeparator = destination.startsWith('[')
    ? destination.indexOf(']:') + 1
    : destination.lastIndexOf(':');
  const port = Number(destination.slice(portSeparator + 1));
  if (
    portSeparator <= 0
    || url.username.length > 0
    || url.password.length > 0
    || url.pathname !== '/'
    || url.search.length > 0
    || url.hash.length > 0
    || url.hostname.includes('*')
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
  ) {
    context.addIssue({code: 'custom', message: 'use an exact host:port'});
    return z.NEVER;
  }

  return `${url.hostname.toLowerCase().replace(/\.$/v, '')}:${port}`;
});
const requestPolicySchema = z.strictObject({
  allow: z.array(requestAllowRuleSchema).min(1),
  destination: requestDestinationSchema,
}).strict();
const requestPoliciesSchema = z.array(requestPolicySchema);

export type RequestAllowRule = z.infer<typeof requestAllowRuleSchema>;
export type RequestPolicy = z.infer<typeof requestPolicySchema>;

export type Config = PartialWithUndefined<SandboxRuntimeConfig> & {
  projects?: Record<string, Config> | undefined;
  sandbox?: {
    exposeEnv?: string[] | undefined;
    promptOnNetworkDeny?: boolean | undefined;
    requestPolicies?: RequestPolicy[] | undefined;
    researchAgentsEnabled?: boolean | undefined;
    researchScoutModel?: z.infer<typeof researchScoutModelSchema> | undefined;
  } | undefined;
  [key: string]: unknown;
};
export type ConfigScope = 'global' | 'project';
export type FilesystemPermission = 'allowRead' | 'allowWrite' | 'denyRead' | 'denyWrite';
export type ListAction = 'add' | 'remove';
export type NetworkPermission = 'allow' | 'deny';

export class ConfigStore {
  config: Config = {};
  hasLoaded = false;
  cwd: string;
  path: string;

  /** Creates a store for the current project's Sandbox configuration. */
  constructor(cwd: string, path?: string) {
    this.cwd = cwd;
    this.path = path ?? resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), '..', 'sandbox.json');
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
  getEffectiveConfig(): SandboxRuntimeConfig {
    const {projects: _projects, sandbox: _sandbox, ...globalConfig} = this.config;
    const {sandbox: _projectSandbox, ...projectConfig} = this.getScopedConfig('project');
    return merge(globalConfig, projectConfig);
  }

  /** Adds or removes one filesystem rule in the selected scope. */
  async updateFilesystem(
    scope: ConfigScope,
    permission: FilesystemPermission | readonly FilesystemPermission[],
    action: ListAction,
    path: string,
  ): Promise<void> {
    await this.reload();
    const scopedConfig = this.getScopedConfig(scope);
    const validation = FilesystemConfigSchema.safeParse({
      ...scopedConfig.filesystem,
      allowRead: scopedConfig.filesystem?.allowRead ?? [],
      allowWrite: scopedConfig.filesystem?.allowWrite ?? [],
      denyRead: scopedConfig.filesystem?.denyRead ?? [],
      denyWrite: scopedConfig.filesystem?.denyWrite ?? [],
    });
    if (!validation.success) {
      throw new Error(`Invalid SRT filesystem configuration: ${validation.error.message}`);
    }

    const filesystem = validation.data;
    const permissions = typeof permission === 'string' ? [permission] : permission;
    for (const key of permissions) {
      const entries = filesystem[key] ?? [];
      filesystem[key] = action === 'add'
        ? [...new Set([...entries, path])]
        : entries.filter(entry => entry !== path);
    }

    scopedConfig.filesystem = filesystem;
    await this.save();
  }

  /** Adds or removes one network rule in the selected scope. */
  async updateDomain(
    scope: ConfigScope,
    permission: NetworkPermission,
    action: ListAction,
    domain: string,
    reason?: string,
  ): Promise<void> {
    const key = permission === 'allow' ? 'allowedDomains' : 'deniedDomains';
    const domainValidation = NetworkConfigSchema.safeParse({
      allowedDomains: permission === 'allow' ? [domain] : [],
      deniedDomains: permission === 'deny' ? [domain] : [],
    });
    if (!domainValidation.success) {
      throw new Error(`Invalid SRT domain pattern: ${domain}`);
    }

    await this.reload();
    const scopedConfig = this.getScopedConfig(scope);
    const validation = NetworkConfigSchema.safeParse({
      ...scopedConfig.network,
      allowedDomains: scopedConfig.network?.allowedDomains ?? [],
      deniedDomains: scopedConfig.network?.deniedDomains ?? [],
    });
    if (!validation.success) {
      throw new Error(`Invalid SRT network configuration: ${validation.error.message}`);
    }

    const network = validation.data;
    network[key] = action === 'add'
      ? [...new Set([...network[key], domain])]
      : network[key].filter(entry => entry !== domain);
    if (permission === 'deny') {
      const reasons = network.deniedDomainReasons ?? {};
      if (action === 'add' && reason !== undefined) {
        reasons[domain] = reason;
      } else if (action === 'remove') {
        const {[domain]: _removed, ...remainingReasons} = reasons;
        network.deniedDomainReasons = remainingReasons;
      }

      network.deniedDomainReasons ??= reasons;
    }

    scopedConfig.network = network;
    await this.save();
  }

  /** Preserves the existing network-deny prompt API used by automatic prompts. */
  async addDomain(scope: ConfigScope, domain: string): Promise<void> {
    await this.updateDomain(scope, 'allow', 'add', domain);
  }

  /** Returns only settings explicitly stored in a scope, excluding Sloppi metadata. */
  getScopedSrtConfig(scope: ConfigScope): Config {
    const scopedConfig = this.getScopedConfig(scope);
    const {projects: _projects, sandbox: _sandbox, ...srtConfig} = scopedConfig;
    return srtConfig;
  }

  /** Replaces a scope's SRT settings after validating the resulting effective policy. */
  async replaceSrtConfig(scope: ConfigScope, replacement: Config): Promise<void> {
    await this.reload();
    const previous = this.getScopedConfig(scope);
    const sandboxConfig = previous.sandbox;
    const next = sandboxConfig === undefined ? replacement : {...replacement, sandbox: sandboxConfig};

    if (scope === 'global') {
      next.projects = this.config.projects;
      this.config = next;
    } else {
      this.config.projects ??= {};
      this.config.projects[this.cwd] = next;
    }

    const validation = SandboxRuntimeConfigSchema.safeParse(merge({
      network: {allowedDomains: [], deniedDomains: []},
      filesystem: {
        allowRead: [],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
    }, this.getEffectiveConfig()));
    if (!validation.success) {
      if (scope === 'global') {
        this.config = previous;
      } else if (this.config.projects !== undefined) {
        this.config.projects[this.cwd] = previous;
      }

      throw new Error(`Invalid SRT configuration: ${validation.error.message}`);
    }

    await this.save();
  }

  /** Removes all settings stored in one scope. */
  async resetScope(scope: ConfigScope): Promise<void> {
    await this.reload();
    if (scope === 'global') {
      this.config = this.config.projects === undefined
        ? {}
        : {projects: this.config.projects};
    } else if (this.config.projects !== undefined) {
      const {[this.cwd]: _project, ...remainingProjects} = this.config.projects;
      this.config.projects = remainingProjects;
    }

    await this.save();
  }

  /** Persists the current configuration without legacy project entries. */
  async save(): Promise<void> {
    const {[this.cwd]: _legacy, ...updatedConfig} = this.config;
    this.config = updatedConfig;
    await mkdir(dirname(this.path), {recursive: true});
    await writeFile(this.path, `${JSON.stringify(this.config, undefined, 2)}\n`);
  }

  /** Returns whether optional research-agent delegation is enabled. */
  areResearchAgentsEnabled(): boolean {
    return z.boolean().optional().parse(this.config.sandbox?.researchAgentsEnabled) ?? false;
  }

  /** Persists whether research-agent delegation is available to the main agent. */
  async setResearchAgentsEnabled(isEnabled: boolean): Promise<void> {
    await this.reload();
    const sandboxConfig = this.config.sandbox ?? {};
    sandboxConfig.researchAgentsEnabled = isEnabled;
    this.config.sandbox = sandboxConfig;
    await this.save();
  }

  /** Returns the default model for research profiles that do not select one. */
  getResearchScoutModel(): z.infer<typeof researchScoutModelSchema> | undefined {
    return researchScoutModelSchema.optional().parse(this.config.sandbox?.researchScoutModel);
  }

  /** Persists the default model used by profiles without a model. */
  async setResearchScoutModel(model: z.infer<typeof researchScoutModelSchema> | undefined): Promise<void> {
    await this.reload();
    const sandboxConfig = this.config.sandbox ?? {};
    if (model === undefined) {
      delete sandboxConfig.researchScoutModel;
    } else {
      sandboxConfig.researchScoutModel = researchScoutModelSchema.parse(model);
    }

    this.config.sandbox = sandboxConfig;
    await this.save();
  }

  /** Sets whether blocked network requests prompt for access in the selected scope. */
  async setPrompting(scope: ConfigScope, isEnabled: boolean): Promise<void> {
    await this.reload();
    const scopedConfig = this.getScopedConfig(scope);
    const sandboxConfig = scopedConfig.sandbox ?? {};
    sandboxConfig.promptOnNetworkDeny = isEnabled;
    scopedConfig.sandbox = sandboxConfig;
    await this.save();
  }

  /**
   Validates and combines declarative request policies from both configuration scopes.
   */
  getRequestPolicies(): RequestPolicy[] {
    const projectConfig = this.getScopedConfig('project');
    return [
      ...requestPoliciesSchema.parse(this.config.sandbox?.requestPolicies ?? []),
      ...requestPoliciesSchema.parse(projectConfig.sandbox?.requestPolicies ?? []),
    ];
  }

  /** Returns host environment variable names explicitly exposed by global or project configuration. */
  getExposedEnv(): string[] {
    const projectConfig = this.getScopedConfig('project');
    const names = [...new Set([
      ...(this.config.sandbox?.exposeEnv ?? []),
      ...(projectConfig.sandbox?.exposeEnv ?? []),
    ])];
    const invalidName = names.find(name => !/^[A-Z_a-z]\w*$/v.test(name));
    if (invalidName !== undefined) {
      throw new Error(`Invalid sandbox.exposeEnv variable name: ${invalidName}`);
    }

    return names;
  }

  /** Returns the current project's prompt setting, falling back to global and then true. */
  shouldPrompt(): boolean {
    const globalPromptSetting = this.config.sandbox?.promptOnNetworkDeny;
    const projectConfig = this.getScopedConfig('project');
    const projectPromptSetting = projectConfig.sandbox?.promptOnNetworkDeny;
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
}
