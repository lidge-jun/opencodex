# 030 - WP3 stable production deployment and branch alignment

Work class: C4. Archetype: spec-satisfaction.

## P - State going in

- Release commit `893f202b` ("release: v2.7.5") is the tip of `main`; CI for it
  succeeded (run 29075907472). Release dry-run 29076039040 built and packed
  v2.7.5 from that exact SHA. Baseline (glm sweep): 2.7.5 absent from npm
  (E404), no v2.7.5 tag/release; rollback v2.7.4 = `852a71ff`, tarball
  resolvable; Pages 200 with live docs; deploy-docs latest run 29075875886
  success on main@a5378eaf (pinned actions already exercised).
- dev/preview are at `a5378eaf` (parent of the release commit).

## Build steps

1. Verify main tip is still `893f202b` immediately before dispatch (the manual
   dispatch uses the branch tip; audit advisory P2-2).
2. Dispatch the trusted workflow: `gh workflow run release.yml --ref main
   -f version=2.7.5 -f tag=latest -f dry-run=false`; watch to completion.
   The workflow re-runs every gate (version match, CI-for-SHA, service gate:
   package.json changed since v2.7.4 and service-lifecycle ran green on
   affected SHAs' branch pushes - the gate looks up runs by commit, so rely on
   the push-triggered service-lifecycle run for 893f202b, which package.json
   changes trigger automatically), then publishes via OIDC, smokes the
   registry, and creates tag+release at GITHUB_SHA.
3. Fast-forward dev and preview to `893f202b` (no force). Their pushes
   trigger CI + service lifecycle (package.json in trigger paths); require
   green.
4. Dispatch deploy-docs on main for an exact-SHA Pages run, then HTTP smoke.

## Verification (C)

- `npm view @bitkyc08/opencodex@2.7.5 version` == 2.7.5; dist-tag `latest`
  == 2.7.5; preview tag unchanged.
- Tag `v2.7.5` SHA == 893f202b; `gh release view v2.7.5` exists, not
  prerelease, previous tag v2.7.4 installable as rollback.
- Pages run success on main@893f202b + `curl` 200 with expected content.
- `git ls-remote`: main == dev == preview == 893f202b; no force pushes.
- Repo-scope cleanliness: every file this goal touched is committed and
  pushed; pre-existing unrelated in-flight user work (images proxy, catalog
  edits) stays untouched per out-of-scope rule.

## Failure policy

- Any failed gate: read the failing step log; no blind retry; no gate
  weakening. A partial publish (npm yes, tag/release no) is repaired by
  re-running only the metadata steps via the same workflow semantics, never
  by hand-editing published metadata.
- Wall bound: 40 minutes for WP3.
