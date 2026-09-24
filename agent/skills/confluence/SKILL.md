---
name: confluence
description: Read Confluence pages, spaces, and blog posts with host-staged ACLI commands. Use only when the user explicitly mentions Confluence. Do not load for Jira or generic Atlassian requests unless Confluence is also explicitly mentioned.
---

# Confluence

Use `acli confluence` for read-only Confluence work. Call one command at a time so configured host-command staging can place each command in the editor for user review.

## Read-only use

Inspect unfamiliar commands with `-h`; configure `-h` and `--help` as sandbox passthroughs for the staged `acli confluence` command. Prefer JSON output when extracting or summarizing data.

Useful commands include:

```bash
acli confluence page view --id PAGE_ID --body-format view --json
acli confluence space list --json
acli confluence space view --id SPACE_ID --json
acli confluence blog list --space-id SPACE_ID --json
acli confluence blog view --id BLOG_ID --json
```

Only use list and view operations. Do not run create, update, archive, restore, delete, or other mutating commands. If the user requests a write, explain that this integration is intentionally read-only.
