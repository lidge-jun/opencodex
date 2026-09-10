# Release audit

Two independent auditor dispatches returned no usable result within their bounded waits and were retired. Main reclaimed the packet rather than treating silence as approval. This is a direct audit, not an independent-review claim.

1. Version ordering verified in release.yml and version-line.ts: dev must outrank 2.43.0; use existing bump script to 2.44.0 before publication.
2. Bootstrap amendment accepted: default main does not register dispatch yet; one-file manual pre-move PR is supported by existing helper and preserves protected branch boundary.
3. RC push CI 33974061890 and service 33976119109 passed; repeat on each actual promotion SHA as required. Windows full suite deliberately non-gating; no full Windows green claim.
4. Preview merge-tree conflicts in package.json only. Main contains no divergent commits. Require post-merge RC ancestry and exact file parity excluding version.
5. Owner admin merge authorization recorded in PRs; no self-approval or failed functional check bypass. Production payload comes only from pinned RC already integrated into dev.
6. Open bug PRs remain visible; no unrelated draft integration. Public PR 3671 boundary existed in main before RC, and is not modified by promotion. General readiness is not defect-free certification.
7. Release workflow validates exact branch SHA, push CI, lifecycle, dev readiness, global version order, duplicate metadata and npm audit before OIDC publication. Readback npm gitHead and immutable tags after each channel; never rerun an apparently failed publish until inspecting actual registry metadata.

Main verdict: PASS for proceeding to version/promotion PR preparation. Independent audit unavailable; inherited integrated reviews plus current CI and direct release-mechanics inspection are the evidence. No production-code or credential boundary edits are included.
