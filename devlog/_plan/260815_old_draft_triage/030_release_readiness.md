# 030 - Release-readiness record (wp3)
 
Snapshot: 2026-08-15, dev tip b5bf24fe7 (subject to fleet movement).
 
## Audit findings (readiness auditor, GO-WITH-FIXES, 2 blockers)
 
1. Exact-tip CI evidence kept resetting as dev moved; the only real failure in
   the window was 656376fc6 (4 stale GUI client-inventory assertions, fallout
   from the #1744 MiniMax landing) - repaired by #1749, green at 31872155114.
2. scripts/release.ts SemVer guard fail-open (unresolved #1753 finding):
   compareReleaseVersions produced NaN on build-metadata cores
   (2.19.3+build.1), passing any candidate. Fixed in #1757 (strict SemVer
   parse, build metadata ignored for precedence, fail-closed throw; 3
   regression tests; release-helper suite 13/13). NOTE: release automation
   change - flagged for the explicit security review MAINTAINERS.md requires.
 
## Verified green
 
- OIDC release pipeline: last release run 31855514468 on main 161c09f60
  published v2.19.0 with signed provenance; npm latest = 2.19.0. Healthy.
- audit:high (root+gui): no vulnerabilities (also re-run in the lidge gate).
- Dependency/workflow hygiene: #1738 cleaned orphaned workflow identities.
- lidge full gates @ 9ed2e8459 (post-#1752 tree): 12347 tests, 0 fail.
- lidge full gates @ b5bf24fe7 (final tip incl. #1757): (pending at write time;
  see final report).
 
## Version-line state (for the release decision - NOT executed)
 
- dev package.json 2.18.0; v2.18.2/v2.19.0 are main-only release commits.
- Next sensible feature release: 2.20.0 (2.19.1 also legal; 2.19.0 collides).
- No release/publish/tag/main-promotion was performed in this loop.
 
## Remaining before a release cut
 
- Exact-tip Cross-platform CI green on the chosen release candidate SHA.
- Service lifecycle runs on the version-bump commit (helper waits for it).
- Maintainer security approval for the final scripts/release.ts state (#1757).
 
