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

## Local development

- `npm test` – run tests
- `npm run lint` – lint code
- `npm run check` – type-check
- `npm run pi-dev` – launch Pi in Lima with risky-command confirmation disabled by default. It keeps Linux `node_modules` on the VM disk, so macOS and Linux native dependencies never overwrite each other.
- Outbound HTTP GET/HEAD requests pass through the VM policy proxy. Other methods require a matching `domain [METHOD [exact-path]]` rule in `scripts/config/egress-domains.conf` or interactive approval. Approval can allow one request, permanently allow its method/domain/path, or permanently allow every request to its domain. Permanent rules are stored in `~/.pi/agent/network-access.json` and restored when the VM is rebuilt. Direct public egress is blocked; clients with certificate pinning will not work through the TLS-inspecting proxy.

## Notes

- Not published as a package.
- Runtime/local agent state is gitignored.

## Pipeline usage

- `/pipeline plan <goal>` – run scout + planner only and draft plan output in editor.
- `/pipeline run <goal>` – run full pipeline (scout → planner → worker → reviewer).
- `/pipeline <goal>` – shorthand for run mode.
