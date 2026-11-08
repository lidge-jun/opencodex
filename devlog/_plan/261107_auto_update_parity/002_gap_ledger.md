# GOAT versus OpenCodex update gap ledger

Evidence and source revisions are in [001_inventory.md](001_inventory.md).
Every row is **open** until its named unit ships and its acceptance evidence is
recorded. A baseline check or draft plan does not close a gap.

| Requested capability | Existing OpenCodex surface | Gap owner and closure evidence |
| --- | --- | --- |
| Background discovery and cadence | Package cache scheduler and Tauri six-hour checks | `030`, `040`: policy-controlled, bounded checks and failure/backoff tests; user can disable them. |
| Stable, preview and nightly selection | npm latest/preview; Tauri latest feed | `010`, `030`, `040`, `050`: signed channel metadata, actual publication routing, no implicit channel changes, unavailable-feed state. Feed publication itself is outside this task and must be reported if outstanding. |
| Signed download and verification | Pinned Tauri updater verifies bytes; package path checks registry SRI | `010`, `030`, `040`, `070`, `090`, `100`: exact signed artifact and complete executable closure, offline positive/negative verification and owner-bound stage for each owner. |
| Download progress and staged readiness | Tauri download currently occurs inside installation | `030`, `050`: distinguish progress, verified ready and unknown; retain or re-establish stage with safe recovery. |
| No-interruption automatic activation | Terminal drain can abort turns at its deadline | `020`, `030`, `040`, `060`, `070`, `080`, `090`, `100`: fenced idle admission, owner-bound stop, race and long-stream tests, and safe deferral for each owner and link direction. |
| Restart, Later and user controls | Explicit desktop install and package dialog | `030`, `040`, `050`: persisted independent check/download/install controls, defined default, explicit install-on-quit option, Later and restart behavior across quit/restart. |
| Sidebar state and release notes | Existing availability dot and update page | `050`: current, available, downloading percentage, ready and failed state; safe localized panel, release notes and keyboard/visual proof. |
| Sidebar version readability | Footer version currently ellipsizes | `050`: stable and long version geometry and accessible full value at relevant viewport/zoom sizes. |
| Failure, rollback and health | npm transaction rollback and desktop failed-install recovery | `030`, `040`, `060`, `070`, `090`, `100`: signed recovery material, durable journal, target health, probation, failed-target suppression, recovery and uncertainty tests for each owner. |
| Linked-machine update and sync | Home fan-out sync, peer features and compatibility | `060`, `080`: separate authenticated update contract for both link directions, independent Child updates, destination policy and Desktop owner bridge, target compatibility, durable fleet resumption, per-Child results and post-update sync; sync alone does not close this gap. |
| Standalone installation updates | Standalone release artifacts exist; current orchestrated plan refuses unsupported ownership | `070`: signed platform artifact, owner-bound replacement, guarded stop, rollback and health proof for every supported target. |
| Telemetry-free update behavior | Existing update checks and local logging | All units: no new update telemetry, bounded local status and passing privacy scan. GOAT's broader telemetry is documented in `001`; do not misstate it. |
| Mock and isolated testing | Existing isolated update fixtures and GOAT mock reference | `010` and each implementation unit: test keys, local mock feed, isolated homes and no real service or installation changes. |
| Security, docs and delivery | Existing ownership, release and test gates | Each unit: independent security PASS where required, docs/locale/structure sync, Lab boundary, file-size/test-layout guards, exact-head CI and a `dev` PR reported to the coordinator without merging. |

Open design blockers: signed trust-root provisioning and rotation, exact
manager-specific signed staging and rollback, complete activity fencing and
stop-to-installer handoff, remote operation authorization and future-version
compatibility metadata, nightly publication routing, cross-platform recovery,
and exact field-chain/test mapping. Their resolution and independent audit are
required before the roadmap can be locked.
