# Verification

- Run the new Cursor Fast usage test and the existing usage cost test.
- Run `bun run typecheck`.
- Run `bun run structure:check` after staging the plan files.
- Run `bun run privacy:scan` because usage and pricing metadata are changed.
- Run a gpt-6-sol read-only adversarial review of the final diff.
- Push `codex/260924-cursor-fast-pricing` and open one PR to `dev`; the coordinator merges it.
