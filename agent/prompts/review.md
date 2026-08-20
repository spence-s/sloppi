---
description: Review the current changes for correctness and regressions
argument-hint: "[focus or instructions]"
---

Review the current repository changes. Read the full affected code paths and relevant tests, not only the diff.

Focus on concrete bugs, regressions, security issues, data-loss risks, and missing tests. Do not report style preferences or speculative concerns.

For each finding, include:

- Severity
- File and line
- Why it is a problem
- The smallest practical fix

List findings from highest to lowest severity. If there are no findings, say so and mention any remaining validation gaps.

Additional instructions: ${ARGUMENTS:-none}
