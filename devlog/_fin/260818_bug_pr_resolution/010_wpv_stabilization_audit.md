# 010 — WP-V stabilization audit (post-interruption)

Context: prior session (thread 01a0138d) was interrupted mid-campaign by a codex
runtime error; user reports "too much merged too fast" and asks for a full
main..dev merge appropriateness audit + CI + lidge suite before continuing.

Range: origin/main (e97fb2621, v2.25.0) .. origin/dev (aaf04690e), 125 commits.
A new push to dev re-opens ALL THREE verifiers (CI, lidge suite, whole-delta diff).

## Audit lanes (parallel, gpt-5.6-sol medium, read-only)

- Lane A — campaign land-* merges: #2015(1800) #2016(2007) #2017(1990)
  #2018(1889+1883-followup) #2020(1896) #2021(1932). Check: matrix verdict match,
  rebase correctness (vpr-* merge shape), tests present, no scope creep.
- Lane B — campaign batch merges: 1991 1931 1912 1859 1847 1845 (merge),
  1935 1725 1851 (squash), 1883 (squash, workflow security). Check: matrix match,
  squash-vs-merge shape as prescribed, workflow security for 1883.
- Lane C — pre-campaign merges on dev: 1928 1941 2005 1904 1965 1893 1949
  1944-1947 1998 1997 + docs 2004-2014 + b5a98d690 release-audit fixes.
  Check: each is a reviewed, coherent landing; docs merges are docs-only.
- Lane D — whole-delta security/semantic scan: git diff origin/main..origin/dev
  focused on src/ high-risk surfaces, explicitly including:
  .github/scripts/install-copilot-cli.sh + run-copilot-inference.cjs (supply chain,
  #1883), src/lib/windows-service-wrappers.ts + windows-atomic-replace.ts
  (privileged kill/replace), src/server/management/system-routes.ts + shared.ts
  (management API), src/codex/auth-api.ts + plan-from-token.ts (#1998/#1932 WHAM
  401 gating), src/oauth/google-antigravity.ts (#1889), src/lib/redact.ts,
  scripts/build-release-changelog.ts (#1847), MiniMax loopback pin e9d879b34.

## Verifiers (PLAN-VERIFIER-REAL-01)

- gh run watch 32130622133 (Cross-platform CI on aaf04690e) — observes dev head; running now.
- ssh lidge full suite (typecheck + bun test --isolate tests + privacy:scan) in a
  DEDICATED git worktree pinned at aaf04690e (~/.wpv-suite-aaf04690e). The shared
  ~/Developer/opencodex checkout is owned by a concurrent session (split-wp1b) and
  was swapped mid-run — the first suite attempt (ssh session 27978) is VOID.
- Failure baseline: any lidge failure is classified by bisect-attribution into
  e97fb2621..aaf04690e (ours) vs reproduction at 0f5ccf9aa pre-campaign tip
  (preexisting). No judgment-call classifications.
- Local dirty worktree (#1748 delta) is stashed out of scope for WP-V; it belongs to wp6.

## Accept criteria

- Every merge group has a verdict: OK / SUSPECT(reason) / REGRESSION(evidence);
  coverage list is exact over all 125 commits (incl. docs #2004).
- CI conclusion recorded for exact SHA aaf04690e (or successor if new pushes land).
- lidge suite exit codes recorded; failures classified ours-vs-preexisting.
- Any REGRESSION gets fix-forward or targeted revert in B, re-verified in C.

Out of scope: wp6-wp11 work (later cycles).
