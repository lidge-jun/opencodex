# 261009 N5 — small PR and issue sweep

**Reader summary.** Sweep lane N5 drives three items to a terminal state: contributor PR #6734 (paste a
`codex://threads/<id>` link into the Logs conversation filter), contributor PR #6813 (an explicit Codex
account selection can silently lose to a newer disk snapshot, so routing and auth use another account), and
issue #6757 (Aside profiles show `off (stale)` and `ocx integration client sync --client aside` gives no
actionable recovery). Each item ends READY, NEEDS_HUMAN, BLOCKED or SUPERSEDED with evidence.

## Loop spec

- **Loop archetype:** satisfy-spec, multi-cycle HOTL (cxc-loop), one work-phase per PABCD cycle.
- **Trigger:** coordinator chat 01a11fe0 dispatched lane N5 ("ㄱㄱ 하자 너 상속으로 레인 파견하고 sol 서브에이전트
  무제한으로 쓰라고") with the N5 scope #6734, #6813, #6757.
- **Goal:** #6734 READY as-is or carried; #6813 carried onto current dev in a maintainer branch so repository
  CI runs, security-reviewed; #6757 recovery guidance shipped with OFF preferences preserved and the cause
  reported or its unknown documented.
- **Non-goals:** other lanes (N1–N4, L1–L7 PRs #6802–#6818 and #6806); `.github/workflows`; the user's live
  Desktop sidecar (port 10100), `~/.claude`, `~/.aside`, PATH shims; merging, commenting on or closing other
  authors' PRs and issues; approving fork workflows; release.
- **Verifier:** per work-phase focused Bun test files named in each decade doc, `bun run typecheck`, and
  `bun run structure:check` / `bun run privacy:scan` where structure or docs change; exact-head hosted CI is
  the broad gate. Full `bun run test` is left to CI (lane instruction: minimal local tests).
- **Stop condition:** every item terminal; one final lane report. Merge is outside authority.
- **Memory artifact:** this unit; goalplan `.codexclaw/goalplans/opencodex-sweep-lane-n5-small-prs-issues-forked`
  in the coordinator cwd `/Users/jun/.codex/worktrees/7301/opencodex`.
- **Expected terminal outcomes:** DONE = all three items READY or terminal with evidence; NEEDS_HUMAN = a product
  or security decision the evidence cannot settle; BLOCKED = CI infrastructure or permission; UNSAFE = a fix
  that needs the user's live environment.
- **Escalation condition:** reviewer FAIL twice on the same packet; any need to write to another author's PR.
- **Resource bounds:** tools = local shell in lane worktrees, gh for this repository's own branches/PRs/CI,
  gpt-6.1-sol subagents without a count limit; write scope = `opencodex-lanes/261009-N5-small*`; no token or
  time budget was stated (host limits apply).

## Work-phase map (dependency order)

The three items are independent; order follows risk of drift (a contributor head that is already green
first, then the auth carry, then the new CLI behavior).

| Goalplan id | Doc | Slice | PR | Depends on |
|---|---|---|---|---|
| wp0 | this unit | docs-first roadmap | none | — |
| wp1 | `010_pr6734_thread_links.md` | review and union check of #6734; READY or carry | original #6734 (or carry) | wp0 |
| wp2 | `020_pr6813_account_selection_carry.md` | carry #6813 onto dev, security review | new PR → dev | wp0 |
| wp3 | `030_issue6757_aside_recovery.md` | Aside off/stale recovery guidance + cause report | new PR → dev (carries this unit) | wp0 |
| wp4 | `040_closeout.md` | merge #6824 and the #6757 PR under the gate, close originals, final report | none | wp2, wp3 |

## Evidence baseline (origin/dev 730d898457)

- #6734 head `ca2391373f`: `git merge-tree --write-tree origin/dev pr/6734` exit 0, tree `9e44b77e61`; union
  focused tests 96 + 28 pass, typecheck exit 0 (explorer receipt `/tmp/n5-6734-evidence/receipt.txt`).
- #6813 head `8441b1bc68` (base `f7d6c049`): merge-tree clean, tree `a86859108a`; #6811 merged as `c3bbaaa342`
  and shares only the two layout registries and `structure/config.md`; union 460 focused tests pass.
- #6757: no automatic path flips an explicit true preference to false; candidates are schema fallback of a
  malformed policy (`src/config/schema/config-schema.ts:239`) and loss of legacy-derived activation
  (`src/integrations/aside-profile-context.ts:167-181`).

## Source-of-truth sync

`structure/` docs owned by touched areas: `structure/dashboard-and-usage.md` (#6734, already in the PR),
`structure/config.md` + `structure/providers/openai-accounts.md` (#6813, already in the PR), and the
integrations doc that owns `src/cli/integration-aside-sync.ts` for wp3 (resolved in 030 via
`structure/manifest.json`).

## Authority amendment (coordinator steering, 2026-10-09)

The coordinator relayed the user's instruction "머지까지해": this lane now merges its own PRs and closes the
originals. Per-PR gate immediately before merge: base dev; no failed/cancelled/pending exact-head job (including
triggered Windows jobs; a queued-only enforce-target over one hour with all code CI green is non-blocking and
reported); `mergeable == MERGEABLE`; independent gpt-6.1-sol review PASS (plus sol security review PASS for #6813);
fresh origin/dev with no conflict, and a union focused-test run when another PR touched the same files. Then
`gh pr merge <n> --squash --admin` (carry bodies keep `Co-authored-by`), close carried/replaced originals with a
credit comment (merged PR, merge commit, author), and close fixed issues with a dev note. Partial items stay open
with a comment. Still out of scope: release, main/preview, other lanes' PRs, fork workflow approval, the user's
live environment.
Gate addition (audit wp2): no outstanding maintainer change request on the PR at merge time (MAINTAINERS.md).
