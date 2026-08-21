# Sloppi

```text
  ███████╗██╗      ██████╗ ██████╗ ██████╗ ██╗       ╭╮  )(  ╭╮   )       ╲╲
  ██╔════╝██║     ██╔═══██╗██╔══██╗██╔══██╗██║       ╰╯ (  ) ╰╯  (         ╲╲
  ███████╗██║     ██║   ██║██████╔╝██████╔╝██║     ╔════════════════╗       ╲╲
  ╚════██║██║     ██║   ██║██╔═══╝ ██╔═══╝ ██║     ║ ██  ≋≋≋  ██  ≋≋ ║       ╲╲
  ███████║███████╗╚██████╔╝██║     ██║     ██║      ╚██████████████╝
  ╚══════╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝     ╚═╝        ████████████
```

A shareable [Pi](https://pi.dev) package that sandboxes filesystem tools, adds a read-only ask mode, and customizes the terminal header and footer.

## Install

Review the source before installing: Pi packages execute with your user permissions.

Install from npm:

```bash
pi install npm:sloppi
```

Or install the latest development version directly from GitHub:

```bash
pi install git:github.com/spence-s/sloppi
```

To try either source for one session without changing Pi settings:

```bash
pi -e npm:sloppi
pi -e git:github.com/spence-s/sloppi
```

Manage the installation with:

```bash
pi update npm:sloppi
pi remove npm:sloppi
pi config # enable or disable individual Sloppi extensions
```

Sloppi does not change Pi's project trust behavior.

## Requirements

- Node.js 22 or newer
- macOS: `brew install ripgrep`
- Linux: install `bubblewrap`, `socat`, `ripgrep`, and `fd`

Sandbox currently supports macOS and Linux. Its shell UI uses Nerd Font icons but remains usable without them.

For web research in ask mode, install [`pi-web-access`](https://github.com/nicobailon/pi-web-access) separately:

```bash
pi install npm:pi-web-access
```

## Extensions

- `ask-mode.ts` — `/ask on|off|toggle|status` controls modes; `/ask <prompt>` toggles modes before submitting the prompt.
- `commit.ts` — `/commit` stages all changes and loads an editable, model-generated Conventional Commit command into Pi's input; `/commit model` selects its model.
- `permissions/` — applies regex-based ask or deny rules to shell commands; `/permissions` edits project rules.
- `sandbox/` — runs Pi's filesystem tools inside Anthropic Sandbox Runtime; `/sandbox` manages its access. Its `research_scout` tool runs isolated scout, planner, reviewer, or user-defined profiles with only sandboxed read, grep, find, and list access. Select the default model with `/sandbox global` → `Research Scout model`.
- `startup-banner.ts` — replaces Pi's TUI header.
- `shell-ui.ts` — adds a Powerlevel10k-inspired prompt and status area to Pi's terminal UI.
- `zshrc.ts` — loads zsh aliases for host-side `!` commands.

Sandbox overrides Pi's built-in `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` tools. It blocks unapproved extension tools from host execution; Pi web-access tools remain host-side so provider credentials are not exposed to sandboxed commands.

### Research agent profiles

`research_scout` includes `scout`, `planner`, and `reviewer` profiles. Add user profiles under `~/.pi/agent/agents/*.md`:

```md
---
name: architecture-reviewer
description: Review repository architecture and boundaries
tools: read, grep, find, ls
model: anthropic/claude-sonnet-4-6
---

Review the requested architecture using repository evidence. Cite relevant files.
```

The `model` and `tools` fields are optional. Profiles without a model use the Research Scout model selected in `/sandbox global`. Tool choices are always restricted to `read`, `grep`, `find`, and `ls`; listing another tool does not grant it. User profiles with a built-in name override that profile. Existing calls without an `agent` continue to use `scout`.

## Sandbox configuration

Sandbox writes `sandbox.json` beside Pi's agent directory. This is `~/.pi/sandbox.json` by default and follows `PI_CODING_AGENT_DIR` when that environment variable is set.

Global SRT options live at the root. Project overrides live under `projects["/absolute/project/path"]`; arrays are combined and project scalar values override global values.

```json
{
  "network": {
    "allowedDomains": ["registry.npmjs.org:443"]
  },
  "sandbox": {
    "exposeEnv": ["SAFE_GLOBAL_VAR"]
  },
  "projects": {
    "/absolute/project/path": {
      "filesystem": {
        "allowRead": ["/shared/read-only"],
        "allowWrite": ["/shared/writable"]
      },
      "sandbox": {
        "exposeEnv": ["SAFE_PROJECT_VAR"]
      }
    }
  }
}
```

`exposeEnv` contains host environment variable names, not values. Global and project lists combine; missing variables are ignored. Exposing `HOME` opts into the host home directory for tool configuration lookup, but filesystem rules still control access to it. Sloppi's fixed `PATH`, `LANG`, `TMPDIR`, and `USER` values cannot be overridden.

Request policies add method, path, and exact header-value restrictions to an allowed destination:

```json
{
  "network": {
    "allowedDomains": ["api.example.com:443"]
  },
  "sandbox": {
    "requestPolicies": [{
      "destination": "api.example.com:443",
      "allow": [{
        "methods": ["POST"],
        "pathPrefixes": ["/v1/jobs"],
        "headers": {"x-environment": ["preview"]}
      }]
    }]
  }
}
```

Global and project request policies combine. A listed destination denies requests unless one `allow` rule matches; predicates within a rule all apply. `paths` matches exactly, while `pathPrefixes` matches a path segment and its children. Destinations require an exact `host:port` and must also be present in `network.allowedDomains`. Sloppi enables SRT TLS termination when policies are configured, so protected HTTPS destinations cannot be listed in `tlsTerminate.excludeDomains`. Do not store secret header values in this file. Run `/reload` after editing the file.

Use `/sandbox` to manage the current project's access interactively. Use `/sandbox global` to open the same controls for global access. Access views and rule lists show the effective configuration, while changes apply only to the selected project or global layer. Request policies are configured manually; the advanced editor validates the complete serializable SRT configuration before saving and warns before enabling weaker isolation options.

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
