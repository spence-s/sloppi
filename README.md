# my-pi

Personal Pi setup repository.

This repo contains my local Pi configuration and custom extensions, currently for personal use only.

## Contents

- `agent/extensions/` – custom Pi extensions
  - `ask-mode.ts` – ask mode with read and ripgrep access (no bash/edit/write)
  - `tool-permission-gate.ts` – interactive guard for risky bash commands
  - `pipeline.ts` – multi-step scout → planner → worker → reviewer pipeline command
- `agent/agents/` – agent role definitions used by the pipeline extension
- `test/` – extension tests
- `agent/settings.json` – local Pi settings

## Local development

- `npm test` – run tests
- `npm run lint` – lint code
- `npm run check` – type-check

## Notes

- Not published as a package.
- Runtime/local agent state is gitignored.

## Pipeline usage

- `/pipeline plan <goal>` – run scout + planner only and draft plan output in editor.
- `/pipeline run <goal>` – run full pipeline (scout → planner → worker → reviewer).
- `/pipeline <goal>` – shorthand for run mode.
