# wp3: Contextual help recovery

Dependency: wp2 navigation and wp1 resolver. Delivery: third PR based on
codex/cli-ux-navigation, head codex/cli-ux-recovery.

## File map and intended diff

- NEW `src/cli/help-recovery.ts`: pure conservative typo matching over visible
  registry names/aliases or the resolver's declared children. Deterministic order,
  short bounded input/candidate work, at most three suggestions. Never execute a
  suggestion, and never infer supported runtime grammar from absent capabilities.
- MODIFY `src/cli/help.ts`: unavailable help uses a concise diagnostic and parent
  or full-reference pointer rather than dumping the entire banner.
- MODIFY `src/cli/root.ts`: detect unknown root command before shim auto-restore;
  use `command === "internal" || findCommand(command)` so the deliberately
  unregistered internal runner and registered commands keep existing semantics.
  Keep internal absent from public discovery and test its classification without
  executing an internal operation; do not import dispatch into pure help.
  Preserve head kind compatibility or add explicit unknown state only if all
  consumers/tests are updated. No lifecycle mutation for invalid root commands.
- MODIFY `src/cli/dispatch.ts`: existing unknown-command exit reuses the renderer:

```diff
- console.error(`Unknown command: ${command}`);
- printUsage();
+ printUnknownCommand(command);
  return 1;
```

- NEW `tests/cli/cli-help-recovery.test.ts` plus both layout registrations: root
  and nested typo, unrelated input, hidden-name exclusion, terminal control input,
  long input bound, deterministic suggestions, and no automatic command execution.
- MODIFY `tests/cli/cli-help.test.ts`: preserve the unknown-help regression but
  replace its obsolete stdout banner assertion with empty stdout, exit 1 and
  stderr diagnostic/navigation assertions.
- MODIFY `tests/cli/cli-head.test.ts`/`cli-dispatch.test.ts` only where established
  semantics require it; avoid adding bulk cases to already-large dispatch tests.
- MODIFY English CLI reference and runtime structure prose.

## Error contract and triggers

`help modles` and `modles` exit 1, suggest `models`, and print fewer than 10 lines.
Diagnostics and recovery guidance use stderr, leaving stdout empty on unresolved
help/unknown commands. This is an intentional human-error output change; existing
machine-readable successful/failed command payloads and command-specific argument
validation remain unchanged. Never echo terminal controls; bound diagnostics.

Distant typo `ocx help qzxv`: no suggestion, only full-reference navigation.
Nested typo `ocx help account lisst`: suggest `ocx help account list`, never an
unrelated root. Undeclared deeper path `ocx help service install`: say
"No detailed help available" and point to `ocx help service`, never claim the
valid runtime install operation is an unknown command. Unknown root with shim
fixture: no repair or writes. Known root retains existing preflight behavior.

Run new recovery tests plus prior layer focused coverage, typecheck,
test:changed, structure/skill surface/privacy checks and docs build. A fresh
independent reviewer checks source and terminal evidence before readiness.
