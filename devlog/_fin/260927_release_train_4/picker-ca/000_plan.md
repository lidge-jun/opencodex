# Release train 4: picker CA continuity and Codex drift heal

An applied Claude Desktop picker profile can retain an egress URL after CA rotation is refused. This unit keeps that URL serving blind CONNECT while the old public certificate awaits verified removal, then allows the existing picker enable flow to retry. It also narrows the Codex drift heal to the injected config surface so a stopped auto-refresh generation cannot finish a stale full catalog sync. The source and acceptance record is this unit; the external 2026-09-27 audit is a lead, not an authority.

## Loop contract

| Field | Decision |
| --- | --- |
| Archetype / trigger | Satisfy-spec repair for the release-train-4 R1–R3 blocker and B10 verification request. |
| Goal | Applied Desktop egress stays reachable without picker TLS arming until predecessor trust is gone; CA publication is serialized; pending removal survives process replacement; B10 drift heal respects generation and bounded write-lock waiting. |
| Non-goals | No `main`/`preview`, release, version, user keychain, real Desktop library, other lane checkout, provider, GUI, or unrelated client change. |
| Verifier | Isolated focused Bun tests exercise failed untrust, actual CONNECT through the applied URL, lock contention, distinct processes, journal retry, stopped generation, and drift healing; typecheck, `test:changed`, privacy, structure, docs build, exact-head PR CI, then dev CI. |
| Stop | All criteria have fresh evidence, required PR-head checks succeed, the authorized PR is merged into latest `dev`, and dev CI is checked. |
| Memory artifact | This numbered unit, PR Verification, and goalplan/receipt records. Detailed pre-fix security working notes remain in ignored `.tmp/`. |
| Terminal outcomes | DONE only after the stop condition; unresolved native/CI evidence is reported as a limitation, never inferred from Linux tests. |
| Escalation | A needed write outside this lane, actual keychain mutation, blocked security review, or an unmergeable required check requires coordinator direction. |
| Resource scope | Only this dedicated worktree, `gpt-6-sol` read-only reviewers, existing repository tools and GitHub PR/CI; no user-set token or time cap. |

## Baseline and disposition

Base is `origin/dev` `24b2f39b77` (fetched 2026-09-27); branch `codex/t4-picker-ca-release-blocker`. The original #6072 picker CA PR and #6074 drift-heal PR are closed and their carried implementations are already on `dev` through #6073/#6075. There is no open picker-CA PR or issue from the current targeted GitHub search. This unit **reimplements the defective edges** of those landed batches on current `dev`; it does not merge an open PR as-is, cherry-pick, or squash a foreign branch. Existing credit in the earlier carry stays in history; this corrective diff does not carry another author's unmerged work.

Baseline in an isolated `HOME`, `OPENCODEX_HOME`, and `TMPDIR`: the three existing focused files passed 40/40, `bun run typecheck` passed, `bun run privacy:scan` passed, and `bun run structure:check` passed after `bun install --frozen-lockfile`. The focused tests do not assert the applied egress URL after failed untrust; `tests/claude-integration/claude-picker-runtime.test.ts:500` tests only the main intercept port. `src/claude/intercept/picker-ca.ts:89` conflates lock outcome with a void callback. The B10 tick calls full sync at `src/codex/catalog-auto-refresh.ts:86` and checks its generation only after that await at `:143`.

## Design decisions

| ID | Decision | Reason and rejected alternative |
| --- | --- | --- |
| T4-PICKER-CA-R1 | Bind a blind-only CONNECT relay on the applied profile's **actual** `egressProxyUrl` port when predecessor cleanup cannot complete; keep the row and previous selection. | A profile pivot requires ownership-sensitive Desktop writes, can discard retry intent, and may not repair the currently running app's pinned URL. Blind relay preserves network access without picker TLS termination. A foreign port holder cannot be replaced safely; report bind failure and preserve the row. |
| T4-PICKER-CA-R2 | Serialize read/decide/journal/publish under the existing picker CA SQLite lock; return a tagged lock result and never publish on lock failure. | A void callback returns `undefined` on success today. Publication outside the lock permits competing writers. |
| T4-PICKER-CA-R3 | Journal one outgoing **public** PEM plus SHA-1/SHA-256 before changing `ca.pem`; clear a prior pending item before a fresh rotation and acknowledge only after verified untrust. | The previous public certificate is otherwise lost across process replacement. Refusing a second rotation while one item is pending keeps a single record sufficient. No signing key is serialized. |
| T4-B10 | Use the existing config injector directly for drifted root keys, with its synchronous commit guard and 1-second write-lock wait. | Full `syncModelsToCodex` gathers/commits a catalog from a tick snapshot and exposes no generation guard or deadline option. The 1-second contract covers lock waiting, not the entire provider fetch; a direct injector avoids that fetch for a config-only heal. |

## Architect consultation

Read-only architect handle `01a0e33c-036c-7dd2-a83f-dfcce911055c` proposed R1 blind relay, R2 tagged lock/no unlocked write, and R3 public pending journal. Main accepted each decision, chose to keep `ensurePickerCa`'s existing return type and throw on unsafe/deferred publication, and added the separate B10 direct-injection decision from the bounded B10 source audit. The same architect reflected on this executable five-document roadmap: its first response was **MISALIGNED** on cached foreign-owner refusal and non-default catalog path preservation. Main amended [010](010_ca_publication.md), [020](020_desktop_continuity.md), and [030](030_codex_drift_heal.md); the second reflection was **ALIGNED**, with both pending drains and acknowledgement required before picker construction. Independent plan audit follows this consultation.

Independent A audit first found the new documents invisible to its staged-diff reader; the five files were staged in the dedicated worktree. Its substantive round then found that a later controller enable could bypass startup cleanup and that the existing journal path getter mutates an invalid journal. The phase docs now close the former through default `ensurePickerCa` refusal while pending, and the latter through a bounded read-only journal lookup plus a regular/parsed catalog check. These are plan amendments pending the same architect's reflection and the reviewer's next audit.

Architect reflection on those amendments found a further crash boundary: a pending record may have been written while its PEM remains published and the owner is still live if the subsequent CA replacement fails. Main amended [010](010_ca_publication.md) and [020](020_desktop_continuity.md) so cleanup defers rather than untrusting that incumbent. The independent audit must recheck this reachable fault path before code begins.

The next reviewer pass found the planned multiple-pending test unreachable because publication refuses while an item is pending. Main simplified the data structure to one pending item and replaced that row with a sequential retry test; architect reflection and final audit follow.

The same architect confirmed **ALIGNED** for the single-record change. The independent reviewer checked the staged five-document roadmap again, found no remaining blockers, and ended with **VERDICT: PASS**; `git diff --cached --check` also passed. This closes the docs-first design decision. The next cycle begins with serialized CA publication and its process tests in [010](010_ca_publication.md); source files remain unedited at this checkpoint.

## Dependency order and review

The first PABCD work phase records this roadmap only. [010](010_ca_publication.md) establishes publication and journal contracts; [020](020_desktop_continuity.md) consumes them for Desktop continuity; [030](030_codex_drift_heal.md) repairs the independent B10 path; [040](040_integration.md) synchronizes docs/invariants, runs gates, and delivers one ordinary PR to `dev`. Each phase rechecks its prewritten diff plan against the current tree before editing. All implementation remains one release-blocker PR because the final acceptance depends on the combined picker recovery and B10 check; no native GitHub stack is requested.

## Verification and enforcement limits

The focused commands name their target test files directly. `bun run typecheck` reads `src/**/*.ts` and `tests/**/*.ts` via `tsconfig.json`. `bun run structure:check` reads `structure/`; `bun run privacy:scan` scans the tracked tree. `bun run test:changed` uses the `dev` merge base's parsed import graph and cannot discover source-as-data, subprocess, or journal artifacts, so the focused files remain explicit. Baseline output is summarized above; `test:changed`, docs build, skill-surface check, and CI have not yet run on the repair. The seven concurrent release lanes make a full local suite disproportionately costly; the PR will list exact focused commands/results and leave full coverage to CI.

The CA and generation guards are code-level controls, checked by isolated regression tests and required hosted CI (E3/E4). They do not prevent an arbitrary same-user process from altering its own files or guarantee an occupied egress port; native keychain denial remains simulated locally. There is no claimed unbypassable layer. A Mac workflow on an ordinary source-only PR is gated by `.github/workflows/ci.yml:680-687`; if skipped, an exact-head `macos-control` dispatch is the available explicit coverage path, and its actual job conclusion must be checked separately.
