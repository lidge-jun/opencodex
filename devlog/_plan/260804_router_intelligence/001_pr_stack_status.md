# 001 - PR stack status ledger

Continuously updated during the programme. Every branch records: base SHA,
head SHA, PR number/URL, verification result, and review state.

## Programme facts

- Stack base (dev): `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6` (`upstream/dev`)
- `origin/dev` (fork, stale ancestor): `be177ea501e5007f4a56d19d069ef5cd76ea24b9`
- Bun: `1.3.14`; package version: `2.10.0`
- Worktree: `D:\codex-worktrees\ocx-router-intelligence`
- Push remote: `origin` (Wibias/opencodex); PR target: `lidge-jun/opencodex:dev`
- Programme stack: #1003 (RI-01), #1004 (RI-02), and #1005 (RI-03) merged to
  `dev`; #1011 (RI-04) open.

## Related in-flight PRs (not superseded by this stack)

| PR | Branch | Note |
|---|---|---|
| #922 | `fix/914-account-neutral-network` | #914 alternative; consumed as health evidence input by RI-06 |
| #966 | `codex/260804-issue914-transport-attribution` | #914 alternative; consumed as health evidence input by RI-06 |
| #715 | `feat/priority-levels` | Pool selection order; out of scope |
| #988 | `codex/providers-copy-doctor` | GUI providers/combos; conflict-checked at RI-10 |
| #998 | `codex/260803-integration-switches` | Write substrate; rebase watch on request-log.ts |

No open PR found that implements the same vertical as any PR in this stack,
so no stale PR is closed by this programme. Both #914 drafts overlap each
other; closing one is a maintainer decision and neither is stale.

## Baseline

- Full-suite baseline on clean `upstream/dev` (worktree
  `D:\codex-worktrees\ocx-typecheck-base`, head `e44d234f0`): running in
  background; exact pass/fail counts appended here when done.
- `bun x tsc --noEmit` on clean `upstream/dev`: **PASSED** (0 errors, verified
  in the pristine base worktree).
- `bun run privacy:scan`: passed per-PR (see RI-01 below).

## Stack status

| RI | Branch | Base | Head SHA | PR | URL | Status |
|---|---|---|---|---|---|---|
| RI-01 | `feat/ri-01-route-decision-traces` | `e44d234f0` | `b5a8e7c4c` | #1003 | https://github.com/lidge-jun/opencodex/pull/1003 | MERGED |
| RI-02 | `feat/ri-02-request-history-index` | `dev` (post-#1003 merge) | `2a72aa4a9` | #1004 | https://github.com/lidge-jun/opencodex/pull/1004 | MERGED |
| RI-03 | `feat/ri-03-routing-analytics` | `dev` (post-#1004 merge) | `a594938c5` | #1005 | https://github.com/lidge-jun/opencodex/pull/1005 | MERGED |
| RI-04 | `feat/ri-04-policy-profile-core` | `dev` (post-#1005 merge) | `31c9f0b28` | #1011 | https://github.com/lidge-jun/opencodex/pull/1011 | MERGED |
| RI-05 | `feat/ri-05-capability-aware-routing` | `dev` (post-#1011 merge) | `088194a3a` | #1012 | https://github.com/lidge-jun/opencodex/pull/1012 | MERGED |
| RI-06 | `feat/ri-06-health-aware-routing` | `dev` (post-#1012 merge) | `af692bb7a` | #1013 | https://github.com/lidge-jun/opencodex/pull/1013 | MERGED |
| RI-07 | `feat/ri-07-quota-aware-routing` | `dev` (post-#1013 merge) | `1f07c00b8` | #1014 | https://github.com/lidge-jun/opencodex/pull/1014 | MERGED |
| RI-08 | `feat/ri-08-cost-aware-routing` | `dev` (post-#1014 merge) | `410db97e4` | #1015 | https://github.com/lidge-jun/opencodex/pull/1015 | MERGED |
| RI-09 | `feat/ri-09-route-explainability-api` | `dev` (post-#1015 merge) | `68d3aa083` | #1016 | https://github.com/lidge-jun/opencodex/pull/1016 | MERGED |
| RI-10 | `feat/ri-10-routing-intelligence-ui` | `dev` (post-#1016 merge; rebasing) | pending | #1018 | https://github.com/lidge-jun/opencodex/pull/1018 | OPEN |

## Per-PR acceptance log

### RI-01 - feat/ri-01-route-decision-traces

- Base SHA: `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6`
- Reviewed commits:
  - `b5a8e7c4c` (implementation; author self-review + CodeRabbit review)
  - `2e0522b2` (privacy-scan fix after CI `gates` failure)
  - `pending` (CodeRabbit findings round; recorded after commit)
- Findings (self-review): 3 test failures caught pre-push - (1) missing value
  import for `normalizeRouteDecisionTrace` in request-log hydration,
  (2) selected combo target marked ineligible because `ComboPick.attempted`
  includes the winner, (3) account-namespace fixture missing the canonical
  ChatGPT forward `baseUrl` (test-fixture bug, not product code).
- Fixes: import fixed; `comboRouteCandidates` now excludes the selected target
  from `already-attempted`; fixture uses `https://chatgpt.com/backend-api/codex`.
- Regression tests: all three cases are covered by the final
  `tests/route-decision-trace.test.ts` (14 tests, 75 assertions).
- Findings (CodeRabbit, verified against code): 12 comments - 9 accepted
  (locale/plan docs, requestedModel bound doc, ledger SHA, combo tieBreak +
  duplicate getCombo, `truncated.requirements` flag, byte-accurate budget,
  parse-once evidence, hydration guard drops invalid traces, 2 regression
  tests, credential-test assertion hardening); 2 design-judgment comments
  (persist trace on every row - kept: bounded ~200 B single-candidate traces,
  plan mandates one trace per decision; docstring coverage - docstrings
  added to trace helpers); the privacy-scan finding was already fixed in
  `2e0522b2`.
- Final commit: recorded after commit (round applies CodeRabbit + simplify
  fixes; new head pushes to #1003)
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/route-decision-trace.test.ts`: 14/14 pass
  - Focused regression suites: 253/253 pass across combos, codex-routing,
    usage-log, request-log, combo-management-api, codex-account-namespaces
  - `tests/server-combo-failover-e2e.test.ts`: 44/44 pass
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-02..RI-10

### RI-02 - feat/ri-02-request-history-index

- Base SHA: `34d21b1bc` (`dev` after #1003 merge; rebased from RI-01 head
  `b5a8e7c4c` when #1003 landed: `7efb6e842` -> `03b0eafa7`)
- Reviewed commit: same as final (author self-review before push)
- Findings (self-review): 4 defects caught pre-push -
  1. `destroyAndRecreate` never reassigned the fresh handle to module `db`
     (first-open rebuild crashed);
  2. bun:sqlite named-parameter objects silently failed to bind for
     `LIMIT $x` and INSERT statements (datatype mismatch / silent no-op) -
     query and insert paths switched to positional parameters;
  3. Windows file locking: an unfinalized prepared statement kept the DB
     locked after close (EBUSY in tests) - insert statement now finalizes;
     a partially-opened handle on a corrupt file is closed before recreate;
  4. duplicate-replay accounting counted ignored rows in `indexedRows` -
     now counts real `INSERT` changes.
- Fixes: all four above; tests cover every one.
- PR: #1004 (MERGED) https://github.com/lidge-jun/opencodex/pull/1004
- Final commit: recorded after review round (rebase + CodeRabbit/simplify
  fixes; new head pushes to #1004)
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/request-history-index.test.ts`: 16/16 pass
    (1574 assertions) covering the mandatory matrix: empty/missing/corrupt/
    old-schema/partial-line/replacement/truncation/duplicate-replay/cursor
    stability/invalid-cursor/page-bounds/rebuild-equivalence/filters/row-by-id
  - Focused regression suites: 269/269 pass across 8 files (incl. RI-01
    tests, request-log, usage-log, combos, combo-management-api,
    codex-routing, codex-account-namespaces)
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-03 - feat/ri-03-routing-analytics

- Base SHA: `2a72aa4a9b0870c629adf842da659a5c521c6bfa` (`dev` after #1004 squash-merge)
- Reviewed commit: `e732d02e` (pre–CodeRabbit review round)
- Findings (self-review): 3 fixed pre-push - (1) `requestHistoryDb` accessor
  missing from the indexer (analytics needs the handle after open);
  (2) SQL column names are snake_case - analytics SELECT now aliases to
  camelCase; (3) cost field is `estimate.cost.total` (CostBreakdown), not
  `costUsd`; plus the row-cap is injectable for truncation tests.
- Final commit: `5f464c730` (CodeRabbit: cooldown parse gate, API `limit` default 5k, devlog + tests);
  merged head on `dev`: `a594938c5`
- PR: #1005 (MERGED) https://github.com/lidge-jun/opencodex/pull/1005
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/routing-analytics.test.ts`: 10/10 pass:
    classification (success/failure/cancel/incomplete), percentiles +
    coverage, fallback rate, provider/model/account + profile breakdown,
    unknown-price honesty, filters, truncation flag, API payload,
    cooldown on failure+attempts, API validation (`invalid_from`/`invalid_to`/`invalid_range`)
  - Focused regression suites: 144/144 pass across 6 files
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-04 - feat/ri-04-policy-profile-core

- Base SHA: `a594938c5` (`dev` after #1005 merge; rebased from the RI-03 head
  when #1003/#1004/#1005 landed)
- Reviewed commits: `63924495e` (RI-04 core) + review round `d478b393`
  (request-evidence wiring), `8e1f1c3d` (provider-namespace alias check, dead
  export removal), `aa9212fa` (CLI cleanup), `27511bf7` (absent-flag
  semantics, cost-limit enforcement, deterministic id ordering, CodeRabbit
  round)
- Findings (self-review): 4 fixed pre-push - (1) `serviceTier` evidence type
  was `Unknownable` (number|boolean) but service tiers are strings - trace
  type narrowed to `string | "unknown"`; (2) alias validation missed the
  reserved `combo/` namespace prefix; (3) trace candidates did not carry
  `score` - added `score` to `TraceCandidateInput`/`buildCandidate`;
  (4) test expectation for weight normalization used wrong math (unspecified
  weights keep defaults; sum 4.35 not 4).
- Final commit: `27511bf7` (see Reviewed commits)
- PR: #1011 (OPEN, ready) https://github.com/lidge-jun/opencodex/pull/1011
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/routing-profile.test.ts`: 14/14 pass (validation,
    normalization, revision digest, collisions incl. provider namespace,
    config load, id/alias resolution, dry-run eligibility incl. request
    evidence and cost limit, unknown/tie-break, API list+dry-run,
    API error codes)
  - Focused regression suites: pass across route-decision-trace,
    routing-analytics, request-history-index, combos, codex-routing,
    internal-cli-dispatch
  - `bun run privacy:scan`: passed
  - `tests/config.test.ts`: 109/115 pass; the 6 symlink failures reproduce
    identically on the pristine base (Windows symlink EPERM, environmental)
- Remaining Low findings: none (B3/B5 residual: no-eligible trace names
  candidate 0 as `selected`; API evidence fields are permissively dropped)

### RI-05 - feat/ri-05-capability-aware-routing

- PR: #1012 (MERGED) https://github.com/lidge-jun/opencodex/pull/1012
- Merged on `dev` at `088194a3a` (2026-08-05). Includes the RI-05 execution
  wiring, request-evidence hardening, no-eligible trace persistence, and
  policy-namespace reservation.

### RI-06 - feat/ri-06-health-aware-routing

- Base SHA: `56f17f45c` (RI-05 head); PR #1013 https://github.com/lidge-jun/opencodex/pull/1013.
- Findings (self-review): 4 fixed pre-push - (1) route-time health evidence
  needed synchronous index access (`openRequestHistoryIndexSync`); (2)
  unknown-health "penalize" folds a deterministic 0.3 floor; (3) trace
  candidates carry capability/health/quota/cost evidence; (4) score
  assertions updated for the health component.
- Full-review round (verdict `changes-requested`, all items fixed):
  1. indexer: dev/ino identity (already on dev) + row validation + clean-tail
     `lastError`; appends are a tail, never a rebuild;
  2. router: live Codex pool cooldown/soft-avoid evidence for `openai`
     targets (`codexPoolHealthEvidence` + active account);
  3. health: combo/failover `attempts[]` expand into per-target samples;
  4. request evidence: nested message `content` arrays walked for images
     (already on dev via #1012);
  5. evaluator: request-side `contextWindow`/`structuredOutputRequired`/
     `encryptedCodexTask` enforced (already on dev via #1012);
  6. dry-run API: omitted `candidates` populate execution-equivalent
     evidence;
  7. alias validation rejects first-segment provider aliases;
  8. `policy/<id>` without a profile falls through to normal resolution;
  9. capability: adapter-level tool inference for tool-capable adapters.
- 8 bot threads fixed + resolved; `tsc --noEmit` 0 errors; routing suites
  green; `privacy:scan` passed.
- Sync: merged `dev` (post-#1012, `088194a3a`) into the branch so the head is
  mergeable and CI can run; base sync of the stack continues with RI-07.

### RI-07 - feat/ri-07-quota-aware-routing

- Base SHA: `909ce21d4ffe4dbcad9c9baa2efb1c94e1e7dcd6` (RI-06 head)
- Reviewed commit: same as final (author self-review before push)
- Findings (self-review): 2 fixed pre-push - (1) `minQuotaHeadroom` was
  missing from the schema REQUIRE_KEYS so normalization silently dropped it;
  (2) `minQuotaHeadroom` was missing from `OcxRoutingProfileRequirements`
  (types.ts) - typecheck caught it.
- Final commit: `480f1578` (review-thread fixes; earlier commits `b562fdb9`,
  `288dd8a9`, `e74a211a`, `7aebbd36`)
- PR: #1014
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/quota-scoring.test.ts`: 9/9 pass - codex-pool and
    anthropic evidence, unknown-stays-unknown, unknown-quota policy
    (exclude/penalize/allow), headroom preference, minQuotaHeadroom gating,
    account-selection boundary, plan-aware window selection
  - Focused regression suites: 203/203 pass across 9 files
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-07 review round (full-review #1014 + simplify)

- Base SHA: `909ce21d4` (RI-06 head) -> rebased onto the reviewed RI-06 head
  `a9c6f8e8` so the stack stays aligned; PR head `9dbdce2ab` before fixes.
- Simplify (approved): misindented `require.minContextWindow` check fixed in
  `profile.ts`; shared RI-06 simplify carried in by the rebase.
- Bot-thread + own findings fixed in this PR:
  1. evaluator: `minQuotaHeadroom` now gates only KNOWN headroom; unknown
     quota is governed by `unknownEvidence.quota` (labeled `unknown-quota`,
     never `unknown-capability`);
  2. router: quota evidence receives the active codex account id so runtime
     quota scoring reflects cached quota when a deterministic account exists;
  3. dry-run API: omitted `candidates` populate quota evidence alongside
     capability + health;
  4. shared RI-06 review-round fixes (indexer tail, nested image evidence,
     request-side requirements, alias namespace collision, policy fallthrough,
     adapter tool inference) land here via the rebase.
- Verification: `tsc --noEmit` 0 errors; focused suites green (252/252 across
  the routing set); `privacy:scan` passed.
- Base sync deferred: waiting for RI-05 (#1012) to merge before updating
  these branches from `dev`.

### RI-09 - feat/ri-09-route-explainability-api

- Base SHA: `410db97e4cd9e9b4f8aba60682d20946e211d6dd` (`dev` after #1015 merge)
- Reviewed commit: `d887c120282c8d381f92cd11c1eebe2373a27281`
- Findings (self-review / full-review): fixed on this head -
  (1) dry-run preserves `parseCandidateEvidence(...) === null` as
  `400 invalid_candidates`; (2) combo explanations report the physical last
  attempt; (3) absent providers leave `encryptedCodexTasks` unknown;
  (4) CLI USAGE documents `evaluate` and rejects option-like profile ids;
  (5) assembleCandidateEvidence typed as `OcxConfig` after the RI-08 health/
  quota/cost merge.
- Final commit: `d887c120282c8d381f92cd11c1eebe2373a27281`
- PR: #1016 https://github.com/lidge-jun/opencodex/pull/1016 (MERGED)
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/route-explainability.test.ts`: 10/10 pass -
    trace+attempts+outcome merge, 404 unknown ids, pre-trace rows, combo
    physical final attempt, dry-run auto-evidence, malformed candidates 400,
    absent-provider encryptedCodexTasks unknown, CLI logs explain encode/json,
    CLI logs explain missing-id, CLI route policy evaluate dry-run + id guard
  - Focused regression suites: cost/quota/routing-profile + explainability green
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-10 - feat/ri-10-routing-intelligence-ui

- Base SHA: `68d3aa0836648ae1d7b592fc5aa3b30146c0886d` (`dev` after #1016 merge)
- Reviewed commit: same as final (author self-review before push)
- Findings (self-review): 4 fixed pre-push -
  1. GUI lint: hardcoded "profiles" in an error literal (i18n rule) - now a
     key-less status code;
  2. GUI lint: setState-in-effect for the initial load - deferred via
     setTimeout(0);
  3. missing `.checkbox` CSS class - added to styles.css; dry-run/analytics
     tables reuse the existing `.tbl` grammar;
  4. dev-mode GUI session bootstrap cannot authenticate through the Vite
     proxy - the screenshot is captured same-origin against the production
     GUI served by the backend instead.
- Final commit: pending (recorded after commit)
- PR: #1018 https://github.com/lidge-jun/opencodex/pull/1018
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run lint:gui`: PASSED (0 errors)
  - `bun run build:gui`: PASSED (production build + prepare:package)
  - `bun run test` (12 routing suites): 258/258 pass
  - `bun run privacy:scan`: passed
  - docs-site `bun run build`: 216 pages built, PASSED
  - Locale parity: compile-checked TKey set (all six locales updated)
  - Screenshot: live same-origin capture of `#routing` (profiles + dry-run +
    analytics) against a temporary config; uploaded to the PR via comment
    attachment
- Environment note: the temporary screenshot backend briefly rewrote the
  Codex/Grok fence to port 10200; restored with `ocx ensure` to the live
  proxy (10100) and verified. Test processes and temp files cleaned up.
- Remaining Low findings: none
- Remaining Low findings: none

## Baseline note

The full-suite baseline on this Windows machine did not complete within the
available window (background run, >3h, no summary emitted; the suite is
~8k tests and this machine is heavily loaded). Focused suites, typecheck and
privacy:scan pass per PR; the upstream PR #966 verification report records
~7941 pass / 10 environmental failures on clean dev. A final full-suite
attempt is scheduled at stack end.
