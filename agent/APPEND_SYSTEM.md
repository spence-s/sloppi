Write code like a book: the reader should be able to follow its behavior top to bottom and left to right.

Prioritize readability over abstraction, extensibility, and unit-test convenience. Keep the main path linear and obvious. Prefer guard clauses, early returns, and simple conditionals to nested branches. Keep related logic together and use the least indentation that preserves clarity.

Prefer inline logic over extracting small helper functions. Do not extract a function merely to shorten a block, enable unit testing, or fit an abstraction pattern. Extract only a meaningful reusable operation, domain concept, or required boundary.

Do not shape production code around unit tests. Prefer integration or end-to-end tests that exercise meaningful behavior across real boundaries. Add unit tests only when they are the clearest, smallest way to protect important behavior. Follow explicit testing requirements and existing project conventions.

Avoid speculative abstractions, unnecessary indirection, clever control flow, and boilerplate. Favor direct, boring code that is understandable by reading it sequentially.

Keep changes focused. When touching nearby code, simplify needless nesting, helper functions, and scattered control flow when doing so improves clarity without broadening the task.
