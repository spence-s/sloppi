import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

type PipelineMode = 'plan' | 'run';

type ParsedPipelineInput =
  | {
    ok: true;
    mode: PipelineMode;
    goal: string;
  }
  | {
    ok: false;
    reason: string;
  };

type AgentConfig = {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: 'user' | 'project';
  filePath: string;
};

type PipelineStep = {
  step: 'scout' | 'planner' | 'worker' | 'reviewer';
  prompt: string;
};

type JsonMessageContent =
  | {
    type: 'text';
    text: string;
  }
  | {
    type: string;
    [key: string]: unknown;
  };

type JsonAssistantMessage = {
  role?: string;
  content?: JsonMessageContent[];
  stopReason?: string;
  errorMessage?: string;
};

type StepResult = {
  step: PipelineStep['step'];
  output: string;
  isError: boolean;
  error?: string;
};

const pipelineEntryType = 'pipeline-run';
const pipelineStatusId = '0:pipeline';

export function parsePipelineCommandInput(raw: string): ParsedPipelineInput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {ok: false, reason: 'Usage: /pipeline [plan|run] <goal>'};
  }

  const [firstToken, ...rest] = trimmed.split(/\s+/v);

  if (firstToken === 'plan' || firstToken === 'run') {
    const goal = rest.join(' ').trim();
    if (goal.length === 0) {
      return {
        ok: false,
        reason: `Usage: /pipeline ${firstToken} <goal>`,
      };
    }

    return {
      ok: true,
      mode: firstToken,
      goal,
    };
  }

  return {
    ok: true,
    mode: 'run',
    goal: trimmed,
  };
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
  let currentDirectory = cwd;

  while (true) {
    const candidate = path.join(currentDirectory, CONFIG_DIR_NAME, 'agents');
    try {
      if (nodeFs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep traversing.
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

async function loadAgentsFromDirectory(
  directory: string,
  source: AgentConfig['source'],
): Promise<AgentConfig[]> {
  let entries: nodeFs.Dirent[] = [];
  try {
    entries = await fs.readdir(directory, {withFileTypes: true});
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    let content = '';

    try {
      // eslint-disable-next-line no-await-in-loop
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    const {frontmatter, body} =
      parseFrontmatter<Record<string, string>>(content);

    if (frontmatter.name === undefined || frontmatter.description === undefined) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(',')
      .map(item => item.trim())
      .filter(Boolean);

    const agentConfig: AgentConfig = {
      name: frontmatter.name,
      description: frontmatter.description,
      systemPrompt: body.trim(),
      source,
      filePath,
    };

    if (tools !== undefined && tools.length > 0) {
      agentConfig.tools = tools;
    }

    if (frontmatter.model !== undefined && frontmatter.model.length > 0) {
      agentConfig.model = frontmatter.model;
    }

    agents.push(agentConfig);
  }

  return agents;
}

async function discoverAgents(cwd: string): Promise<Map<string, AgentConfig>> {
  const userDirectory = path.join(getAgentDir(), 'agents');
  const projectDirectory = nearestProjectAgentsDir(cwd);

  const userAgents = await loadAgentsFromDirectory(userDirectory, 'user');
  const projectAgents =
    projectDirectory === undefined
      ? []
      : await loadAgentsFromDirectory(projectDirectory, 'project');

  const byName = new Map<string, AgentConfig>();
  for (const agent of userAgents) {
    byName.set(agent.name, agent);
  }

  for (const agent of projectAgents) {
    byName.set(agent.name, agent);
  }

  return byName;
}

function extractFinalAssistantText(stdout: string): {
  output: string;
  stopReason?: string;
  errorMessage?: string;
} {
  const lines = stdout.split('\n');
  let finalOutput = '';
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let event: {type?: string; message?: JsonAssistantMessage};
    try {
      event = JSON.parse(trimmed) as {
        type?: string;
        message?: JsonAssistantMessage;
      };
    } catch {
      continue;
    }

    if (event.type !== 'message_end' || event.message?.role !== 'assistant') {
      continue;
    }

    const text = event.message.content
      ?.filter((part): part is {type: 'text'; text: string} => part.type === 'text')
      .map(part => part.text)
      .join('\n')
      .trim();

    if (text !== undefined && text.length > 0) {
      finalOutput = text;
    }

    stopReason = event.message.stopReason;
    errorMessage = event.message.errorMessage;
  }

  const result: {
    output: string;
    stopReason?: string;
    errorMessage?: string;
  } = {output: finalOutput};

  if (stopReason !== undefined) {
    result.stopReason = stopReason;
  }

  if (errorMessage !== undefined) {
    result.errorMessage = errorMessage;
  }

  return result;
}

function buildStepPrompt(
  step: PipelineStep['step'],
  goal: string,
  results: Partial<Record<PipelineStep['step'], string>>,
): string {
  if (step === 'scout') {
    return [
      `Goal: ${goal}`,
      'Perform read-only reconnaissance of the repository.',
      'Return:',
      '1) Relevant files and why they matter',
      '2) Risks/constraints',
      '3) Missing information and assumptions',
      'Keep it concise and actionable.',
    ].join('\n');
  }

  if (step === 'planner') {
    return [
      `Goal: ${goal}`,
      'Use this scout report as context:',
      results.scout ?? '(no scout output)',
      '',
      'Produce a numbered implementation plan with verification checkpoints.',
      'Keep steps concrete and ordered.',
    ].join('\n');
  }

  if (step === 'worker') {
    return [
      `Goal: ${goal}`,
      'Use this plan as context:',
      results.planner ?? '(no planner output)',
      '',
      'Implement the plan in small, safe increments.',
      'Run lint/typecheck/tests where relevant and report what changed.',
    ].join('\n');
  }

  return [
    `Goal: ${goal}`,
    'Review this implementation summary/output:',
    results.worker ?? '(no worker output)',
    '',
    'Perform an independent review.',
    'Report:',
    '- correctness issues',
    '- edge cases',
    '- testing gaps',
    '- final quality verdict',
  ].join('\n');
}

async function runAgentStep(
  pi: ExtensionAPI,
  agent: AgentConfig,
  step: PipelineStep,
  timeoutMs: number,
): Promise<StepResult> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pipeline-'));
  const systemPromptPath = path.join(temporaryDirectory, `${agent.name}.md`);

  try {
    await fs.writeFile(systemPromptPath, agent.systemPrompt, 'utf8');

    const args = ['--mode', 'json', '-p', '--no-session'];
    if (agent.model !== undefined && agent.model.length > 0) {
      args.push('--model', agent.model);
    }

    if (agent.tools !== undefined && agent.tools.length > 0) {
      args.push('--tools', agent.tools.join(','));
    }

    args.push('--append-system-prompt', systemPromptPath, step.prompt);

    const execution = await pi.exec('pi', args, {timeout: timeoutMs});

    const parsed = extractFinalAssistantText(execution.stdout);

    if (execution.code !== 0 || parsed.stopReason === 'error' || parsed.stopReason === 'aborted') {
      const stderr = execution.stderr.trim();
      const stderrMessage = stderr.length > 0 ? stderr : undefined;

      return {
        step: step.step,
        output: parsed.output,
        isError: true,
        error:
          parsed.errorMessage
          ?? stderrMessage
          ?? `Agent step failed with exit code ${String(execution.code)}`,
      };
    }

    return {
      step: step.step,
      output: parsed.output,
      isError: false,
    };
  } catch (error) {
    return {
      step: step.step,
      output: '',
      isError: true,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown pipeline execution error',
    };
  } finally {
    await fs.rm(temporaryDirectory, {recursive: true, force: true});
  }
}

async function runPipeline(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  mode: PipelineMode,
  goal: string,
): Promise<{ok: boolean; summary: string}> {
  const discoveredAgents = await discoverAgents(ctx.cwd);

  const requiredAgents =
    mode === 'plan'
      ? (['scout', 'planner'] as const)
      : (['scout', 'planner', 'worker', 'reviewer'] as const);

  const missingAgents = requiredAgents.filter(name => !discoveredAgents.has(name));

  if (missingAgents.length > 0) {
    return {
      ok: false,
      summary: `Missing agent definitions: ${missingAgents.join(', ')}. Expected in ${path.join(getAgentDir(), 'agents')}.`,
    };
  }

  const outputs: Partial<Record<PipelineStep['step'], string>> = {};
  const steps: PipelineStep[] = requiredAgents.map(step => ({
    step,
    prompt: buildStepPrompt(step, goal, outputs),
  }));

  const timeoutMs = 10 * 60 * 1000;

  for (const [index, step] of steps.entries()) {
    const agent = discoveredAgents.get(step.step);
    if (agent === undefined) {
      return {ok: false, summary: `Missing configured agent: ${step.step}`};
    }

    ctx.ui.setStatus(
      pipelineStatusId,
      `${ctx.ui.theme.fg('accent', '🧠 pipeline')} ${ctx.ui.theme.fg('muted', `${index + 1}/${steps.length}`)} ${ctx.ui.theme.fg('warning', step.step)}`,
    );

    const resolvedStep: PipelineStep = {
      ...step,
      prompt: buildStepPrompt(step.step, goal, outputs),
    };

    // eslint-disable-next-line no-await-in-loop
    const result = await runAgentStep(pi, agent, resolvedStep, timeoutMs);

    pi.appendEntry(pipelineEntryType, {
      mode,
      goal,
      step: result.step,
      ok: !result.isError,
      output: result.output,
      error: result.error,
      timestamp: new Date().toISOString(),
    });

    if (result.isError) {
      ctx.ui.setStatus(pipelineStatusId, undefined);
      return {
        ok: false,
        summary: `Pipeline failed at ${result.step}: ${result.error ?? 'unknown error'}`,
      };
    }

    outputs[result.step] = result.output;
  }

  ctx.ui.setStatus(pipelineStatusId, undefined);

  if (mode === 'plan') {
    return {
      ok: true,
      summary:
        outputs.planner
        ?? outputs.scout
        ?? 'Plan pipeline completed with no output.',
    };
  }

  return {
    ok: true,
    summary:
      outputs.reviewer
      ?? outputs.worker
      ?? 'Pipeline completed with no output.',
  };
}

export default function pipeline(pi: ExtensionAPI): void {
  pi.registerCommand('pipeline', {
    description: 'Run multi-agent pipeline. Usage: /pipeline [plan|run] <goal>',
    async handler(args, ctx) {
      const parsed = parsePipelineCommandInput(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.reason, 'error');
        return;
      }

      ctx.ui.notify(
        `Running ${parsed.mode} pipeline for: ${parsed.goal}`,
        'info',
      );

      const result = await runPipeline(pi, ctx, parsed.mode, parsed.goal);

      if (!result.ok) {
        ctx.ui.notify(result.summary, 'error');
        return;
      }

      ctx.ui.notify('Pipeline completed.', 'info');
      ctx.ui.setEditorText(result.summary);
    },
  });
}
