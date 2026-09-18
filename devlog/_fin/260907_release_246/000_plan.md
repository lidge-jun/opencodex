# Release 2.46.0 plan

Single-cycle satisfy-spec release operation, authorized by the owner to inspect readiness, promote main/preview and publish. First produce this roadmap; no product implementation work is planned. Goal: publish the integrated RC in preview and stable with immutable evidence. Source RC: 0d8b0cd1e3d10bc6b85bfefb3d68555f558407b0. Published baseline v2.45.0. Existing checkout is dirty and remains unchanged except this new unit and ignored evidence/state. Dedicated worktree: /private/tmp/ocx-release-246-01a078cd.

Scope: only version metadata and release branch integration through PRs; hosted tests, registry packaging and release metadata. Excludes unrelated open PRs, default login policy changes, installed-service upgrades and account settings. No new field/enum or enforcement layer is introduced. Existing release gates remain authoritative; administrator capability is not CI or review evidence.

Verification: GitHub source/PR/readiness inspection, independent source audit, candidate CI, exact final release-branch push CI and applicable lifecycle, registry gitHead/integrity/provenance, immutable tag/release and package smoke. Existing successful CI 34071673682 observes 44c69fdd, not the RC (44-file delta). Future CI is NOT RUN until receipts exist. User has specified no cost/time budget; use existing shell/GitHub/npm tools and bounded waits. Record credentials only by auth mechanism, never value.

Terminal DONE: preview and stable verified and dev ahead; NOOP: already delivered identical candidate; blocked/unsafe: concrete external prerequisite or failed gate without a safe remedy. A failure is repaired or remains a blocker, never weakened. Only new product decisions/out-of-scope changes require owner direction. Plan/evidence artifact is this unit plus .tmp/release-246; stop only after required outputs or genuine prerequisite failure. Source-of-truth: MAINTAINERS.md and release.yml unchanged; record outcome in 090_delivery.md.

One PABCD cycle has dependent operational steps in 010_release.md. These steps are not separate product implementation phases.
