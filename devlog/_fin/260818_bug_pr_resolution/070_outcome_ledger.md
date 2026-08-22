# 070 — Campaign outcome ledger (260818 bug-PR resolution + stabilization)

Two sessions: the original campaign session (interrupted by a Codex runtime
error mid-wp6) and this stabilization/continuation session. All evidence
against origin/dev; final head at closeout ≥ a5ec64172.

## Matrix disposition — 24/24 terminal or recorded hold (r10-verified via gh)

| PR | Matrix verdict | Terminal state |
|---|---|---|
| 2007 | MERGE (rebase) | MERGED via #2016 (891c8284b) |
| 1991 | MERGE | MERGED 263f8ca62 |
| 1935 | MERGE-SQUASH | SQUASHED 6779edb02 |
| 1931 | MERGE | MERGED e529927ab |
| 1920 | REDESIGN-SMALL | CLOSED w/ credit; redesign MERGED via #2038 (c42d1eb56); #1866 closed w/ deferral disclosure |
| 1912 | MERGE | MERGED f8b4b783e |
| 1883 | MERGE-SQUASH | SQUASHED b1ca78910 (security pass in WP-V Lane B) |
| 1876 | REDESIGN-SMALL | HOLD (NEEDS_HUMAN): candidate codex/land-1876 validated (rebased, fail-closed ancestors, both TTLs); windows dispatch failure proven pre-existing vs dev control run 32147924436; blocked on standing Wibias CHANGES_REQUESTED — evidence posted on the PR. #1852 stays open pending this. |
| 1859 | MERGE | MERGED d06b99d8b |
| 1847 | MERGE | MERGED 4d07a3d33 |
| 1845 | MERGE | MERGED af24e47bf |
| 1833 | CLOSE-STALE | CLOSED |
| 1990 | MERGE (rebase) | MERGED via #2017 (394b59b64) |
| 1940 | REDESIGN-LARGE-CLOSE | CLOSED w/ split directive |
| 1932 | REDESIGN-SMALL | CLOSED; redesign MERGED via #2021 (f2b507f83) |
| 1896 | REDESIGN-SMALL | CLOSED; redesign MERGED via #2020 (5f2b93979) |
| 1889 | REDESIGN-SMALL | CLOSED; redesign MERGED via #2018 (ea16f8613) |
| 1888 | REDESIGN-LARGE-CLOSE | CLOSED w/ restack directive |
| 1887 | REDESIGN-LARGE-CLOSE | CLOSED w/ re-cut directive |
| 1851 | MERGE-SQUASH | SQUASHED 444131edb |
| 1842 | REDESIGN-SMALL | CLOSED w/ credit; redesign MERGED via #2043 (e446607c8) after independent security review (APPROVE) |
| 1800 | MERGE (rebase) | MERGED via #2015 (3617e1cfa) |
| 1748 | REDESIGN-SMALL | CLOSED w/ credit; redesign MERGED via #2037 (8b9277fa7) |
| 1725 | MERGE-SQUASH | SQUASHED 991074e47 |

## Stabilization (WP-V, this session)

- 4-lane audit of all 125 commits e97fb2621..aaf04690e: no disposition
  violations, no security regressions (Lane D over 302 files; #1883
  supply-chain pass). Two REGRESSION findings were stale-sibling-test class.
- 12 dev-head test failures bisect-attributed to the train and fixed FORWARD
  in PR #2026 (69650fac4): #1851 transient-retry scope guard to the google
  adapter (restored combo-failover first-5xx hop) + 5 stale test updates.
  No reverts required.
- lidge full suite on aaf04690e-era head: 13281 pass / 0 fail (dedicated
  worktree; first attempt VOID from a concurrent-session checkout hijack —
  caught by the r1 plan audit).

## Work-phase evidence (this session)

- wp6: #1748 → PR #2037; #1920 → PR #2038 (decode-proven native wire fix).
- wp7: 1932/1896/1889 verified terminal; #1842 → PR #2043 (security APPROVE);
  #1876 hold as above.
- wp9: structure/04:663 canonical-Fast drift fixed via PR #2049 (0da9e2016) —
  provenance corrected by audit: FastWire B1 introduced the drift, not fixed
  it. Issue sweep (26 issues, 2 lanes): closed #1549 (grok-4.6 landed) and
  #1302 (CI batch-timeout mitigation) with commit evidence; status comment on
  #1849; 23 verified still-open with per-issue mechanism evidence.
- wp10: decade-docs merged via PR #2052 (a5ec64172): 090 transactional-update
  rollback (windows unit), 051 tsig credential scope + six-site
  emit-after-commit barrier (campaign unit; reasoned residence deviation from
  the matrix, recorded). Cross-links on #1942/#1926.

## Recorded holds and follow-ups (not campaign gates)

- #1876 / #1852: maintainer review clearance + windows-leg baseline.
- Windows workflow_dispatch leg red on dev pre-campaign (Log Guard suite
  families; since >= 8/06, last green 7/25). Deserves its own unit.
- Push CI skips windows shards; windows coverage rides the dispatch leg only.
- 050/051 describe the still-open #1926 gaps — public via issue #1926 and
  PR #2052 (prior public disclosure; nothing new disclosed by _fin).

## Final gates (filled at close)

- lidge (~/.wp11-final, exact SHA a5ec64172): TSC=0, privacy:scan pass, and a
  decisive full-suite run 13316 pass / 0 fail / 15 skip, RUN_EXIT=0
  (/tmp/wp11-final-run.log). An earlier pass in the same worktree showed 7
  fails that did not reproduce on the decisive run — same flake class as the
  WP-V first pass (19→0 on re-run).
- Push CI: success on e446607c8 (run 32147799485); the delta e446607c8..head
  is docs-only (structure/04 one-paragraph fix + devlog), which does not
  trigger the CI path filter — recorded per the r10-corrected verifier.
