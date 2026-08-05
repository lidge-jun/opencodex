# wp2 execution notes (P-phase stale check, 2026-08-02)

## Stale check results

- `atomicWriteFile` at `src/config.ts:107`, `atomicWriteFileAsync` at :187 — both confirmed in the pre-fix form (temp `${path}.ocx.${pid}.${seq}.tmp` beside the LITERAL path; `io.rename(tmp, path)`).
- PR #869 diff (`/tmp/wt4-pr869.diff`, 336 lines) applies CLEAN to dev@478354ee8 + wp1 commit (`git apply --check` passes).
- PR #869 state: OPEN, MERGEABLE, quality gates green, no maintainer blocker comments.
- The diff's `src/responses/state.ts` hunk expects `enforceAppOwnedMemoryBudget` (77243d932) — present on current dev.

## PR #869 implementation shape (what will be applied)

1. `resolveWriteTarget(path)` (exported): `realpathSync(path)`, fallback to literal path when unresolvable (first write of a not-yet-created file).
2. `assertResolvedTargetAllowed(path, target)`: re-applies the test-only real-home guard (`assertNotRealHomeUnderTest`) to the RESOLVED target — a symlink escaping a temp fixture home into the protected home is refused even though the caller's dir-level check passed. Inert in production.
3. Both sync + async writers compute `tmp` beside the RESOLVED target and rename onto it.
4. `src/responses/state.ts` snapshot load sweeps stale temps in BOTH the literal and the resolved directory (a symlinked snapshot strands temps in the real dir).
5. Tests: `tests/config.test.ts` symlink suite (sync+async: link survives + target updated, no temps left, plain destination unaffected, first-write creation, dangling symlink replaced), `tests/responses-state.test.ts` (sweep in resolved dir), `tests/test-home-guard.test.ts` (escape-refused probe).

## Caller audit (criterion c5) — grep `atomicWriteFile` across `src/` @ dev 478354ee8

| Caller | Writes into | Symlink exposure |
|---|---|---|
| `src/config.ts` (owner; config.json :1627, pid :2070, runtime port :2098) | OPENCODEX_HOME | direct — config dir is dotfiles-managed in the reported case |
| `src/oauth/store.ts` | OPENCODEX_HOME credential store | high-value target; fix protects token files behind symlinked dirs |
| `src/codex/inject.ts`, `journal.ts`, `history-provider.ts`, `account-store.ts`, `quota.ts`, `refresh.ts`, `runtime.ts`, `features.ts` | `~/.codex/*` | the reported dotfiles case (`config.toml` symlink) |
| `src/claude/desktop-3p.ts` | Claude Desktop config | user-managed file, symlink plausible |
| `src/grok/inject.ts` | grok config | same shape |
| `src/responses/state.ts` | OPENCODEX_HOME snapshot | covered by the sweep-in-both-dirs hunk |
| `src/update/job.ts`, `notify.ts` | OPENCODEX_HOME update state | covered by shared helper |
| `src/codex/catalog/*` (aggregation, bundled, effort, metadata, parsing, provider-fetch, sync) | catalog caches | covered by shared helper |

No caller needs an individual change: the fix lives in the shared writer + the one stale-temp sweep that scans directories.

## Known design decisions to audit

- Dangling symlink: realpath fails → literal path → rename REPLACES the dangling link (PR test asserts this). Debate point: silently replacing a dotfiles link whose target dir is temporarily unmounted. PR chose "replace"; the alternative (refuse) breaks first-write-into-new-target-dir.
- TOCTOU: link swapped between realpath and rename lands the write at the old target. Accepted, documented in `010_implementation.md`; not claimed race-free.
- Windows: `realpathSync` resolves junctions/symlinks on win32 too; temp stays same-volume because it sits beside the resolved target.
- wt2 coordination: #840's memo-release touches `atomicWriteFileAsync` timeout-memo area; this diff does not overlap those lines (memo keyed by `path` argument, unchanged).
