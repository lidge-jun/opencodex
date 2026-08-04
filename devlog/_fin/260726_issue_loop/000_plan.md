# 000 — 260726-issue-loop: Plan

## Objective

Land fixes for the open issues whose defect is present in the code of current
`dev`, and record why each remaining candidate is not a code fix. This unit is
scoped to issues only; the fourteen open pull requests are the subject of
`260726_pr_rework_v2` and are explicitly out of scope here.

Baseline: `dev` = `origin/dev` = `b4485706`.
Inventory taken 2026-07-26 with `gh issue list --state open` (21 open issues).
Gate baseline on that commit: `bun run typecheck` clean, `bun run test` 4566
pass / 0 fail, `cd gui && bun test` 247 pass / 0 fail, `lint:gui` and
`privacy:scan` green.

## Candidate triage

Every candidate below was checked against the current tree, not against the
issue text. Three classes emerged.

### A. Defect is present in current `dev` — this unit fixes it

| Issue | Surface | Evidence |
|-------|---------|----------|
| #477 | `src/codex/journal.ts` | The early return at line 32 is present; `markJournalInjectedState` still returns on line 51 when a hash exists. Both freeze the first transaction. |

### B. Real defect, but the obvious fix is already refused — needs a different shape

| Issue | Why the naive fix is wrong |
|-------|----------------------------|
| #457 | The `allowBaseUrlOverride` fix shipped once and was backed out twice (`165f1a83` → revert `b9b73f71` → cherry-pick `9b412d8e` → revert `a9b9048a`), then returned as PR #459 and was closed unmerged on 2026-07-26. `alibaba-token-plan` (Beijing Personal Edition) and `alibaba-token-plan-intl` (Singapore Team Edition) are deliberately separate providers with separate model lists, modality maps, context windows and dashboards; a URL override cannot carry those contracts, so the endpoint would work while the catalog still described the wrong product, and the provider's API key would become sendable to any saved destination. The closing comment names the correct shape: a config migration, not an override flag. Full history in `002`. |

### C. Not a code defect this unit can close

| Issue | Disposition |
|-------|-------------|
| #476 | Feature request (`ocx sync --restart-codex`): killing another process's app-server is a product/safety decision, not a bug fix. |
| #488 | Four UX paper cuts; the reporter offered to send a PR. Item 1 (config overwrite on shutdown) is the only one with a concrete failure mode, and it overlaps this unit's journal work conceptually but touches a different file (`src/config.ts`). |
| #462, #418, #92, #241, #401, #417 | Upstream-tracking or reproduction-blocked. |
| #415, #414, #386, #330, #294, #201, #178, #177, #95, #42 | Roadmap/enhancement, not defects. |

## Work-phase map

Ordering is dependency-driven (PHASE-SPLIT-01), not effort-bucketed.

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP0 | `000` (this doc), `001`, `002` | Inventory, triage, per-issue research, diff-level roadmap | — |
| WP1 | `010_wp1_journal_transaction_477.md` | Journal snapshot refresh (#477) | — |
| WP2 | `020_wp2_provider_id_rewrite.md` | `rewriteProviderReferences` — the reference inventory alone, nothing calls it | — |
| WP3 | `030_wp3_alibaba_region_migration_457.md` | The Alibaba projection, backup, and startup wiring | WP2 |

WP1 is independent of WP2/WP3: it owns the Codex-side `~/.codex/config.toml`
transaction while they own the proxy-side `~/.opencodex/config.json` migration,
and neither consumes the other's output. An early draft claimed WP1 gated the
migration; the audit correctly called that an invented dependency.

WP2 → WP3 is a real dependency: the migration calls the rewriter.

### Why the migration is two phases

Three audit rounds converged on WP1 but kept finding new defects in the
migration, and the pattern was informative: every one was in a *secondary*
mechanism — the backup, the collision policy for occupied destination keys, the
`liveModels`/`note` ownership rules. The core (detect the mismatch, move the row,
re-point the references) survived every round intact.

That is the signature of a phase carrying more than one decision. The rewriter
is a deterministic function over a single config object — it mutates in place
rather than returning a copy, so it is isolated but not pure — and it is both
independently verifiable and independently useful, so the seam is real rather
than a scheduling convenience.

Research and implementation are separate documents (LEXICO-SPLIT-01): `001` and
`002` carry the investigation and the rejected alternatives; `010`, `020` and
`030` carry only the diffs and their tests.

## Loop-spec

- **Loop archetype:** verifier-defined (spec-satisfaction repair). Each
  work-phase has a concrete regression test that fails before the change and
  passes after; there is no metric to maximize.
- **Trigger:** open issues whose defect reproduces against `b4485706`.
- **Goal:** a user who crashes the proxy does not lose Codex settings (#477),
  and a user whose provider id was migrated across regions is not left with a
  silent 401 (#457).
- **Non-goals:** merging, closing, or retargeting any contributor PR; approving
  fork CI workflows; version bumps; `main`/`preview` promotion; npm publish.
- **Verifier:** `bun run typecheck`, `bun run test`, `cd gui && bun test`,
  `bun run lint:gui`, `bun run privacy:scan`, plus the per-phase regression test
  demonstrated failing on the pre-change tree.
- **Stop condition:** every implementation work-phase's criteria (WP1, WP2, WP3)
  met with captured evidence, or a terminal outcome recorded with evidence.
- **Memory artifact:** this unit plus `.codexclaw/goalplans/opencodex-pr-dev-hotl-pabcd-wp0-docs-only-devlog/`.
- **Escalation:** a fix that would require deciding product identity (which
  provider a migrated config belongs to) escalates to the user rather than
  guessing.
- **Write scope:** `src/codex/journal.ts`, `src/codex/inject.ts`,
  `src/cli/index.ts`, `src/providers/**`, `src/config.ts`, `tests/**`,
  `docs-site/**` when user-visible, and this unit.
- **Explicitly not writable:** `devlog/_plan/260726_announcements/**` and
  `devlog/_plan/.DS_Store` — a concurrent session owns those.
- **Resource bounds:** local gates plus authenticated `gh`/`git`. Remote
  mutations authorized: push `dev`. No PR or issue state changes.

## Accept criteria

- `c-roadmap` — this document reflects state verified against the tree, and
  every disposition cites the concrete surface or the governing decision.
- `c-difflevel` — `010`, `020` and `030` are copy-paste-executable diff-level
  designs, imports and fixtures included, written before their implementation
  cycles start.
- `c-477-repro` / `c-457-repro` — each fix has a regression test proven to fail
  on the pre-change tree.
- `c-rewrite-inventory` — every provider-id reference shape is covered, with
  occupied destination keys reported rather than overwritten.
- `c-gates-wp1` / `c-gates-wp2` / `c-gates-wp3` — full gates green with zero new
  failures after each phase.

## Audit record

The plan was audited by an independent reviewer across three rounds before any
implementation started.

### Round 1 — `VERDICT: FAIL` (7 High, 2 Medium)

| Blocker | Disposition |
|---------|-------------|
| `currentStateIsNative` only gated replacement, not creation — an injected config with no journal was still captured | Folded: the classification now governs creation too, with test 3 in `010` |
| PID-based transaction ownership is wrong across `ocx sync` / `ocx ensure` | Rebutted and removed: `markJournalInjectedState` is left unchanged, because a refreshed journal carries no hash to protect. Test 4 in `010` guards the rejection |
| TOCTOU between classification and snapshot | Folded: the caller passes the exact bytes it classified, and the redundant `cli/index.ts:201` snapshot is deleted |
| WP2 missed most provider references; a stale combo target invalidates the whole config | Folded: `provider-id-rewrite.ts` mirrors the `openai-tiers` inventory plus combos, custom models and desktop-profile routes |
| `providerContextCaps` is keyed by provider id, not by route | Folded: key move, asserted through `providerContextCap()` rather than by shape |
| Moving the row wholesale carries the Beijing catalog onto the intl id | Folded: the destination is seeded from the intl registry entry, with only user-owned fields overlaid |
| No pre-migration backup | Folded: `backupConfigBeforeAlibabaRegionMigration`, with backup-before-save asserted |
| Placeholder tests, mixed research/implementation docs, invented WP1→WP2 dependency | Folded: research split into `001`/`002`, tests written out, dependency corrected above |

### Round 2 — `VERDICT: FAIL` (3 High, 3 Medium)

The rebuttals from round 1 were upheld (the PID guard rejection and the deletion
of `cli/index.ts:201` were both confirmed sound). Six new blockers, all folded:

| Blocker | Disposition |
|---------|-------------|
| The conservative `isNative` default broke three existing tests that call `writeJournal()` with no arguments | Folded: the verdict is now *derived* from the file when unclassified, so the old contract survives; only an explicitly-classified caller may replace a journal. Test 5 added |
| WP2 snippets did not compile: missing import, `entry?.baseUrl` type mismatch, no `validateCombo` export, `routeModel(...).baseUrl` does not exist | Folded: import added, fail-fast registry guard, `comboConfigError`, `routeModel(...).provider.baseUrl` |
| `USER_OWNED_FIELDS` dropped user-editable `defaultModel`/`note` and did not seed the full intl row | Folded: `buildIntlRow` now starts from `providerConfigSeed(entry)`, validates a carried `defaultModel` against the intl catalog, keeps a user-authored `note`, and drops `authMode` in favour of the seed |
| Generic `providers[*].selectedModels` rewriting could mangle an unrelated provider's native allowlist | Folded: removed from the rewriter; the source allowlist is filtered inside `buildIntlRow` where the destination catalog is known |
| Test 4 was false confidence — process 2 refreshed the journal before marking it, so a PID guard would have passed | Folded: it now marks the foreign journal without refreshing, and asserts `pid` stays foreign |
| `rewriteProviderReferences` was a signature plus prose; several tests were placeholders; the backup helper had no diff | Folded: full rewriter body, all test bodies, and `createImmutableConfigBackup` extracted from the OpenAI-specific backup |

One correction the reviewer did not catch was found while folding: `desktopProfile`
is not a flat record — `assignments` is *keyed* by route while `defaults` holds
routes as values (`src/types.ts:437-445`), so both halves need rewriting.

### Round 3 — `VERDICT: FAIL` (5 High, 1 Medium)

Round 3 confirmed WP1's four-state flow, the import cycle, the PID rebuttal, the
completed inventory and the corrected count of 14. Its remaining blockers were
all about mechanisms bolted on under audit pressure, which is why this round
ended in a scope correction rather than another patch:

| Blocker | Disposition |
|---------|-------------|
| `writeJournal` still trusted a caller that claimed "native" about injected bytes | Folded: ownership is now checked unconditionally from the content being journaled; `currentStateIsNative` degrades to a replace-permission only |
| The marker extraction was not the transitive closure — `tomlStringPattern` and `providerTableStart` were missing | Folded: the move list is now the full closure, with each symbol's consumers named |
| `liveModels` is user-editable but was dropped; the `note` rationale was factually wrong | Folded: `liveModels` carried, `note` seeded from the destination registry then overlaid only when user-authored |
| The rewriter's two key moves could overwrite an occupied destination | Folded: `rewriteProviderReferences` returns `collisions[]` and touches nothing at those sites; WP3 aborts on a non-empty list |
| The backup extraction was still not diff-level and its tests were mocked away | **Dropped, not patched.** Two rounds of rejection is evidence the refactor is its own unit. WP3 relies on the adjacent OpenAI tier backup and states the gap |
| A fixture was passed uncalled; WP1 Test 4 did not distinguish the guard it claimed to trap | Folded: `migratableConfig()`, and Test 4 reframed as documenting why no journal a marker sees ever carries a hash |

The pattern across three rounds — WP1 converging while WP2 kept producing new
defects in *secondary* mechanisms — is what motivated splitting WP2 into the
rewriter and the migration above.

### Round 4 — `VERDICT: FAIL` (4 High, 1 Medium)

Round 4 confirmed WP1 complete: the unconditional ownership check makes the
journal invariant caller-independent, the eight-symbol marker move is the full
closure, and the three existing direct-call tests still pass. The rewriter's
collision accounting and the count of 14 were confirmed correct.

| Blocker | Disposition |
|---------|-------------|
| The rewriter's list assignments added `undefined` own properties, breaking its own no-op test | Folded: `routeListAt` only writes when the field was already an array; the test now also compares `Object.keys` |
| `seeded as Record<string, unknown>` is TS2352 under strict | Folded: the cast goes through `unknown` |
| WP3's startup module and tests had no imports and no fixture definitions | Folded: imports and `migratableConfig()`/`collidingConfig()` written out in both test files |
| **Relying on the OpenAI tier backup leaves the common tier-v2 path with no snapshot at all** | **Accepted as a blocker and reversed.** The previous round's decision to drop the backup was wrong — `openai-tier-startup.ts:22` returns before backing up whenever its projection is unchanged, which is the normal state. WP3 now ships `src/providers/alibaba-region-backup.ts`: a small `COPYFILE_EXCL` snapshot, not an extraction of the OpenAI mechanism |
| `000_plan.md` carried two contradictory phase maps and stale criteria | Folded: single map, stop condition and criteria cover WP1–WP3 |

Residual risks accepted and recorded rather than fixed: the rewriter mutates as
it goes and is not transactional, so a caller receiving a non-empty `collisions`
must discard the config — documented on the API, and WP3 satisfies it by working
on a clone.

### Round 5 — `VERDICT: FAIL` (2 High)

Round 5 narrowed to two real defects; everything else — imports, fixtures, the
`unknown` cast, backup-before-save ordering, the collision abort, and the single
consistent phase map — was confirmed correct.

| Blocker | Disposition |
|---------|-------------|
| `routeListAt` with `K extends keyof OcxConfig` does not compile: the key type also admits `customModels`/`apiKeys`/`codexAccounts`, so `map` infers a union array that is not assignable back | Folded: an explicit `RoutedListKey` union of the three routed-string lists, verified against the compiler |
| `COPYFILE_EXCL` makes creation exclusive but not publication atomic — a crash mid-copy leaves a truncated file that the next run accepts as a valid rollback point | Folded: copy to a temp, verify the bytes, publish with `link` (EEXIST rather than replace), and verify an existing snapshot against the still-unmigrated source, throwing `AlibabaBackupIntegrityError` on mismatch so `save` never runs |

Also folded, non-blocking: the rewriter was described as "pure" while its
contract says it mutates in place; it is now called deterministic and isolated.

### Round 6 — self-caught: the backup nearly bricked the proxy

While preparing round 6 I traced the throw path myself rather than waiting for
the verdict, and found that the integrity rule I had just added in response to
round 5 was worse than the problem it solved.

The rule was "an existing snapshot must equal the current config, else throw".
`runAlibabaRegionStartupMigration` does not catch, and `src/cli/index.ts:176`
retries only on `EADDRINUSE` and rethrows everything else — so that throw
propagates out of `startServer` and **the proxy refuses to boot**. Now consider
an entirely ordinary sequence: a run creates the snapshot and then aborts for an
unrelated reason (a collision, a crash after backup), the user later edits
`config.json` as they are perfectly entitled to, and from then on every single
start fails. A safety net that stops the product is not a safety net.

The equality check is gone. An existing snapshot is reused as-is — it is the
earliest one, which is exactly the one worth keeping — and integrity is carried
by *publication* instead: bytes are verified in a temp file and published with
`link`, so a published snapshot is complete by construction and a crash leaves
only an orphan temp. The remaining throws are genuine IO failures, which already
prevent a healthy start for other reasons.

Recorded here because the lesson generalizes: three consecutive rounds of audit
pressure pushed toward ever-stricter guards, and strictness in a startup path is
not free.
