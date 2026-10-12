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

## P revalidation after wp2 (CLI-UX-03)

Previous D:26line navigation/family/provider help passed affected checks and fresh
review; inherited local full-suite caveat remains in011. Current base6f92cc1c98.

- MODIFY help-catalog.ts: it owns a pure recovery-candidate projection using its
  existing canonicalization/declared descendants. Root names and aliases are
  deduplicated by canonical help destination. Nested candidates are immediate
  documented child tokens; include the curated models/context topic separately.
  Suggestions contain complete metadata-derived destinations, never trailing argv.
  Bound the existing parent-prefix search by the maximum declared/curated depth,
  not arbitrary user path length; long explicit paths still remain unavailable.
- Matching policy: ASCII command-shaped tokens of3..64characters only; case-fold
  for comparison; bounded edit distance with adjacent transposition. Maxdistance1
  below6characters,2otherwise; order bydistance thenname; atmost3canonical targets.
  Reject oversized/control-containing tokens from matching; do not truncate them
  into apparent valid commands. Recovery paths deeper than8tokens get no matches.
- Diagnostic policy: root echoes only a bounded command-shaped first token after
  the existing pure `redactSecretString` confirms it contains no recognizable
  secret; otherwise generic Unknown command. Never echo laterargv. Nested errors
  keep generic unavailable-detail text plus metadata-derived parent/suggestions.
  Reuse src/lib/redact.ts; do not import stateful runtime-api solely for formatting.
- Keep successful appended-help parent fallback BEFORE recovery; preserve its
  write sink. Unavailable explicithelp always usesstderr/exit1, regardless of sink.
- Keep CliHead.kind and parseCliHead contract unchanged. runCli's command branch
  rejects unknown roots before shimpreflight, explicitly allowing `internal` and
  all findCommand roots/aliases/hiddenentries. No dispatchimport in pure modules.
  Direct dispatch's unknownroot exit independently calls the same formatter.
- MODIFY cli-help-paths.test.ts in addition to cli-help.test.ts: migrate rootbanner
  expectation to empty stdout/exit1/boundedstderr; preserve operand non-disclosure,
  context equivalence, parentfallback, provider sink andcapabilityJSON assertions.
- New recovery tests include root/nested/distanttypos, aliasdedup, curatedtopic,
  context-local candidates, long/control rootinput, secret-like trailingvalues,
  unknownroot shimfixture immutability and directdispatch. Admit valid aliases,
  hidden roots andinternal via isolated preflightspy without executing operations.

Transient candidate fields are created by catalog projection and consumed by the
recovery formatter; no persistence or API serialization. No global hasHelpFlag,
provider-specific diagnostics, Node updater or missing-home bootstrap changes.
