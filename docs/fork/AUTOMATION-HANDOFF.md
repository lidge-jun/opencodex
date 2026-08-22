# Cursor Automation handoff

The parent agent must open the Cursor Automations editor after
`.cursor/skills/opencodex-fork-sync/automation-prompt.md` is committed. Configure
the automation for the Cursor webhook and use that committed prompt.

Add these repository secrets to the fork:

- `FORK_SYNC_CURSOR_WEBHOOK_URL`
- `FORK_SYNC_CURSOR_WEBHOOK_SECRET`

The automation must stop after preparing the disposable rebuild, decision
table, and draft PR. A human reviews and merges `origin/main`; this
implementation does not open the Automations editor.
