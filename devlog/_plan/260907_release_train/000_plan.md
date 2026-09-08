# 000 — Release train 260907: land ranked recommendations on dev (loop-in-loop)

Source of items: `devlog/_plan/260907_next_release_recommendations/010_recommendations.md` (27 ranked items).
Base: `origin/dev@ece556a6e` (2.47.0). Goalplan: `release-train-260907-land-ranked-recommendations`.
Class: C4 (release train; admin merges; contributor credit). Full PABCD per work-phase; delegated threads run their own cxc-loop.

## Common rules (verbatim for every lane, main and delegated)

1. No local test suite, typecheck, build, or install. Label them NOT RUN. Remote CI is the only verifier.
2. `git push --no-verify` always.
3. Manual dependent PR chains only (`stack: null`; never GitHub native stacks). Every commit on lower layers carries `[skip ci]` in its
   subject (GitHub suppresses `pull_request` runs only when the PR HEAD commit carries it); the chain's top head runs Cross-platform CI via
   `gh workflow run ci.yml --ref <top-branch> -f lane=all` so the Windows shards are included (ordinary PR runs skip them).
4. If top-head CI is red: dispatch astra-high explorer subagents to diagnose the exact job log, fix sequentially on the owning layer,
   cascade (`git rebase --update-refs`), rerun top-head CI. Never weaken a production assertion; controlled baseline + failing mutant for timing changes.
5. Integration = the Track 2/3 procedure (rollout 01a0778a-b74a / 01a0778a-c620): the chain is verified once at its top head; lower PRs are
   merged bottom-up into `dev` as history-only steps whose cumulative tree at the top equals the CI-tested tree (`git rev-parse <merge>^{tree}`
   vs tested `<top>^{tree}` after the last merge; if dev advanced, cascade + rerun top CI first). Preconditions per merge: fresh `git fetch origin dev`,
   PR head/base/repo refreshed, no unresolved non-outdated threads, no outstanding maintainer CHANGES_REQUESTED, required gates (enforce-target,
   hygiene, label) green on the head, actor = lidge-jun (admin). The PR body records the MAINTAINERS.md integration decision and the exact top-head
   CI run id ("maintainer integration, not self-approval"). `delete_branch_on_merge=true` → retarget the immediate child to `dev` before merging its parent.
   Authorization for rule 1 and admin merge: the user's instruction in this thread ("로컬 스위트 금지 … no verify로 푸시 … 하위는 ci돌리지 않고 가장 상위만").
   Pre-merge (prospective) check, before the first merge of a chain: pin every layer head SHA; compute the expected cumulative tree by
   `git merge-tree --write-tree origin/dev <top>` (or a scratch merge in a temp worktree) and require it to equal the tested `<top>^{tree}`
   (i.e. dev has not advanced under the chain; if it has, cascade and rerun top CI). Intermediate layers become real `dev` states, so each
   layer must be standalone-correct (own thesis, builds in isolation by construction of the chain). Post-merge: compare the final merge's
   tree to the tested tree; expected advancement from the chain's own merges is the only allowed delta.
6. Immediately after each landing: comment on the original PR and issue with the landing SHA. Close the original PR always (superseded/carried).
   Close the issue only when the item fully resolves it; for slices (#3719 ordering, #3379 ranges, #3782 docs, #3774 DnD, #3769 residual) comment
   with the landed slice and the explicit residual, keep the issue open. Use `Closes #n` in PR bodies only for full resolutions.
7. Contributor credit: `git cherry-pick -x` for carried commits; every carried/reimplemented change carries a `Co-authored-by: <login> <id+login@users.noreply.github.com>` trailer resolved from the PR author (not the generic commit author). CREDITS.md must not grow.
8. PR body follows `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification with NOT RUN labels, Checklist) plus the manual chain table. GUI-touching PRs include a screenshot.
9. Ancestry proof after merge: `git fetch origin dev && git merge-base --is-ancestor <merge-sha> FETCH_HEAD` → 0.
10. Security surfaces (auth, credentials, workflows, release.yml) get an independent astra explorer review before merge; the review verdict is pasted into the PR.

## Lane split (disjoint write sets; conflicting items share a lane)

| Lane | Owner | Items (rank) | Primary files | Chain shape |
|---|---|---|---|---|
| M (main, this thread) | main session | #3 #3840 Copilot routing · #12 #3838 OpenCode Go input items (moved from A: shares `registry.ts`) · #5 #3837 Kiro debug gate · #6 #3843 citation span · #7 #3845 keychain restore · #14 #3532 docs (bottom, docs-only) · #13 #2033 web-search enabled (top) | `src/providers/registry.ts`, `src/adapters/opencode-go.ts`, `src/adapters/kiro*`, `src/responses/citation-markers.ts`, `src/providers/key-store.ts`, `src/server/management/config-routes.ts` (M owns; C's #3863 must not touch it — its settings change lives in `startup-health-cache.ts`/settings route only), `docs-site/.../guides/providers.md` (M owns; A's #3858 provider-guide hunk is re-applied by M after A lands), devlog | 7-layer chain: #3532 → #3840 → #3838 → #3837 → #3843 → #3845 → #2033 (top) |
| A (delegated) | thread A | #1 #3862 reasoning envelope admission · #2 #3858 Pi session affinity · #26 #3769 residual compact fallback | `src/responses/reasoning-envelope.ts`, translator budget, `src/server/chat-completions.ts`, `src/server/chat-native.ts`, `src/clients/config-export.ts`, `src/server/responses/core.ts` (A owns), compaction fallback | 3-layer chain: #3862 → #3858 → #3769. Windows shards required for #3862 (dispatch lane=all). Do NOT edit `docs-site/.../guides/providers.md` — hand the hunk to M in the final report. |
| B (delegated) | thread B | #11 #3856 quota activation · #10 #3849 Mihomo IPv6 · #3848 (#3846) DEFER by default; attempt only after #3856 lands and only the runtime slice without GUI i18n/docs (i18n + `codex-integration.md` belong to C) | `src/codex/quota-auto-refresh.ts`, `src/codex/auth-api.ts`, `src/lib/provider-outbound.ts`, `src/types/config.ts` (B owns; E's #3336 config field is added by E after B lands) | chain #3856 → #3849 |
| C (delegated) | thread C | #8 #3839+#3841 sidecar bounds · #4 #3863 Windows health probe · #9 #3860 Desktop sign-in toggle · #23 #3252 subagent fallback GUI (+ #22 #1533 guidance inside it) | `src/web-search/anthropic-executor.ts`, `src/vision/anthropic-describe.ts`, `src/server/startup-health-cache.ts`, settings route (not `config-routes.ts` — if #3863 needs it, coordinate through main), `gui/src/i18n/*.ts` (C owns all i18n edits), `docs-site/.../guides/codex-integration.md` (C owns), agent-settings GUI | chain #3839 → #3841 → #3863 → #3860 → #3252 |
| D (delegated) | thread D | #16 #3719 thinking order parity (slice; issue stays open) · #17 display-name receipt guard · #15 #3817 price overlay · #21 #3667 price editor · #25 #3379 usage ranges slice (←#2956; issue stays open) | `src/claude/outbound.ts`, `gui/.../ModelDisplayNameDialog.tsx`, `src/usage/cost.ts`, `src/usage/user-cost-overlays.ts`, `src/usage/summary.ts`, `gui/src/pages/Usage.tsx` | chain in that order |
| E (delegated) | thread E | #18 release.yml smoke recovery · #19 Raycast/locale docs bundle · #20 code-mode delivery record + Desktop /model docs + translations · #24 #3774 picker DnD (slice; issue stays open) · #27 #3336 pinned effort (waits for A on `core.ts` and B on `config.ts`; rebase onto dev after both land) | `.github/workflows/release.yml`, docs-site locales (not the two guide files owned by M/C), devlog, `gui/src/model-picker-order.ts`, `src/server/chat-native.ts` (after A) | release.yml as its own PR (security review); docs chain; #3774 separate PR; #3336 last |

Single-owner files (audit round 1): `registry.ts`, `config-routes.ts`, `guides/providers.md` → M; `responses/core.ts` → A; `types/config.ts` → B;
`gui/src/i18n/*`, `guides/codex-integration.md` → C. Ownership transfers: `core.ts` and `config.ts` transfer to E once A's and B's chains are
ancestors of `dev` (E verifies with `git merge-base --is-ancestor` before editing). Cross-lane prerequisites (executable handoffs):
- A#3858 lands before M#3838 (both touch OpenCode Go); M rebases its chain onto dev after A reports landing and re-applies A's `providers.md` hunk.
- #3863's `config-routes.ts` wiring (replace the blocking startup-health read) is implemented by M as a layer in M's chain after C reports its
  `startup-health-cache.ts` layer landed; C ships the cache/probe change with the existing route call unchanged and names the exact call site in its report.
- E#3336 after A and B; E#3774/#18/#19/#20 have no prerequisites.
Shared manifests `tests/fixtures/test-layout-expected.json` + `scripts/test-layout/layout.json` are explicitly multi-writer (append-only); the lane
that cascades last resolves. Amendment (wp1, lane D report): `gui/src/i18n/*.ts` are also multi-writer append-only — each lane adds its own
feature-namespaced keys at the end of the relevant section in every locale (gui/AGENTS.md), never edits or removes existing keys; C's exclusive
ownership is withdrawn. Lane B additionally owns `docs-site/**/getting-started/how-it-works.mdx` (en, ja, ko, ru, zh-cn) for the #3856 carry only.
Write sets are otherwise disjoint. Any lane that must touch another lane's owned file stops and reports to main instead of editing.

## Delegated thread packet (sent verbatim with lane-specific rows)

TASK: run cxc-loop (HOTL) in your own worktree to land lane <X> items on dev. SCOPE: the files above plus their tests/docs. MUST DO: common rules 1–10;
PABCD per layer with an independent astra explorer audit; report landing SHAs, CI run ids, closed PR/issue links. MUST NOT: touch other lanes' files, release,
publish, native stacks, local suites, force-push without lease. PROOF: ancestry command output, CI run URL, closure comment URLs. RETURN: a final message
with a table item → disposition → SHA → CI → closures, and DEFER reasons.

## Merge serialization

Main session is the only actor that admin-merges. Delegated threads bring a chain to "top-head CI green + review pasted" and report; the main session
refreshes dev, re-checks tree equality, merges bottom-up, retargets children, closes originals. If dev advanced under a chain, the owning thread cascades and reruns top CI before merge.

## Acceptance (goalplan c-1..c-4)

Every attempted item landed with ancestry proof or DEFER/BLOCKED with reason; each merged chain has an exact-head CI run id; original PRs closed with SHA
comments and credit trailers, issues closed only on full resolution (slices commented and kept open per rule 6); final readiness doc `090_readiness.md`
committed with privacy:scan exit 0.
