# D delivery roadmap

## Loop specification

- Archetype: spec-satisfaction repair; C3 integration train. Alias routing is C4 where it affects upstream credential destinations; keep any undisclosed security analysis in ignored scratch.
- Trigger: owner assigned D: #3669, #3673, #3628, #3625, #3646.
- Goal: integrate these five bounded outcomes into dev with contributor attribution, current-head remote CI and immediate disposition of superseded originals/resolved issues.
- Non-goals: A/B/C implementation, main/preview/release, dogfood service, personal accounts/credentials, unrelated thinking/cache behavior.
- Verifier: GitHub Cross-platform CI gates and platform jobs for every layer; GUI lint/build plus real isolated browser smoke for Logs; targeted CI failures repaired without local tests. NEVER run local test suites, focused tests, test:changed, or typecheck. This owner instruction overrides local-gate defaults in AGENTS/skills.
- Stop: all five landed SHAs reachable from freshly fetched origin/dev, original PRs and genuinely resolved issues closed, independent reviews clear, evidence recorded.
- Memory: this unit, .tmp/d-delivery evidence and session-bound goalplan/ledger in this checkout.
- Tool/credential scope: local source/git, gh for this repository, inherited-model agents, isolated browser QA. No purchases or new credential/account actions.
- Bounds: no owner-set numerical token/cost cap or arbitrary delegation count; 12-hour per-phase wall-clock review bound, checkpoint and reassess if reached. Context compaction is not exhaustion.
- Escalation up: main reclaims any packet after two distinct agents fail it. Down: worker scopes must be fixed in the corresponding P document before B. No speculative next-phase implementation.
- Outcomes: DONE/NOOP only with fresh evidence; unresolved external conditions remain pending and do not weaken the final criteria.

## Checkout and source snapshot

Worktree is adopted in place. Initial dev is 81871b3fa7034250b8d5ba2cbbfde44e40f0e69c. Live source bodies/comments/commits and exact heads are saved in .tmp/d-delivery/pr-N.json. Source refs are origin/d-source-N. No source suites were executed during planning.

## Structure and sequence

1. roadmap: docs-only complete PABCD; lock 010–040 designs and the scratch-backed 050 work item.
2. toml / 010: config parse admission foundation; carry #3669.
3. toolalias / 020: stream argument identity; carry #3673.
4. cursor / 030: executable schema projection on current adapter layout; carry #3628.
5. logs / 040: expose existing filter predicate in actual UI; carry #3625.
6. remotealias / 050: bind generated client aliases to hub-owned routing; resolve #3646.
7. landing: bottom-up dev integration and original-item closeout.

The five fixes are distinct functional units; the owner explicitly requested stacked PRs, so the delivery chain imposes an integration order, not a claim that TOML is a functional dependency of Cursor. Each layer has its own tests/docs and is independently reviewable. Create the documentation parent first, then stack the five item branches. Land eligible lower layers early when CI and review permit, immediately retarget remaining children and verify ancestry. Each implementation cycle certifies its current-head candidate; final landing criteria retain every dev-ancestry and closeout obligation.

## Shared ownership

- A owns shared Responses core integration; D #3673 modifies openai-chat.ts, not core.ts.
- B #3659 and D #3625 share locale modules; integrate both sets of keys.
- B #3649 and D #3646 may both touch Claude aliases/claude-messages.ts. Re-read remote dev before 050 and preserve Fable selector normalization.
- New tests must register both layout manifests where applicable. Existing test edits retain current paths.

## Attribution and GitHub operations

Original author commits or valid Co-authored-by trailers are retained. Every push uses --no-verify. Own rewritten stack refs use --force-with-lease only if required; never rewrite another active task branch. All PR bodies fill Summary/Verification/Checklist and show stack base, source PR, evidence and screenshot for visible GUI changes. Merge bottom-up; refresh head, CI, review and origin/dev immediately before each merge. After merge prove git merge-base --is-ancestor landed-sha origin/dev, then close superseded source PR and any fully solved issue. Partial issues stay open with exact remaining scope.

## Verification route inspected

.github/workflows/ci.yml uses pull_request without a base filter (stack support); src/tests/gui/docs changes are selected by changes job. gates executes Typecheck (lines 422–425), GUI tests (427–428), privacy (430–431), GUI lint/build when relevant; platform shards run the repository tests. Read-only git diff origin/dev...origin/d-source-3669 --check exited 0 and observes the source delta. Roadmap validation is a documentation-only Python check, not an application test suite.
