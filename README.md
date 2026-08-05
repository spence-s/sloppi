# Sloppi

```text
  ███████╗██╗      ██████╗ ██████╗ ██████╗ ██╗       ╭╮  )(  ╭╮   )       ╲╲
  ██╔════╝██║     ██╔═══██╗██╔══██╗██╔══██╗██║       ╰╯ (  ) ╰╯  (         ╲╲
  ███████╗██║     ██║   ██║██████╔╝██████╔╝██║     ╔════════════════╗       ╲╲
  ╚════██║██║     ██║   ██║██╔═══╝ ██╔═══╝ ██║     ║ ██  ≋≋≋  ██  ≋≋ ║       ╲╲
  ███████║███████╗╚██████╔╝██║     ██║     ██║      ╚██████████████╝
  ╚══════╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝     ╚═╝        ████████████
```

Personal Pi setup repository.

This repo contains my local Pi configuration and custom extensions, currently for personal use only.

## Contents

- `agent/extensions/` – custom Pi extensions
  - `ask-mode.ts` – ask mode with read and ripgrep access (no bash/edit/write)
  - `delete-gate.ts` – interactive file deletion guard (`/delete on|off|toggle|status`)
  - `sudo-gate.ts` – sudo policy gate (`/sudo deny|ask|allow|status`)
  - `pipeline.ts` – multi-step scout → planner → worker → reviewer pipeline command
- `agent/agents/` – agent role definitions used by the pipeline extension
- `test/` – extension tests
- `agent/settings.json` – local Pi settings

## Sandbox

Sloppi runs every filesystem-capable Pi tool through [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime). Each Pi session can read and write only its current project and a private temporary directory; network access is denied by default. This experimental boundary fails closed when SRT is unavailable. Linux requires `bubblewrap` and `socat`; macOS uses its built-in Seatbelt sandbox.

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
