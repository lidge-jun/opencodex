# 001 — Dependency and conflict analysis (r2, post-audit)

Audit r1 (grok-4.6 "Avicenna") failed the initial order; accepted findings are folded in below.
Rejected findings and why: none rejected outright; the "2270 has no file overlap" observation was
accepted and 2270 moved before 2281 (it still sits after 2289 because its 48-behind rebase wants a
stable dev, and nothing else touches its files so waiting costs only one rebase, which it owes anyway).

## File overlap between PR heads

- **src/server/responses/core.ts**: #2281 (+12) and #2296 (+6/-9). Semantic neighborhood: _reasoningReplayScope creation (2281) vs pool-affinity key derivation (2296) both hang off handleResponsesInner request-context setup.
- **src/cli/registry.ts** + **docs .../reference/cli/lifecycle.md**: #2289 and #2295. Disjoint commands (service vs doctor); textual conflict likely trivial.
- **Runtime semantic risk without file overlap**: #2270's routed custom-tool lowering executes in the same request path as 2281's replay scope and 2296's affinity key. Post-merge full-suite runs after each of these three is the guard, plus a targeted cross-check at 2281/2296 time that replay-scope and lowering still compose (tests in tests/responses-custom-tool-repair.test.ts + tests/claude-code-thought-signature-scope.test.ts both green on the merged tree).
- All other files disjoint.

## Disposition order (r2 — least-rebase, lock-current-first)

1. **CI fix**: restore dev green (multiAgentGuidanceText #1852 macos failure; rerun already green — confirm and root-cause flakiness).
2. **#2295** (0 behind, green head CI, no rebase owed; lands registry.ts/lifecycle.md first so #2289 absorbs the conflict in the rebase it already owes).
3. **#2294** (3 behind, tiny, no overlap; NAMED SECURITY REVIEW GATE — see below).
4. **#2296** (0 behind; lock core.ts while its base is current; C4 auth — NAMED SECURITY REVIEW GATE; cancelled enforce-target check must be re-run green on the pre-merge head).
5. **#2289** (9 behind; rebase absorbs 2295's registry/lifecycle hunks; Service lifecycle CI green required).
6. **#2270** (48 behind; no file overlap with anything above; single rebase onto stable dev; full suite on the rebased head BEFORE merge).
7. **#2281** (50 behind; takes the core.ts conflict on rebase as the last mover; pre-merge blockers below).

## Named gates (merge-blocking, not notes)

- **Security review gate (#2294, #2296)**: per MAINTAINERS.md/AGENTS.md these surfaces (release automation; auth/account binding) require explicit security review. The maintainer (this session, acting for the owner account) performs and RECORDS a written security review in the cycle doc: threat cases checked, rejection matrix, log-boundary check (no token/secret in output), before merge. The grok-4.6 adversarial verdict is additive, not the security review itself.
- **Pre-merge CI-on-head gate (all)**: merge only from a head whose CI (or local full suite for shared-surface PRs: #2270, #2281, #2296) is green ON THE REBASED HEAD, not a stale ancestor. Cancelled/skipped required checks are re-run, not ignored.
- **#2281 pre-merge blockers**: (a) stacked commit normalizing promptCacheKey via anthropicSessionKeyFromParts (CodeRabbit finding) + test rows; (b) hygiene label missing_regression_test resolved — the PR does carry tests, so re-trigger the deterministic check after the stacked commit and confirm the label drops, or record the maintainer override rationale; (c) rebase onto final-form dev; (d) full suite green on that head.
- **Post-merge dev CI check after EVERY merge** before starting the next cycle (train stops on red).

## Merge mechanics per PR

fetch pr/N -> read full diff (AGENTS.md review rules) -> rebase onto current dev if behind -> focused tests + typecheck -> FULL SUITE (bun run test) pre-merge for every non-trivial PR (AGENTS.md bar; ssh lidge if local env-limited) -> grok-4.6 adversarial verdict -> security review doc where gated -> stack fix commits if needed. Head remotes: #2294/#2295/#2296/#2289 are in-repo branches (push origin); #2270 head is olddonkey/opencodex, #2281 head is Hsia97/opencodex, both maintainerCanModify=true -> push https://github.com/<owner>/opencodex.git HEAD:<branch> (--no-verify is a local-hook flag). Then merge to dev (merge commit convention) -> push --no-verify -> dev CI green -> next. #2270 extra: dismiss/refresh the stale CHANGES_REQUESTED review so reviewDecision matches the converged head.

## Issue closure map

- #2287 -> close after #2289 lands (manual, base is dev).
- #2291 -> close after #2295 lands.
- #2046 -> #2296 fixes reconnect-rotation only; comment with landing commit; keep open unless the remaining Desktop-UI half is split into its own issue at wp6 D.
