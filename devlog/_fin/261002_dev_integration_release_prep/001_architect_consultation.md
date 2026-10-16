# 001 — architect consultation record (plan revision 2)

Architect: Sol subagent 01a0fc9b-3548-78f2-9359-ba35db82cc74 ("Rawls"), read-only, no tests.

Proposal decisions and main dispositions:
- D1 (F1 already fixed; add derived-entry + zero-fetch tests): accepted → 020 F1.
- D2 (in-slot replacement only for preferFirst providers, keyed by routedSlug): accepted → 020 F2 diff.
- D3 (sibling test files, registered in both layout JSONs; avoid capped codex-catalog.test.ts): accepted → 020 tests.
- D-REL (pre-move via dev-version-bump.yml, release.ts on the release branch, read-only readiness checks): accepted → 030;
  this loop does not run release.ts (it runs local tests and pushes).

Reflection verdict: MISALIGNED with 8 gaps. All folded in revision 2:
1. encoded-slug case added; 2. cold-seed failed-discovery case added; 3. catalogKind constant, displayName and catalog
projection/priority asserted; 4. unsorted static models ["c","a","b"]; 5. release.ts reframed as the maintainer's approval
step, not run here; 6. four-source equality and npm channel/candidate checks added; 7. 010 requires completed successful
required checks, flaky classification needs prior pass + environmental signature + passing single rerun; 8. structure/catalog.md
added to SoT scope.
