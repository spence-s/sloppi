import {Buffer} from 'node:buffer';
import {mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

type Part = {
  name: string;
  kind: 'Instructions' | 'Tools' | 'Conversation' | 'Request settings';
  value: unknown;
  bytes: number;
  tokens: number;
};

/**
 Escapes every payload-derived string before inserting it into the offline
 report. Captured prompts and tool results are untrusted, including markup
 that might otherwise execute when the user opens the report locally.
 */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;');
}

/**
 Adds an opt-in, one-shot snapshot and a local context-cost report without
 making another model request. Each capture lives in a fresh owner-only
 directory so sensitive history is neither shared nor written through an
 existing project-controlled symlink.
 */
export default function captureRequest(pi: ExtensionAPI): void {
  let isArmed = false;

  pi.registerCommand('capture-request', {
    description: 'Capture the next provider request and an offline context-cost report',
    /**
     Arms only the next provider request, including a retry if that is what
     happens next. Capturing does not itself submit a prompt or consume tokens.
     */
    async handler(_args, ctx) {
      isArmed = true;
      ctx.ui.notify('The next provider request will be captured with a private HTML context report.', 'info');
    },
  });

  /**
   Inspects the provider-shaped payload at the request hook without mutating
   it. Known instruction, tool, and history fields are separated; unknown
   fields remain visible as settings rather than silently disappearing.
   Token counts are deliberately labeled proxies: no provider tokenizer or
   response usage is available at this pre-request boundary.
   */
  pi.on('before_provider_request', async (event, ctx) => {
    if (!isArmed) {
      return;
    }

    isArmed = false;

    try {
      const json = JSON.stringify(event.payload, null, 2);
      const compact = JSON.stringify(event.payload);
      if (json === undefined || compact === undefined) {
        throw new Error('Provider payload is not JSON serializable.');
      }

      const parts: Part[] = [];
      /**
       Walks provider containers only far enough to isolate system messages,
       individual tools, and conversation messages. Keeping each value intact
       makes schema and message inspection faithful to the captured request.
       */
      function collect(value: unknown, name: string, kind: Part['kind']): void {
        if (Array.isArray(value) && value.length > 0) {
          for (const [index, item] of value.entries()) {
            collect(item, `${name}[${index}]`, kind);
          }

          return;
        }

        if (value !== null && typeof value === 'object') {
          if ('role' in value && (value.role === 'system' || value.role === 'developer')) {
            kind = 'Instructions';
          }

          if ('name' in value && typeof value.name === 'string') {
            name += ` · ${value.name}`;
          } else if ('role' in value && typeof value.role === 'string') {
            name += ` · ${value.role}`;
          }
        }

        const serialized = JSON.stringify(value) ?? 'null';
        // ponytail: character-based proxy, not a tokenizer. Provider-specific
        // token counting is the upgrade path when exact preflight counts matter.
        const text = typeof value === 'string' ? value : serialized;
        parts.push({
          name, kind, value, bytes: Buffer.byteLength(serialized), tokens: Math.ceil(text.length / 4),
        });
      }

      if (event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
        for (const [key, value] of Object.entries(event.payload)) {
          if (['instructions', 'system', 'systemInstruction', 'system_instruction'].includes(key)) {
            collect(value, key, 'Instructions');
          } else if (['tools', 'functions', 'toolConfig', 'tool_config'].includes(key)) {
            collect(value, key, 'Tools');
          } else if (['messages', 'input', 'contents'].includes(key)) {
            collect(value, key, 'Conversation');
          } else {
            collect(value, key, 'Request settings');
          }
        }
      } else {
        collect(event.payload, 'Unrecognized payload', 'Request settings');
      }

      const {model} = ctx;
      const instructions = parts.filter(part => part.kind === 'Instructions');
      const instructionTokens = instructions.reduce((sum, part) => sum + part.tokens, 0);
      const toolTokens = parts.filter(part => part.kind === 'Tools').reduce((sum, part) => sum + part.tokens, 0);
      const contextTokens = parts.filter(part => part.kind !== 'Request settings').reduce((sum, part) => sum + part.tokens, 0);
      const baselineTokens = instructionTokens + toolTokens;
      const inputRate = model?.cost.input;
      /**
       Uses Pi's configured USD-per-million rate, not a hard-coded catalog.
       Missing rates stay unknown; zero rates are shown but explained below
       because subscription and local models do not imply free API service.
       */
      function cost(tokens: number, rate: number | undefined): string {
        return rate === undefined || !Number.isFinite(rate) || rate < 0 ? 'Unknown' : `$${(tokens * rate / 1_000_000).toFixed(6)}`;
      }

      let rows = '';
      let details = '';
      const ordered = parts.toSorted((a, b) => b.bytes - a.bytes);
      for (const part of ordered) {
        const share = 100 * part.bytes / Buffer.byteLength(compact);
        rows += `<tr><th scope="row">${escapeHtml(part.name)}</th><td>${part.kind}</td><td>${part.bytes.toLocaleString()}</td><td><meter min="0" max="100" value="${share}">${share.toFixed(1)}%</meter> ${share.toFixed(1)}%</td><td>${part.kind === 'Request settings' ? '—' : `~${part.tokens.toLocaleString()}`}</td><td>${part.kind === 'Request settings' ? '—' : cost(part.tokens, inputRate)}</td></tr>`;
        details += `<details><summary>${escapeHtml(part.name)} · ${part.kind} · ${part.bytes.toLocaleString()} bytes</summary><pre>${escapeHtml(typeof part.value === 'string' ? part.value : JSON.stringify(part.value, null, 2))}</pre></details>`;
      }

      let instructionSections = '';
      const instructionText: unknown[] = instructions.map(part => part.value);
      // Provider instruction blocks wrap text differently. Inspect only their
      // text-bearing fields so roles and cache-control metadata are not prose.
      while (instructionText.length > 0) {
        const value = instructionText.shift();
        if (Array.isArray(value)) {
          const children: unknown[] = value;
          instructionText.push(...children);
        } else if (value !== null && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) {
            if (['text', 'content', 'parts'].includes(key)) {
              instructionText.push(child);
            }
          }
        } else if (typeof value === 'string') {
          for (const section of value.split(/(?=^#{1,6} )/mv)) {
            const title = section.split('\n', 1)[0] ?? 'Untitled instructions';
            const tokens = Math.ceil(section.length / 4);
            instructionSections += `<details><summary>${escapeHtml(title)} · ${Buffer.byteLength(section).toLocaleString()} text bytes · ~${tokens.toLocaleString()} tokens · ${cost(tokens, inputRate)}</summary><pre>${escapeHtml(section)}</pre></details>`;
          }
        }
      }

      let categories = '';
      for (const kind of ['Instructions', 'Tools', 'Conversation', 'Request settings']) {
        const bytes = parts.filter(part => part.kind === kind).reduce((sum, part) => sum + part.bytes, 0);
        categories += `<li><strong>${kind}</strong>: ${bytes.toLocaleString()} bytes</li>`;
      }

      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Pi context cost report</title>
<style>
:root{color-scheme:light dark;font:16px/1.6 system-ui}body{max-width:1200px;margin:auto;padding:24px}h1,h2{line-height:1.2}.cards{display:flex;flex-wrap:wrap;gap:16px}.card{border:1px solid #8888;border-radius:12px;padding:20px;flex:1;min-width:200px}.card strong{display:block;font-size:1.7rem}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:10px;border-bottom:1px solid #8886}meter{width:90px}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#8881}summary{cursor:pointer;padding:10px}details{border-bottom:1px solid #8886}.scroll{overflow-x:auto}.note{border-left:4px solid #a78bfa;padding:12px 20px}small{opacity:.8}
</style></head><body>
<h1>Pi context cost report</h1>
<p>${escapeHtml(new Date().toISOString())} · ${escapeHtml(model ? `${model.provider} / ${model.id} / ${model.api}` : 'Model unavailable')}</p>
<p class="note">Private snapshot: contains complete prompts, tool schemas, and conversation data. This page runs offline, loads no resources, and makes no model calls. Do not publish it.</p>
<div class="cards">
<section class="card">Instructions only<strong>~${instructionTokens.toLocaleString()} tokens</strong>${cost(instructionTokens, inputRate)} uncached / request</section>
<section class="card">Instructions + tool declarations<strong>~${baselineTokens.toLocaleString()} tokens</strong>${cost(baselineTokens, inputRate)} uncached / request</section>
<section class="card">Full recognized context<strong>~${contextTokens.toLocaleString()} tokens</strong>${cost(contextTokens, inputRate)} uncached input</section>
<section class="card">Compact payload<strong>${Buffer.byteLength(compact).toLocaleString()} bytes</strong>${Buffer.byteLength(`${json}\n`).toLocaleString()} bytes in formatted JSON file</section>
</div>
<h2>What the default context costs</h2>
<p>Instructions are the instruction-only baseline requested here. Tool definitions are separate, but also consume input context before you ask anything. This snapshot includes current project instructions, skill descriptions, and extension additions wherever the provider places them; it is not a measurement of a pristine Pi installation.</p>
<ul>${categories}</ul>
<p>Instructions + tools for 100 uncached requests: <strong>${cost(baselineTokens * 100, inputRate)}</strong>; for 1,000: <strong>${cost(baselineTokens * 1000, inputRate)}</strong>. This assumes the same baseline each time and excludes conversation growth and output.</p>
<p>Baseline if entirely cache-read: <strong>${cost(baselineTokens, model?.cost.cacheRead)}</strong>; if entirely cache-written: <strong>${cost(baselineTokens, model?.cost.cacheWrite)}</strong>. These are alternative rate scenarios, not observed cache hits or a billing prediction.</p>
<p>Configured USD / million tokens: input ${inputRate ?? 'unknown'}, cache read ${model?.cost.cacheRead ?? 'unknown'}, cache write ${model?.cost.cacheWrite ?? 'unknown'}, output ${model?.cost.output ?? 'unknown'}. Zero catalog rates may mean unavailable pricing or subscription billing, not free usage.</p>
<p>Context window: ${model?.contextWindow.toLocaleString() ?? 'unknown'} tokens; recognized context proxy: ${model !== undefined && model.contextWindow > 0 ? `${(100 * contextTokens / model.contextWindow).toFixed(1)}%` : 'unknown'}. Configured maximum output: ${model?.maxTokens.toLocaleString() ?? 'unknown'} tokens. Output reservation and provider limits can reduce usable input space.</p>
<h2>Payload breakdown · largest first</h2>
<p>Byte counts are exact UTF-8 sizes of compact JSON values, including quoting/escaping, not HTTP wire size. Outer field names, separators, and container brackets are not attributed to rows; percentages use the complete compact payload.</p>
<div class="scroll"><table><thead><tr><th>Field / item</th><th>Category</th><th>Bytes</th><th>Payload share</th><th>Token proxy</th><th>Uncached input</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Instruction sections</h2>
<p>Markdown headings split instruction text into inspectable sections. These are raw text byte sizes (without JSON escaping), already included above, not additional context. Headings are not reliable source attribution: extensions can combine or override instructions.</p>
${instructionSections === '' ? '<p>No recognized instruction text found; inspect the raw payload below.</p>' : instructionSections}
<h2>Tools available to this request</h2>
<p>Inspect the Tools entries below for the actual transmitted descriptions, parameters, and schemas. Availability does not imply the model must call a tool. Tool choice settings are shown as request settings. Deferred tools not declared in this payload have no separately measured schema cost here; their discovery instructions may still appear in the prompt.</p>
<h2>Accuracy and practical savings</h2>
<ul><li>Token proxies use one token per four JavaScript string characters (JSON for structured values). This is not a provider tokenizer. Non-English text, code, escaping, and schema framing can differ substantially. Images, audio, and encoded data make the proxy unreliable; their actual token accounting is provider-specific.</li>
<li>Only recognized provider fields are classified. Custom provider wrappers remain visible under request settings and are excluded from context estimates. System/developer history messages count as instructions, including later instruction changes. Provider-side hidden instructions and later request-hook edits are not observable here.</li>
<li>Cache eligibility depends on provider minimums, matching prefixes, retention, and request settings. Cache hits lower price, not context-window usage. No response usage or actual invoice is available at capture time. Model metadata is the currently selected Pi model; routed payload models may have different prices.</li>
<li>Every model turn, including tool follow-ups and retries, may resend context. Conversation and tool results usually grow beyond this baseline. Compaction reduces history, not necessarily instruction or tool overhead.</li>
<li>Start with the largest instruction and tool entries: shorten repeated project guidance, avoid embedding entire references, and deactivate unused tools. Skill catalogs cost context up front; reading a skill later adds its contents to history. Compare a fresh-session capture to this one before changing defaults.</li></ul>
<h2>Inspect captured content</h2>${details}
</body></html>\n`;
      const directory = await mkdtemp(path.join(ctx.cwd, 'request-capture-'));
      await writeFile(path.join(directory, 'latest-request.json'), `${json}\n`, {mode: 0o600});
      await writeFile(path.join(directory, 'last-instructions.txt'), instructions.map(part => typeof part.value === 'string' ? part.value : JSON.stringify(part.value, null, 2)).join('\n\n'), {mode: 0o600});
      const reportPath = path.join(directory, 'context-report.html');
      await writeFile(reportPath, html, {mode: 0o600});
      ctx.ui.notify(`Request captured in ${directory}\nOpen ${reportPath} for the context-cost report.`, 'info');
    } catch (error) {
      // Capturing is diagnostic: a disk or serialization failure must not
      // prevent the original model request from proceeding.
      ctx.ui.notify(`Request capture failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });
}
