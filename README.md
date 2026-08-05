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

## Extensions

- `ask-mode.ts` – `/ask on|off|toggle` limits Pi to read, grep, find, and ls.
- `delete-gate.ts` – `/delete on|off|toggle|status` confirms destructive bash commands.
- `slopbox.ts` – sandboxes filesystem tools and adds `/slopbox add <directory>` for session access to another directory.
- `startup-banner.ts` – renders the TUI banner.
- `status-line.ts` – shows the OS and Git working-tree status in the footer.

`test/` contains the extension tests. `agent/settings.json` is local Pi configuration.

## Sandbox

Sloppi runs every filesystem-capable Pi tool through [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime). Each Pi session can write only its current project and a private temporary directory; it can read its project, global skills, and system files. Use `/slopbox add <directory>` to allow one additional directory whenever Pi opens that project. Network access is denied by default. This experimental boundary fails closed when SRT is unavailable. macOS uses its built-in Seatbelt sandbox and requires `ripgrep`; Linux also requires `bubblewrap`, `socat`, and `fd`.

## Local development

- `npm test` – run tests
- `npm run lint` – lint code
- `npm run check` – type-check

## Notes

- Not published as a package.
- Runtime/local agent state is gitignored.
