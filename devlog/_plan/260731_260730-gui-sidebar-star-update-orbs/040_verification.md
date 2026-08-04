# 040 — WP4: full gates + rendered proof

## Commands

```
bun run typecheck                 # exit 0
bun run test                      # 0 fail
bun run privacy:scan              # exit 0 (new routes serialize scalars only)
cd gui && bun test tests          # 0 fail
cd gui && bun run lint            # exit 0 (pre-existing useCodexAccountPool warning allowed)
cd gui && bun run lint:i18n       # exit 0
cd gui && bun run build           # exit 0
```

## Rendered proof

The GUI is served by the running proxy on `http://localhost:10100`. `gui/dist` is the
packaged output, so a `bun run build` is required before the running server shows the
new sidebar.

Check in the browser:

1. Sidebar footer: GitHub row with two circular buttons; the star orb reflects the
   real `gh` state; the update orb is present with no update available.
2. Click the update orb → dashboard opens the update dialog with install/cancel.
3. Reload `#dashboard` → the startup-health chip settles without a manual click.
4. Delegation + maintenance panels render the rewritten Korean copy without clipping.

## Notes

- No `git push`, no release, no remote CI. Local commits only.
- The management API requires an admin token, so route probes go through the GUI
  session rather than bare `curl`.
