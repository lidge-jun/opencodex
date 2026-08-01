# 080 — Preserve the thread limit across v1/v2 switching

## Loop spec

- **Archetype**: spec satisfaction
- **Trigger**: selecting v1 or v2 in the GUI/API
- **Goal**: keep the configured maximum thread count while moving it to the
  Codex key valid for the selected native multi-agent version
- **Non-goals**: changing `base` semantics, inventing a second user-visible
  concurrency setting, or rewriting unrelated TOML
- **Verifier**: focused Bun config/API tests, repository typecheck, GUI build,
  and a local dashboard switch smoke test
- **Stop condition**: both directions preserve the numeric value, no conflicting
  keys remain, and a failed feature toggle restores the original config byte-for-byte
- **Memory artifact**: this record
- **Expected outcome**: DONE or BLOCKED on an unhandled TOML form
- **Escalation**: any Codex-supported feature TOML form cannot be transformed
  without losing neighboring settings/comments

## Plan

1. Extend `src/codex/features.ts` with the existing owner's missing operations:
   read/write/remove `agents.max_threads`, read/write the inline/boolean v2
   feature forms, and a rollback-safe feature-toggle wrapper.
2. Update `src/server/management-api.ts` so `multiAgentMode: "v2"` implies the
   native flag is enabled and `"v1"` implies it is disabled. `"default"`
   preserves the current native flag. Explicit contradictory `enabled` + mode
   requests are rejected.
3. Reuse the same preserving toggle from `src/cli/v2.ts` for `on`/`off` and
   `mode v1|v2`, keeping GUI and CLI behavior aligned.
4. Add focused regression coverage in `tests/codex-v2-gate.test.ts` and update
   the management/CLI reference docs.

## Audit amendments

### Supported TOML and canonical writes

- Read the feature from all currently supported forms: the
  `[features.multi_agent_v2]` table, `[features]` boolean, and `[features]`
  inline table. Read the v2 limit from the table and inline-table forms.
- Read legacy concurrency from `[agents] max_threads`.
- Reject duplicate/conflicting feature definitions and unsupported dotted-key
  equivalents before mutation; never guess which duplicate wins.
- Canonical staged v2 output is an inline table inside `[features]` when the
  Codex CLI emitted a boolean, or the existing dedicated table when it remains.
  Preserve neighboring keys, comments, indentation, and dominant EOL style.
- When no feature definition exists, staging creates a dedicated
  `[features.multi_agent_v2]` table with `enabled = false`; it adds the resolved
  limit only when non-null before invoking the enable command.

### Transaction and precedence

1. Snapshot the exact config bytes and preflight every relevant definition.
2. Resolve the logical limit from the currently active storage first: legacy
   when v2 is off, v2 storage when it is on; fall back to the other storage.
   An explicit PUT thread value overrides both. This intentionally differs from
   target-storage precedence because the user's requirement is to carry the
   value visible in the mode being left, not resurrect a stale target value.
   `null` is valid and means Codex's version-specific default remains in force.
3. Enable: when a value exists, stage disabled v2 storage with it; always remove the
   legacy key atomically; invoke `codex features enable`; restore the v2 value
   if the CLI canonicalizes away nested config; verify enabled + value present +
   no legacy conflict. With `null`, create no limit key and verify both are absent.
4. Disable: invoke `codex features disable`; verify disabled; remove any retained
   v2 limit and, only when non-null, atomically write the resolved value to
   `[agents] max_threads`. With `null`, remove both limit keys. Verify the chosen
   legacy value is present, or both keys are absent for `null`.
5. Same-state requests still reconcile storage and duplicates without invoking
   the CLI.
6. A throw, ineffective exit-0 command, write failure, or failed postcondition
   restores the snapshot byte-for-byte.

### API truth table

| Request | Effective native flag | Result |
|---|---:|---|
| `mode:v2` | true | preserving transition, then save mode |
| `mode:v1` | false | preserving transition, then save mode |
| `mode:default` | unchanged | save mode only |
| `enabled` only | requested value | preserve current catalog mode |
| `mode:default, enabled:<bool>` | explicit value | transition flag; clear only the catalog override |
| `mode:v2, enabled:false` | — | 400 before writes |
| `mode:v1, enabled:true` | — | 400 before writes |
| consistent mode + enabled | requested value | one transition only |

GET returns the active logical limit (active storage, then fallback). PUT applies
`maxConcurrentThreadsPerSession` to the effective target storage after resolving
mode/flag. The field name remains for API compatibility, but its documented
semantics become version-neutral.

## Activation scenarios

- Legacy → v2: `[agents] max_threads = 100` becomes
  `features.multi_agent_v2.max_concurrent_threads_per_session = 100`; the
  legacy key is absent and neighboring `[agents]` keys remain.
- v2 → legacy: v2 max `100` becomes `[agents] max_threads = 100` after the
  feature is disabled.
- Same-state repair: an already-enabled but conflicting config prefers the v2
  value; an already-disabled duplicate prefers the legacy value. Equal and
  unequal duplicates collapse to the active storage.
- Failure rollback: a throwing/ineffective Codex feature command restores the
  exact pre-transition TOML bytes.
- Default (`base` UI) mode: only the catalog override changes; native feature state and thread
  storage are untouched.

## Focused proof matrix

- Table, boolean, and inline feature fixtures; comments and CRLF preserved.
- Off→on and on→off with unset, source-only, target-only, equal duplicates, and
  unequal duplicates.
- Handler GET: active and fallback logical limits with v2 both on and off.
- Handler PUT: mode-only both ways, consistent combined request, contradictory
  request rejected before writes, thread value applied separately to effective
  v1 and v2 targets, and mode-only default is a no-op for native state.
- CLI: `on/off` and `mode v1/v2` use the same transaction.
- Command throw, command exit-0 without changing state, failed postcondition,
  and exact-byte rollback.

## Done evidence

- `bun test ./tests/`: 2094 pass, 0 fail across 201 files.
- `bun x tsc --noEmit`: exit 0.
- `cd gui && bun run build`: production build exit 0.
- Real bundled Codex CLI against a temporary `CODEX_HOME`: `100 # tuned`
  migrated v1 → v2 → v1 with the value and comment preserved, no conflicting
  key in either destination state.
- Independent final implementation review: `VERDICT: PASS`.
