# 030 — wp3: issue #6757, Aside profiles that read "off (stale)"

**Reader summary.** `ocx integration client status --client aside` can show every profile as `off (stale)`,
and `ocx integration client sync --client aside` then prints "No eligible Aside profiles to synchronize. Check
integration status and profile sync preferences." with no next step. Sync only refreshes profiles whose sync
preference is on, which is correct and stays. This phase makes sync print the recovery procedure (the status
command, then preview and enable with a `<N>` placeholder), makes status print the exact preview and enable
commands with the real ID for each profile that is off with a stale managed block, and warns at load time
when a malformed `asideProfileSync` block silently turns every profile off. Nothing is re-enabled
automatically.

## Cause investigation (origin/dev 730d898457)

- `off (stale)` is two independent values: preference (`enabled`) and block state. `src/cli/integrations.ts:255`.
- Preference: explicit override → `allProfiles` → legacy root-ownership match (`src/integrations/aside-profile-context.ts:181,210-214`).
- Stale: safe sibling edit, missing desired fragment, or changed desired fingerprint (`src/integrations/state.ts:430-470`). Stale
  never writes the preference.
- Paths that produce `enabled=false`: explicit disable (`aside-profile-context.ts:276-280`), Undo/restore of a
  snapshot that was not owned (`aside-profile-journal.ts:223`, `136-144`), **schema fallback of an invalid policy
  to `{ allProfiles: false }`** (`src/config/schema/config-schema.ts:239`; one non-boolean value is enough,
  `leaf-validators.ts:813-819`), loss of the legacy-derived default when no policy exists and the root ownership
  record no longer matches (`aside-profile-context.ts:167-181`), or a different/replaced `OPENCODEX_HOME`.
- No automatic stale/fingerprint/attestation/restart path writes `false` over an explicit `true`
  (`ocx sync` → `src/cli/dispatch.ts:455-483`; attestation failures throw, `src/cli/aside-profiles.ts:29-45`).
- Conclusion: the reporter's runtime evidence (persisted `asideProfileSync`, root ownership record) is needed to
  pick between schema fallback and lost legacy default. The fallback is silent today; this phase makes it loud.

## Decisions (architect proposal D1–D8, handle 01a12051; revised after A round 1)

A round 1 (auditor 01a12056) FAILED the first revision: the server projection called `listAsideProfileStates`,
whose `readIntegrationState` runs `retryPendingPrunesOnce` (`src/integrations/state.ts:581-583`) and, through
the guarded Aside store, can prune snapshots and clear maintenance markers
(`src/integrations/aside-profile-context.ts:117-120`). The empty sync path performs no writes today; adding that
lookup would add maintenance writes and widen a management response. Revision 2 drops the server change.

| ID | Disposition (revision 2) |
|---|---|
| D1 keep preference/state/cause separate; OFF authoritative | accepted |
| D2 projection on the empty sync response | **rejected** (A round 1 blocker 1: not effect-free; the status GET already reports the same rows) |
| D3 helper callback | **rejected** with D2; `src/cli/aside-profiles.ts` and the attested exchange are untouched |
| D4 one CLI owner for recovery text | accepted as `src/cli/aside-profile-recovery.ts` (render only; no wire parsing needed) |
| D5 human text with conditional enable wording; JSON unchanged | accepted: sync prints the generic recovery procedure with the exact status/preview/enable command forms; status (list and `--profile N`) prints per-profile commands with real IDs |
| D6 no follow-up GET or capability expansion | accepted (trivially: no new request at all) |
| D7 load-time warning for an invalid `asideProfileSync` | accepted (factual wording, value-free) |
| D8 verification matrix | accepted, reduced to the CLI and config surfaces below |

## Change map

| Path | Action | Change |
|---|---|---|
| `src/cli/aside-profile-recovery.ts` | NEW | `ASIDE_SYNC_EMPTY_LINES: readonly string[]` = "No eligible Aside profiles to synchronize. Sync refreshes only profiles whose sync preference is on." / "List profiles with: ocx integration client status --client aside" / "For a profile shown as off (stale), review: ocx integration client preview --client aside --operation apply --profile <N>" / "Then, if the preview permits the change and you accept it: ocx integration client enable --client aside --profile <N>". `asideProfileRecoveryLines(rows: unknown[]): string[]` selects rows with `enabled === false && state === "stale"` and a safe nonnegative integer `profileId` (not `-0`, deduplicated), and renders per profile the off (stale) line, the preview command, the conditional "Then, if the preview permits the change and you accept it:" line and the enable command. conflict/unsafe/absent/current rows and enabled rows get nothing. |
| `src/cli/integration-aside-sync.ts:59` | MODIFY | empty `results` → `[...ASIDE_SYNC_EMPTY_LINES]`. JSON stays `{ results }`; exit code stays 0. |
| `src/cli/integrations.ts:253-256` | MODIFY | Aside list output appends `asideProfileRecoveryLines(profiles)` after the rows. |
| `src/cli/integrations.ts:195` `singleClientStatusLines` | MODIFY | when the result is an Aside profile object (`clientId === "aside"` with numeric `profileId`), append `asideProfileRecoveryLines([result])`. JSON unchanged. |
| `src/config/load-degrade.ts` `warnDegradedTopLevelOptIns` | MODIFY | if raw `asideProfileSync` is present and `asideProfileSyncSchema.safeParse` fails, `console.warn` once: "⚠️  config.json asideProfileSync is invalid — Aside profile sync falls back to all profiles off; fix the block or inspect `ocx integration client status --client aside`". No value or key echoed. `config.ts` is not touched. |
| `tests/cli/cli-aside-sync.test.ts` | MODIFY | empty-set test asserts the four lines, `<N>` placeholders, no enable request, `--json` still `{ results: [] }`. |
| `tests/cli/cli-headless-parity.test.ts` (describe "Aside profile integration CLI", ~L1553-1601) | MODIFY | list status with rows [0 off/stale, 1 on/stale, 2 off/conflict, 3 off/current, 4 off/stale] → commands for 0 and 4 only, conditional wording present, no extra request; `--profile 4` off/stale → hint; `--json` output equals the response. |
| `tests/config/config-load-degrade.test.ts` | MODIFY | `asideProfileSync: { profiles: { "0": "secret-shaped-off" } }` → one warning containing "asideProfileSync is invalid", no "secret-shaped-off", loaded policy `{ allProfiles: false }`, bytes unchanged; valid and absent policy → no such warning. |
| `structure/cli-management.md:87` | MODIFY | one sentence: an empty sync prints the status/preview/enable recovery procedure; status names per-profile commands for off (stale) rows; neither enables anything. |
| `structure/clients/integrations.md:147` | REVIEWED, unchanged | its sentence "uses the established attested sync helper unchanged" stays true. |
| `structure/config.md` | MODIFY | one sentence where `load-degrade.ts` warnings are described (L123 area): an invalid `asideProfileSync` keeps the schema fallback `{ allProfiles: false }` and now warns once without echoing values. |
| `docs-site/src/content/docs/guides/integrations.md:524-532` | MODIFY | after "`{results:[]}` exits 0 and means no eligible profiles": one sentence on reading status and using preview then enable for an off (stale) profile; translated locales are left unchanged (they do not contradict). |

No new test files, so no layout registration. `src/cli/aside-profile-recovery.ts` lies in the already owned `src/cli`
area (`structure/manifest.json`).

## Verification

Commands (each names its target file directly):

- `bun test tests/cli/cli-aside-sync.test.ts`
- `bun test tests/cli/cli-headless-parity.test.ts -t "Aside"`
- `bun test tests/config/config-load-degrade.test.ts`
- `bun run typecheck` (covers `src/`), `bun run structure:check` (structure docs changed), `bun run privacy:scan`
- `bun test tests/ci-workflows/file-size-ratchet.test.ts` if present (file growth in `src/cli/integrations.ts`, `load-degrade.ts`)

Activation scenarios: (a) empty sync → four guidance lines, no enable/preview request issued, JSON unchanged; (b) status
list mixed rows → hints only for off+stale, conflict/unsafe/current/enabled none; (c) `--profile N` off+stale → hint;
(d) malformed profileId values (-1, -0, 1.5, duplicate) → skipped; (e) invalid `asideProfileSync` → one value-free
warning, fallback policy unchanged, file bytes unchanged; valid/absent → none.

Reviews: independent gpt-6.1-sol correctness review, plus a security pass on the boundary question (no management
response, auth or transport change; the warning echoes no config value), then exact-head hosted CI.

## Bypass record (PLAN-BYPASS-NAMED-01)

No enforcement is added; the change is guidance and a warning. Residual: sync cannot name real profile IDs without a
read that may perform maintenance, so it names the status command instead.

## Architect reflection (handle 01a12051)

Revision 1: D4/D5/D7/D8 gaps folded, re-check ALIGNED. Revision 2 (after A round 1) removes D2/D3; reflection
re-requested below.

Revision 2 reflection: D1/D4/D5/D6/D7/D8 ALIGNED; reader-summary gap (placeholders in sync vs real IDs in status)
folded. D2/D3 superseded; the architect confirmed its earlier effect-free claim was wrong.

## Cycle revision (wp3 P, origin/dev 37e9294125)

Revalidated: none of the wp3 files changed on dev since `730d898457`. `structure/config.md` is at exactly 600 lines,
so its sentence joins the existing `load-degrade.ts` paragraph (line 123) instead of adding a line.
`structure/cli-management.md` (115 lines) takes its sentence in the line-87 paragraph. Branch: `codex/n5-6757-aside-recovery`
from origin/dev with the plan-unit commits cherry-picked first (the unit lands with this PR); D closes on that branch
before any record commit. Merge and issue closure move to wp4 (`040_closeout.md`).
wp3 ends after pushing the branch, opening a template-complete dev PR with `Closes #6757` (closed manually after the
merge, because GitHub does not auto-close from dev), and recording receipt + review verdicts against that head.
