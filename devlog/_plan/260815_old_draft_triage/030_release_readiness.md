# 030 - Release-readiness record (wp3)
 
## Gates on dev (all on ssh lidge per owner directive)
 
- cc8e5a30 (pre-release-guard tip): INSTALL_OK, AUDIT_OK (bun run audit:high,
  root+gui, 0 vulnerabilities), TSC_OK, PRIVACY_OK, LINT_GUI_OK,
  GUI_TESTS_OK (855 pass / 0 fail, 147 files), root suite 12259 pass /
  11 skip / 0 fail (12270 tests, 781 files [457.69s]), docs-site build OK
  (323 pages).
- Final tip 14196b208 (includes #1753): root suite + typecheck + privacy
  re-run (see below).
- dev CI: Cross-platform CI green on cc8e5a30 (run 31872155114).
 
## Anomaly found and hardened
 
- Version line: dev package.json was 2.18.0 while npm latest = 2.19.0
  (main). Neither v2.18.2 nor v2.19.0 is an ancestor of dev; the release
  helper only checked the proposed version was unused, so an obsolete
  target could have moved a dist-tag backwards.
- Fix landed: #1753 (fix/260815-release-version-guard, a147da455) adds a
  channel-forward guard to scripts/release.ts (npm dist-tags read,
  semver-ordered strictly-newer requirement, preview channel compares
  against preview) with 3 new shimmed tests.
 
## Remaining release-time requirements (owner actions at promotion)
 
1. Pick the next version strictly newer than npm latest (2.19.0) - the
   guard now enforces this mechanically.
2. Promotion dev -> main is maintainer-controlled (MAINTAINERS.md); the
   helper must run on main/preview with clean tree; CI must be green on
   the release-bump SHA before the workflow dispatch (expected-sha pinned).
3. Artifact closure at release time: workflow dry-run/pack, OIDC publish,
   registry visibility, tag + GitHub Release on the release SHA.
4. Release notes are generated from PR labels after npm publish - audit
   labels of the landed batch PRs (#1736 #1744 #1749 #1753) if curated
   notes matter.
 
## Dispositions recap (18 old drafts)
 
- Landed via #1744 (6): #1664 #1669 #1660 #1652 #1165 #1644 (cherry-picked,
  authorship preserved, repaired, review-verified).
- Rebuilt + verified, HELD for owner landing decision (4): #1521 #1584
  #1569 #1655 - int/260815-heavy @ 2799fba20, lidge suite 12330 pass /
  0 fail, reviewer PASS x4. One-command land on approval.
- KEEP-DRAFT with maintainer comments (8): #1498 #1367 #1552 #1557 #1526
  #1624 #1645 #1703.
 
## Follow-up fixed in flight
 
- #1749: GUI gate tests broke after #1744 (mcode inventory assertions +
  zh-TW allowlist) - fixed same-day, dev CI green again.
 
