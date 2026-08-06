# Extended directions for coding agents

## Environment

Available CLI tools: `git`, `rg`, `fd`, `fzf`, `jq`, `yq`, `bat`, `eza`, `tree`,
`curl`, `wget`, `tmux`, `shellcheck`, `sqlite3`, `file`, `lsof`, `ps`, `pkill`,
`nc`, and `dig`.

Prefer `rg` for text search, `fd` for file discovery, `jq`/`yq` for structured
data, and project scripts for validation.

Write code like a book: the reader should be able to follow its behavior top to bottom and left to right.

Prioritize readability over abstraction, extensibility, and unit-test convenience. Keep the main path linear and obvious. Prefer guard clauses, early returns, and simple conditionals to nested branches. Keep related logic together and use the least indentation that preserves clarity.

Prefer inline logic over extracting small helper functions. Do not extract a function merely to shorten a block, enable unit testing, or fit an abstraction pattern. Extract only a meaningful reusable operation, domain concept, or required boundary.

Do not shape production code around unit tests. Prefer integration or end-to-end tests that exercise meaningful behavior across real boundaries. Add unit tests only when they are the clearest, smallest way to protect important behavior. Follow explicit testing requirements and existing project conventions.

Avoid speculative abstractions, unnecessary indirection, clever control flow, and boilerplate. Favor direct, boring code that is understandable by reading it sequentially.

Keep changes focused. When touching nearby code, simplify needless nesting, helper functions, and scattered control flow when doing so improves clarity without broadening the task.

Write code like a book: the reader should be able to follow its behavior top to bottom and left to right.

## Inline-First Rule

Inline implementation details at their point of use, even when that duplicates a few simple lines.

- Do not extract helpers merely to avoid duplication, shorten code, or enable unit testing.
- Do not export production internals for tests.
- Do not add unit tests unless explicitly requested.
- Prefer duplicated one-line expressions over indirection.
- Extract only a substantial domain operation reused in several places.
- Validate changes through existing checks and integration behavior.
