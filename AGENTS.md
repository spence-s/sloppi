# AGENTS.md - Development Guidelines for AI Coding Agents

This file defines how AI coding agents should work in this repository. Follow these rules unless explicitly instructed otherwise.

## Pi Repository Context

- This repository is symlinked to `~/.pi`.
- It contains pi-specific extensions and related configuration.
- When working in this repository, agents should always read relevant pi documentation before making changes.

## Core Workflow

1. Inspect relevant files first.
2. Make a short plan.
3. Apply minimal, targeted edits.
4. Validate with the appropriate checks before finalizing.

Recommended validation commands:

- `npm run check`
- `npm run lint`
- `npm test` (or targeted tests when appropriate)

Single-test patterns:

```bash
node --test test/index.test.ts
node --test test/**/*.test.ts
node --test --watch test/index.test.ts
```

## Non-Negotiable TypeScript + ESM Rules

- Pure ESM only (`"type": "module"`); never use `require()`.
- Always include `.ts` extension in local TypeScript imports.
- Use `import type` for type-only imports.
- Keep code compatible with strict TypeScript settings.
- Handle values that may be `undefined` (`noUncheckedIndexedAccess`).
- Do not use non-erasable TS features (for example, enums or namespaces).

## Testing Conventions

- Use Node.js native test runner (`node:test`) and `node:assert`.
- Keep tests under `test/**/*.test.ts`.
- Keep tests focused and deterministic.

## Style & Safety

- 2-space indentation, LF line endings, final newline.
- Avoid `any` where possible.
- Prefer self-documenting code; comments should explain "why" when needed.

## Source of Truth

If this file ever conflicts with project config, treat these as authoritative:

- `package.json` (scripts/runtime)
- `tsconfig.json` (TypeScript behavior)
- `xo.config.ts` (lint/format rules)

## Sloppi sandbox

Sloppi routes Pi filesystem tools through Anthropic Sandbox Runtime (SRT). Keep sandbox policy generated from trusted extension code, never from project-controlled files. Do not add host-executed agent tools without an explicit sandbox boundary.

See docs for srt here: https://github.com/anthropic-experimental/sandbox-runtime
