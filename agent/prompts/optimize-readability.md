---
description: Rank opportunities to make files easier to read
argument-hint: "<files...>"
---

Analyze these files and produce a ranked plan to improve their readability. Apply the `ponytail` skill's deletion-first, simplest-working-solution approach.

$ARGUMENTS

Read each file completely and inspect nearby definitions and call sites when needed to understand the code. Do not edit files.

Prefer code that can be followed top to bottom and left to right. Look for:

- Indirection that should be inlined
- Dead or unreachable code
- Redundant branches, helpers, types, comments, and abstractions
- Repeated logic that obscures the main flow
- Needlessly verbose or clever code that has a simpler, terse equivalent
- Naming, control flow, error handling, and other conventions that are inconsistent with nearby code

Do not recommend abstraction merely to remove small duplication. Preserve behavior, validation, error handling, security, and useful comments.

Rank recommendations by readability impact. For each item, include:

1. File and line range
2. The concrete change
3. Why it improves readability

Keep the plan specific and concise. Omit low-value style preferences. If no meaningful improvements exist, say so.
