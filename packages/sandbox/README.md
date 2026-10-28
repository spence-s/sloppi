# Sloppi Sandbox

A standalone Pi extension providing sandboxed filesystem and shell tools through
Anthropic Sandbox Runtime, plus the existing research agents and Playwright bridge.

From a checkout of the Sloppi repository:

```bash
npm install
pi -e ./packages/sandbox
```

Once published, install with `pi install npm:@sloppi/sandbox`. Sloppi already
includes this extension; do not also enable a standalone copy in the same session.

Use `/sandbox` to manage access and `/sandbox on|off|toggle|status` to control the
current session. Configuration remains in `sandbox.json` beside Pi's agent directory
(`~/.pi/sandbox.json` by default), including existing per-project settings.

Requirements: Node.js ^22.21.0 or >=24.5.0; macOS with ripgrep, or Linux with
bubblewrap, socat, ripgrep, and fd. The optional browser bridge requires Google Chrome.

## Security boundary

The extension replaces `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write`, and
uses sandboxed filesystem operations for `research_scout`. Other extensions and
their tools retain their normal host permissions. Turning the sandbox off runs
managed tools on the host. The optional Playwright bridge controls host Chrome;
it does not run Chrome itself inside SRT.

See the [Sloppi documentation](https://github.com/spence-s/sloppi#requirements)
for configuration, research profiles, browser behavior, and security limitations.
