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
  - `tool-permission-gate.ts` – interactive guard for risky bash commands
  - `pipeline.ts` – multi-step scout → planner → worker → reviewer pipeline command
- `agent/agents/` – agent role definitions used by the pipeline extension
- `test/` – extension tests
- `agent/settings.json` – local Pi settings

## Local development

- `npm test` – run tests
- `npm run lint` – lint code
- `npm run check` – type-check

## Pi development VM

`npm run pi-dev` starts Pi in a persistent Lima VM. `~/Projects` is its only read-write host mount; Pi state, credentials, npm cache, and `node_modules` remain in the VM.

- `npm run pi-dev` – run Pi from a project under `~/Projects`
- `npm run pi-dev -- up` – start the VM
- `npm run pi-dev -- shell` – open a shell in the VM
- `npm run pi-dev -- down` – stop the VM
- `npm run pi-dev -- destroy` – delete the VM

Host zsh configuration is mounted read-only: `~/.zsh` is shared live and `~/.zshrc` syncs before each VM launch. The VM uses zsh by default.

## Notes

- Not published as a package.
- Runtime/local agent state is gitignored.

## Pipeline usage

- `/pipeline plan <goal>` – run scout + planner only and draft plan output in editor.
- `/pipeline run <goal>` – run full pipeline (scout → planner → worker → reviewer).
- `/pipeline <goal>` – shorthand for run mode.
