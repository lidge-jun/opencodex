# 261001 omo (Codex / LazyCodex) carry series

LilMGenius opened three stacked PRs that let opencodex manage the model of each Codex agent role installed by LazyCodex (#6262), size roles and auto-assign models (#6269), and suggest a delegation model on the Subagents page (#6274). They could not land as fork PRs: the readiness gate needs the author's local-validation attestation, fork CI never ran its test shards, and `hygiene` flagged an unsponsored management-API surface. This unit lands the same work as three maintainer carry PRs in dependency order, each crediting the author, each merged only after its exact head passes hosted CI.

## Loop spec

- **Loop archetype:** satisfy-spec (verifier defines done: exact-head required CI green, then squash merge).
- **Trigger:** maintainer request (2026-10-01) to research omo and merge LilMGenius's work via cxc-loop.
- **Goal:** #6262, #6269 and #6274 content on `dev`, originals closed with credit.
- **Non-goals:** no behavior changes beyond the contributor heads; no Pi omo or OpenCode omo changes; no #6348 or other JEV work; no release or promotion. **No local test suites or typecheck** (maintainer instruction); hosted CI is the only execution evidence.
- **Verifier:** `gh pr checks <carry PR> --required` on the exact head SHA (reads every required job of that head, including test shards, typecheck, structure, privacy, file-size ratchet, hygiene, enforce-target). Local: `git diff --check` and `git merge-tree --write-tree origin/dev HEAD` (textual union only).
- **Stop condition:** all three carries merged and originals closed, or a blocker that needs maintainer direction.
- **Memory artifact:** this unit (000–030 docs) and the session goalplan `lilmgenius-omo-codex-lazycodex-role-model-series`.
- **Expected terminal outcomes:** DONE (three merges); BLOCKED (CI failure needing design change, union conflict that changes behavior); NEEDS_HUMAN (security-review objection).
- **Escalation condition:** a required job fails for a reason that is not a mechanical carry fix; a behavior decision beyond the contributor heads; a security-review objection. Shared gate 4 compatibility repairs (including a byte-for-byte ratchet move) are pre-authorized and do not escalate.
- **Resource bounds:** none set by the user beyond the host goal.

## Research

- **omo variants** (maintainer review 2026-09-30 01:47 on #6262): Pi omo (senpi, `~/.omo/agent`, existing omo tab), OpenCode omo (oh-my-opencode, untouched), Codex omo (LazyCodex). The series is now scoped to LazyCodex; Pi omo has no diff against `dev`.
- **LazyCodex detection verified against LazyCodex source** (`~/developer/codex/161_lazycodex`): the installer writes `lazycodex-install.json` into the plugin root (`plugins/omo/scripts/install-flow.mjs:4` `INSTALL_SNAPSHOT_FILE`, `plugins/omo/dist/cli/index.js:99259`); the plugin is installed with `codex plugin add omo@sisyphuslabs` (README). `src/clients/lazycodex.ts` requires `plugins."omo@sisyphuslabs".enabled = true` and a receipt under `plugins/cache/sisyphuslabs/omo/<ver>/`, matching the Codex plugin cache layout.
- **Open review threads** re-checked at heads 6262 `ada7ec14b1`, 6269 `6c97ca9a4f`, 6274 `b180fcec0a` (architect D2–D4): unreadable `omo.jsonc` (handled by `readOmoRoleModels` → `unreadable`), escaped quoted keys (decoded, undecodable refused), multiline closing quotes (scanner consumes them), mirror retry (`retryMirror`), DelegationSuggest live region (mounted polite region). All fixed with regressions; threads are resolved on landing with a pointer.
- **Topology:** strictly stacked 6262 ⊂ 6269 ⊂ 6274, merge-base `961a4b569` (26 behind `dev` at `0328373fb8`); `git merge-tree` of 6274 vs `dev` is clean. Layer sizes: L1 18 commits / 39 files, L2 19 / 43, L3 12 / 38. All 49 commits authored by `LilMGenius <smsmeee@naver.com>`.
- **Ratchet:** no touched file is in `tests/fixtures/file-size-baseline.json` caps; i18n catalogs are exempt. Uncapped files fail at 2,000 lines; `src/server/management/agent-settings-routes.ts` reaches 1,941 at 6274 (watch in wp3).

## Work-phase map (dependency order)

| WP | Doc | Content | Depends |
|---|---|---|---|
| wp0 | this unit | docs-only roadmap | — |
| wp1 | 010 | carry `961a4b569..6262`, PR, CI, merge | wp0 |
| wp2 | 020 | carry `6262..6269` onto merged dev, PR, CI, merge | wp1 |
| wp3 | 030 | carry `6269..6274` onto merged dev, PR, CI, merge, close originals | wp2 |

## Decisions (architect Godel `01a0f664-d0ea-7000-894a-50e8a319b548`)

- D1 sequential layer cherry-pick onto landed dev — **accepted**: each PR diff is its own layer; author identity stays on every commit; squash body adds `Co-authored-by: LilMGenius <smsmeee@naver.com>`.
- D2/D3/D4 findings already fixed — **accepted**; no extra code; resolve threads with pointers on landing.
- D5 union gates (ratchet 2,000-line ceiling, test-layout maps, i18n parity, structure ownership, route registry) — **accepted**; enforced by hosted CI, watched by hand at carry time.
- D6 preserve recent dev changes in shared files — **accepted**; conflicts resolved by keeping both sides, never wholesale contributor tree.
- D7 merge-dev-into-contributor-head alternative — **rejected**: post-squash parent overlap makes later layers re-carry earlier commits.
- D8 #6274 scope is general Codex delegation, not LazyCodex-only — **accepted as intended**: the author states it configures Codex delegation defaults; the maintainer asked to merge the whole series.
- Reflection: see 001_reflection.md.

## Security review note

## Gates shared by every carry (r2, after architect reflection)

1. **Pinned inputs.** Replay immutable full-SHA ranges only: wp1 `961a4b569512bd568106c4ea67a21a346e002779..ada7ec14b1b089f461e43e208d54750591fd26f9`, wp2 `ada7ec14b1b089f461e43e208d54750591fd26f9..6c97ca9a4fdec6c59901fa115be341d9cc590a15`, wp3 `6c97ca9a4fdec6c59901fa115be341d9cc590a15..b180fcec0a4c3ff63b9f230acc79e5f029bb6cea`. Before replay assert `git rev-parse refs/omo/<n>` still equals the upper SHA; a moved contributor head stops the carry for re-plan.
2. **Fresh base.** `git fetch origin dev` immediately before branching; wp2/wp3 assert `git merge-base --is-ancestor <previous squash SHA> origin/dev`.
3. **Conflict reconciliation.** Keep both sides semantically: one entry per key in i18n catalogs, layout maps and route registry; no duplicated registrations; never take the contributor file wholesale.
4. **Compatibility repairs are allowed** when hosted CI fails for a mechanical union reason (test-layout registration, ratchet 2,000-line ceiling via a byte-for-byte move into a sibling module, i18n key parity, structure ownership). Such a repair is a separate commit named "fix(carry): …", listed in the PR body, and does not change behavior. Anything else escalates.
5. **CI receipt.** Record in the PR body/comment and in this unit: head SHA, base SHA, `gh pr checks <n> --required` output with every required job `pass`, and a coverage assertion that the expected jobs actually ran and succeeded at that head — every `test` shard, `typecheck`, structure, privacy scan, file-size ratchet, `hygiene`, `enforce-target`, and GUI lint/tests when `gui/` changed; a job that is absent, skipped or cancelled fails this gate. Also record the CI run id and attempt for the `pull_request` event at that head. Immediately before merge, re-read the head SHA and required checks; merge with `gh pr merge <n> --squash --match-head-commit <sha>`.
6. **Publication.** PR template fully filled; GUI screenshots linked from the contributor's existing pr-assets (no image committed to the branch); squash body ends with `Co-authored-by: LilMGenius <smsmeee@naver.com>`; maintainer-integration record (MAINTAINERS.md "maintainer integration": actor lidge-jun admin, exact-head CI evidence) posted as a PR comment.
7. **Security review.** Before merge, an independent read-only security reviewer (fresh subagent, not the architect) reviews the exact carry head for its surfaces — management-API route admission and sibling guard, file writes under `$CODEX_HOME/agents` and `~/.omo/omo.jsonc` (path validation, atomicity, no secret logging), and the loopback self chat-completion (admission header, response bounds). Its verdict (PASS / FINDINGS) is bound to the head SHA and recorded in the PR comment and in this unit. FINDINGS block merge until fixed or explicitly dispositioned; an unresolved objection is NEEDS_HUMAN. Owner authorization (2026-10-01) covers the merge decision, not the review.
8. **D8 evidence.** #6274 author comment 2026-09-30T07:35: "Delegation suggest configures Codex delegation defaults, so it stays unscoped from the omo variants"; the maintainer's 2026-10-01 instruction covers the whole series.
9. **Maintainer-objection gate.** The originals carry two `CHANGES_REQUESTED` reviews by lidge-jun (2026-09-30 01:44 stack split, withdrawn by the 01:47 review; 01:47 omo-variant scoping). The author addressed the variant scoping in `e9ea34661`, `7c81640d0`, `b91537a75`, `d7a4f91a7` (#6262) and the matching #6269/#6274 commits. When each carry PR opens, dismiss both reviews on its original with a message citing those commits and the carry PR; immediately before each merge run `scripts/ci/assert-mergeable-review.sh --maintainer-integration <carry PR>` and require exit 0. Any other maintainer objection is NEEDS_HUMAN.
10. **Base binding.** `pull_request` CI tests the merge of head and base at trigger time. Immediately before merge: `git fetch origin dev`; if `origin/dev` moved past the base recorded in the CI receipt, merge `origin/dev` into the carry branch (no force push), push, and repeat gates 5, 7 and 9 on the new head; for gate 7 the security reviewer inspects the incoming dev delta and re-attests the new head (a short "no security impact" verdict bound to that SHA suffices). Merge only when the receipt base equals current `origin/dev`.

## Security review note (surfaces)

Surfaces: management API routes (`/api/codex-agent-roles`, auto-assign, `/api/injection-model/suggest`), file writes under `$CODEX_HOME/agents` and `~/.omo/omo.jsonc`, and a loopback self chat-completion (`src/lib/local-chat-completion.ts`). No credential storage or OAuth change. Sibling instances refuse writes. Each carry PR states this and requests the MAINTAINERS.md security review explicitly.
