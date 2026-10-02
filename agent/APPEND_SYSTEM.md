# Extended directions for coding agents

## Code Style

- Write code like a book: the reader should be able to follow its behavior top to bottom and left to right.
- Prioritize readability over abstraction, extensibility, and unit-test convenience. Keep the main path linear and obvious. Prefer guard clauses, early returns, and simple conditionals to nested branches. Keep related logic together and use the least indentation that preserves clarity.
- Prefer inline logic over extracting small helper functions. Do not extract a function merely to shorten a block, enable unit testing, or fit an abstraction pattern. Extract only a meaningful reusable operation, domain concept, or required boundary.
- Do not shape production code around unit tests. Prefer integration or end-to-end tests that exercise meaningful behavior across real boundaries. Add unit tests only when they are the clearest, smallest way to protect important behavior. Follow explicit testing requirements and existing project conventions.
- Avoid speculative abstractions, unnecessary indirection, clever control flow, and boilerplate. Favor direct, boring code that is understandable by reading it sequentially.
- Keep changes focused. When touching nearby code, simplify needless nesting, helper functions, and scattered control flow when doing so improves clarity without broadening the task.

### Inline-First Rule

Inline implementation details at their point of use, even when that duplicates a few simple lines.

- Do not extract helpers merely to avoid duplication, shorten code, or enable unit testing.
- Do not export production internals for tests.
- Do not add unit tests unless explicitly requested.
- Prefer duplicated one-line expressions over indirection.
- Extract only a substantial domain operation reused in several places.
- Validate changes through existing checks and integration behavior.

### Comments and JSDoc

Always write substantive, multiline JSDoc comments above every function you add or modify. Explain why the function exists, how it fits into the surrounding flow, and any important assumptions, tradeoffs, side effects, or non-obvious behavior. Prefer complete sentences and enough context that a future reader can understand the intent without reconstructing it from the implementation or external discussion.

Add inline comments where they preserve reasoning that the code alone cannot communicate, especially around decisions, constraints, edge cases, and deliberate simplifications. Do not merely narrate obvious syntax, but err toward detailed explanation when context would otherwise be lost.

Comment verbosity is explicitly exempt from all brevity, minimalism, deletion, density, shortest-code, and shortest-diff instructions, including those supplied by Ponytail or other skills. Apply those instructions to executable code and abstractions, not to comments or JSDoc. Never shorten, remove, or omit useful comments merely to make code, a diff, or a response briefer. If an instruction conflicts with this section, preserve the verbose comments while keeping the implementation itself minimal.
