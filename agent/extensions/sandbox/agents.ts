import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {getAgentDir, parseFrontmatter} from '@earendil-works/pi-coding-agent';

const readOnlyTools = ['read', 'grep', 'find', 'ls'] as const;

export type ResearchAgent = {
  name: string;
  description: string;
  tools: Array<(typeof readOnlyTools)[number]>;
  model?: string;
  systemPrompt: string;
};

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

const builtInAgents: ResearchAgent[] = [
  {
    name: 'scout',
    description: 'Find and summarize relevant repository context',
    tools: [...readOnlyTools],
    systemPrompt: 'Return concise findings: relevant files, observed behavior, risks, and suggested next steps.',
  },
  {
    name: 'planner',
    description: 'Create implementation plans from repository evidence',
    tools: [...readOnlyTools],
    systemPrompt: 'Create a focused implementation plan grounded in the repository. Name the files to change, important constraints, and validation steps. Do not claim changes were made.',
  },
  {
    name: 'reviewer',
    description: 'Review repository code for concrete correctness and security issues',
    tools: [...readOnlyTools],
    systemPrompt: [
      'Review the requested code for concrete correctness, security, and maintainability issues.',
      'Rank findings by severity and cite exact files. Do not invent issues or claim changes were made.',
    ].join(' '),
  },
];

/**
 Loads user-owned Markdown profiles while keeping every profile read-only.
 */
export function discoverResearchAgents(directory = join(getAgentDir(), 'agents')): ResearchAgent[] {
  const agents = new Map(builtInAgents.map(agent => [agent.name, agent]));
  let entries;
  try {
    entries = readdirSync(directory, {withFileTypes: true});
  } catch {
    return agents.values().toArray();
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md') || (!entry.isFile() && !entry.isSymbolicLink())) {
      continue;
    }

    let frontmatter: AgentFrontmatter;
    let body: string;
    try {
      const parsed = parseFrontmatter<AgentFrontmatter>(readFileSync(join(directory, entry.name), 'utf8'));
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch {
      continue;
    }

    if (typeof frontmatter.name !== 'string'
      || frontmatter.name.trim().length === 0
      || typeof frontmatter.description !== 'string'
      || frontmatter.description.trim().length === 0) {
      continue;
    }

    const configuredTools = new Set((Array.isArray(frontmatter.tools)
      ? frontmatter.tools
      : (typeof frontmatter.tools === 'string' ? frontmatter.tools.split(',') : readOnlyTools))
      .filter((tool): tool is string => typeof tool === 'string')
      .map(tool => tool.trim()));
    const tools = readOnlyTools.filter(tool => configuredTools.has(tool));
    const name = frontmatter.name.trim();
    agents.set(name, {
      name,
      description: frontmatter.description.trim(),
      tools,
      ...(typeof frontmatter.model === 'string' && frontmatter.model.trim().length > 0 && {model: frontmatter.model.trim()}),
      systemPrompt: body.trim(),
    });
  }

  return agents.values().toArray();
}
