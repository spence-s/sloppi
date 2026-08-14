# Sloppi

```text
  ███████╗██╗      ██████╗ ██████╗ ██████╗ ██╗       ╭╮  )(  ╭╮   )       ╲╲
  ██╔════╝██║     ██╔═══██╗██╔══██╗██╔══██╗██║       ╰╯ (  ) ╰╯  (         ╲╲
  ███████╗██║     ██║   ██║██████╔╝██████╔╝██║     ╔════════════════╗       ╲╲
  ╚════██║██║     ██║   ██║██╔═══╝ ██╔═══╝ ██║     ║ ██  ≋≋≋  ██  ≋≋ ║       ╲╲
  ███████║███████╗╚██████╔╝██║     ██║     ██║      ╚██████████████╝
  ╚══════╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝     ╚═╝        ████████████
```

A shareable [Pi](https://pi.dev) package that sandboxes filesystem tools, adds a read-only chat mode, and customizes the terminal header and footer.

## Install

Review the source before installing: Pi packages execute with your user permissions.

```bash
pi install git:github.com/spence-s/sloppi
```

To try it for one session without changing Pi settings:

```bash
pi -e git:github.com/spence-s/sloppi
```

Manage the installation with:

```bash
pi update git:github.com/spence-s/sloppi
pi remove git:github.com/spence-s/sloppi
pi config # enable or disable individual Sloppi extensions
```

Sloppi does not change Pi's project trust behavior.

## Requirements

- Node.js 22 or newer
- macOS: `brew install ripgrep`
- Linux: install `bubblewrap`, `socat`, `ripgrep`, and `fd`

Sandbox currently supports macOS and Linux. Its status line uses Nerd Font icons but remains usable without them.

For web research in chat mode, install [`pi-web-access`](https://github.com/nicobailon/pi-web-access) separately:

```bash
pi install npm:pi-web-access
```

## Extensions

- `chat-mode.ts` — `/chat on|off|toggle|status` switches between read-only chat mode and full-access agent mode.
- `sandbox/` — runs Pi's filesystem tools inside Anthropic Sandbox Runtime; `/sandbox` manages its access.
- `startup-banner.ts` — replaces Pi's TUI header.
- `status-line.ts` — adds OS and Git status below Pi's footer.

Sandbox overrides Pi's built-in `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` tools. It blocks unapproved extension tools from host execution; Pi web-access tools remain host-side so provider credentials are not exposed to sandboxed commands.

## Sandbox configuration

Sandbox writes `sandbox.json` beside Pi's agent directory. This is `~/.pi/sandbox.json` by default and follows `PI_CODING_AGENT_DIR` when that environment variable is set.

Global SRT options live at the root. Project overrides live under `projects["/absolute/project/path"]`; arrays are combined and project scalar values override global values.

```json
{
  "network": {
    "allowedDomains": ["registry.npmjs.org:443"]
  },
  "projects": {
    "/absolute/project/path": {
      "filesystem": {
        "allowRead": ["/shared/read-only"],
        "allowWrite": ["/shared/writable"]
      }
    }
  }
}
```

Use `/sandbox` to manage the current project's access interactively. Use `/sandbox global` to open the same controls for global access. Access views and rule lists show the effective configuration, while changes apply only to the selected project or global layer. The advanced editor validates the complete serializable SRT configuration before saving and warns before enabling weaker isolation options.

By default, filesystem tools can write only the current project and private session scratch space. Global Pi skills and Git/npm package directories are readable. Network access is denied until allowed. A blocked network request can prompt to add a project domain rule; use `/sandbox` to disable those prompts.

Sandbox is an additional experimental boundary, not a guarantee. Broad filesystem paths, domains, Unix sockets, Apple Events, or weaker SRT isolation options reduce its protection. See [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) for platform limitations.

## Development

```bash
npm install
npm run check
npm run lint
npm test
```

Tests use Node's native test runner. Runtime state and machine-specific Pi settings are gitignored.
