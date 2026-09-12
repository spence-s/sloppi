
 Prioritized findings

 ### 1. Critical — SRT per-command cleanup is never called

 Evidence

 - Every sandboxed execution calls SandboxManager.wrapWithSandbox() at agent/extensions/sandbox/session-manager.ts:270-274.
 - On Linux, each successful wrap increments activeSandboxCount; SRT explicitly says the caller must invoke cleanup after the command exits:
   node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js:1443-1449.
 - SRT exposes cleanupAfterCommand() specifically to remove bwrap mount artifacts:
   .../sandbox-manager.js:1548-1559.
 - SRT’s own CLI calls it after every child exit:
   node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js:264-269.

 Impact

 Linux sessions accumulate active-command accounting and temporary bwrap mount points until full session reset. Since pipelines wrap both source and
 destination, they leak two counts per invocation. This can leave ghost protected files and degrade long-running sessions.

 Recommendation

 Call SandboxManager.cleanupAfterCommand() in SandboxSessionManager.run() after every successfully wrapped process settles, including cancellation and
 timeout. Track two successful wraps for pipelines and clean up each one in finally.

 ────────────────────────────────────────────────────────────────────────────────

 ### 2. Critical performance — ls can launch over 1,000 sandboxed processes

 Evidence

 Sloppi implements:

 - exists: one process (tools.ts:360-362)
 - root stat: two processes (tools.ts:364-371)
 - readdir: one process (tools.ts:373-379)
 - every child stat: another two processes

 Pi calls stat() sequentially for every returned entry:
 node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.js:67-81.

 At the default 500-entry limit, one ls can therefore run approximately:

 ```text
   1 + 2 + 1 + (500 × 2) = 1,004 sandboxed commands
 ```

 Each command also rebuilds an SRT wrapper. Linux wrapper generation includes mandatory-deny discovery and mount setup.

 Recommendation

 Have readdir() collect names and directory status in one sandbox process and cache those statuses for subsequent stat() calls. A sandboxed Node script
 using readdir(..., {withFileTypes: true}) gives robust JSON without filename-delimiter problems. This preserves Pi’s existing LsOperations API while
 reducing the call to roughly 2–4 processes.

 ────────────────────────────────────────────────────────────────────────────────

 ### 3. High — Network approval resets SRT while sibling tools may still be running

 Evidence

 A blocked tool result immediately calls sandbox.restartSession() at agent/extensions/sandbox/index.ts:148-150.

 Pi documents that sibling tools run concurrently and tool_result events interleave in completion order:

 - docs/extensions.md:784
 - tool-result lifecycle documentation in docs/extensions.md

 Consequently, one denied network command can reset the global SRT proxy and scratch session while another tool from the same batch is still executing.

 Impact

 Possible interrupted commands, deleted temporary files, closed proxy connections, and nondeterministic failures. A complete reset is also much slower
 than necessary for a domain-only policy change.

 Recommendation

 Use SandboxManager.updateConfig() for domain approvals. SRT explicitly documents network allowlist changes as live swaps that need no proxy restart:
 node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js:1496-1546.

 Reserve reset/reinitialize for filesystem, TLS-filter, or other non-live changes.

 ────────────────────────────────────────────────────────────────────────────────

 ### 4. High compatibility — The bash override actually executes with sh

 Evidence

 agent/extensions/sandbox/tools.ts:124-135 routes Pi’s bash tool through:

 ```ts
   sh -c ${command}
 ```

 Pi’s built-in implementation resolves and runs Bash or the configured shell, and the tool is presented to the model as bash.

 Impact

 Valid Bash syntax may fail:

 - [[ ... ]]
 - arrays
 - source
 - brace expansion
 - set -o pipefail
 - process substitution

 This discrepancy remains even when /sandbox off is selected because the same override still runs through sh -c.

 Recommendation

 Execute with bash -c, or preserve Pi’s configured shell semantics. Avoid adding another nested shell if SRT’s wrapper can directly receive the original
 command and desired binShell.

 ────────────────────────────────────────────────────────────────────────────────

 ### 5. High API drift — Built-in tool metadata is accidentally discarded

 Evidence

 The overrides register values from createReadTool(), createEditTool(), etc. at agent/extensions/sandbox/tools.ts:384-420.

 Those functions return AgentTool wrappers. Pi’s wrapper intentionally drops renderers, renderShell, promptSnippet, and promptGuidelines:
 node_modules/@earendil-works/pi-coding-agent/dist/core/tools/tool-definition-wrapper.js:2-12.

 Pi’s documentation explicitly says prompt metadata is not inherited when overriding a built-in tool:
 docs/extensions.md:2097-2101.

 Only Bash happens to copy prompt metadata back in its factory. The other overrides lose instructions such as:

 - use read instead of cat
 - use write only for complete rewrites
 - use one multi-block edit call for multiple changes

 Recommendation

 Register createReadToolDefinition(), createEditToolDefinition(), and the corresponding definition factories instead of the create*Tool() AgentTool
 wrappers. Override only execute where needed. This also retains edit’s renderShell: "self" and exact built-in renderers.

 ────────────────────────────────────────────────────────────────────────────────

 ### 6. High performance — Reads transfer and buffer entire files through Base64

 Evidence

 A normal read performs up to three sandboxed commands:

 1. test -r
 2. file --mime-type
 3. base64 < file

 See agent/extensions/sandbox/tools.ts:63-87.

 Base64 inflates data by roughly one third. The resulting string and decoded buffer are both retained before Pi applies its 50KB/2,000-line truncation.
 Grep with context compounds this by reading every matched file in full at tools.ts:228-248.

 Impact

 Large files cause unnecessary process launches, CPU, allocations, and potentially hundreds of megabytes of temporary memory despite tiny final tool
 output.

 Recommendation

 In order:

 1. Add a binary-output mode to SandboxSessionManager.run() and remove Base64.
 2. Combine MIME detection and reading into one sandbox invocation.
 3. For text reads, eventually apply offset, line, and byte bounds inside the sandbox before returning data.
 4. For grep context, consume rg --json --context directly rather than reopening every matched file.

 ────────────────────────────────────────────────────────────────────────────────

 ### 7. Medium-high compatibility — Tool factories are version-sensitive, but Pi peers accept every version

 Evidence

 package.json:70-72 declares:

 ```json
   "@earendil-works/pi-coding-agent": "*",
   "@earendil-works/pi-tui": "*"
 ```

 The implementation depends on detailed and evolving APIs including:

 - tool operation interfaces and result details
 - ResourceLoader
 - ModelRuntime
 - renderer context
 - event ordering
 - built-in tool schemas

 SRT itself is explicitly a beta research preview whose APIs may evolve:
 node_modules/@anthropic-ai/sandbox-runtime/README.md:7-9.

 Recommendation

 Use a tested Pi compatibility range, such as the current minor series, and widen it only after CI verifies newer versions. Add a small compatibility
 test asserting retained tool metadata and exact result-detail shapes.

 ────────────────────────────────────────────────────────────────────────────────

 ### 8. Medium compatibility — Image behavior differs from Pi’s advertised read API

 Evidence

 The inherited read description advertises BMP support, but Sloppi accepts only GIF, JPEG, PNG, and WebP MIME values:
 agent/extensions/sandbox/tools.ts:80-87.

 Pi’s implementation also performs signature validation and deliberately rejects unsupported JPEG variants and animated PNGs:
 node_modules/@earendil-works/pi-coding-agent/dist/utils/mime.js.

 Sloppi trusts the external file classification instead.

 Impact

 BMP files are returned as text/binary garbage rather than image attachments. Animated or malformed formats may be treated differently from native Pi.

 Recommendation

 At minimum, include image/bmp. Prefer Pi-equivalent signature sniffing over external file; it is faster, removes one process/dependency, and keeps
 behavior aligned.

 ────────────────────────────────────────────────────────────────────────────────

 ### 9. Medium — Research Scout emits excessive UI updates and rebuilds components

 Evidence

 - Spinner updates every 80ms: agent/extensions/sandbox/subagent.ts:367-370.
 - Thinking/text deltas also invoke updateProgress() individually: subagent.ts:378-399.
 - Each update copies up to 12KB of progress and reconstructs result details: subagent.ts:325-343.
 - The renderer creates a new component tree instead of reusing context.lastComponent.

 Pi’s TUI documentation recommends caching rendered output:
 docs/tui.md:496-508.

 Recommendation

 Throttle all partial updates to approximately 150–250ms, and suppress spinner-only updates when a real stream update just occurred. Reuse
 context.lastComponent or a small mutable dashboard component.

 ────────────────────────────────────────────────────────────────────────────────

 ### 10. Medium — Configuration writes are neither locked nor atomic

 Evidence

 Every mutation reloads, changes in memory, then directly overwrites the shared file:
 agent/extensions/sandbox/config.ts:310-315.

 The existing test demonstrates sequential updates from two stores, not concurrent writes.

 Impact

 Two Pi processes approving domains or editing rules simultaneously can lose one update. A crash during writeFile() can leave truncated JSON and prevent
 future sandbox startup.

 Recommendation

 Lock the read-modify-write transaction and write via temporary file plus atomic rename. This matters because sandbox.json is shared across all projects
 and sessions.

 ────────────────────────────────────────────────────────────────────────────────

 ### 11. Medium performance — Pipelines build two independent complete sandboxes

 Evidence

 SandboxSessionManager.run() wraps both the source and head separately:
 agent/extensions/sandbox/session-manager.ts:270-274.

 Grep and find both use this path.

 Impact

 Duplicate profile generation, Linux deny scans, bwrap setup, shells, and cleanup accounting merely to run head.

 Recommendation

 Wrap one shell pipeline as a single SRT command. Keep the current argument quoting, but move the bounded consumer into the same wrapped command. This
 also simplifies cancellation and cleanup.

 ────────────────────────────────────────────────────────────────────────────────

 ### 12. Low-medium compatibility — Search/list output is line-delimited despite legal newline filenames

 Evidence

 - Find parses rg --files with newline transforms and split('\n'): tools.ts:331-352.
 - ls -1A is likewise split on newlines: tools.ts:373-379.

 Impact

 A legal filename containing a newline becomes multiple fake paths. Pi’s native readdir() does not have this problem.

 Recommendation

 Use NUL-delimited output where supported or JSON from a sandboxed Node filesystem call. The same change can implement the ls optimization in finding 2.

 Recommended implementation order

 1. Add balanced cleanupAfterCommand() handling.
 2. Collapse ls child metadata into one process.
 3. Replace domain-approval restart with updateConfig().
 4. Restore Bash semantics.
 5. Register full Pi tool definitions rather than AgentTool wrappers.
 6. Remove Base64/full-file read overhead.
 7. Throttle Research Scout updates.
 8. Add atomic locked configuration writes.
 9. Tighten peer-version compatibility and image/search edge cases.

 This was static analysis only; Ask mode prevented running benchmarks or validation commands.
