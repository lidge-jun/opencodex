# WP1: reconcile, deliver, verify and merge axis 5

Depends on WP0 roadmap audit. Source baseline dev 137d6a727. Previous D must confirm roadmap-only completion before production patches.

## Layer 1 — #3627 native display names

MODIFY src/codex/catalog/sync.ts: introduce reversible native label overlay at observed-state merge, restore original label before metadata normalization, strip marker from template clones, apply configured label to supported bare native rows only. MODIFY src/codex/convergence.ts: supply the same modelDisplayNames map as retained sync. MODIFY tests/codex-integration/codex-catalog.test.ts and provider configuration docs (English, Japanese, Korean, Simplified Chinese).
Field chain: existing providers.openai.modelDisplayNames config -> both merge call sites -> nativeDisplayNames argument -> display_name plus catalog-only opencodex_native_display_name {slug,original,applied} -> JSON catalog serialization -> restoration before next normalization. Clone consumers must remove overlay markers; source inputs remain immutable.
Activation: configured label replaces native name; removing/blanking restores owned original; external Sol rename is preserved; Astra remains subject to existing pinned-metadata normalization and docs/tests state that exception; newer native metadata upgrades after reset; repeated serialized cycles stable; account-qualified/combo/pro/custom rows unchanged. Exact model IDs and capabilities unchanged.
Credit: Co-authored-by: Éverton Toffanetto <evertondgn@hotmail.com>.

## Layer 2 — #2716 discovered name editor

NEW gui/src/components/ModelDisplayNameDialog.tsx and gui/tests/models-display-name-editor.test.tsx from source PR after current API contract comparison. MODIFY gui/src/pages/Models.tsx, models-shared.ts, gui/src/styles.css, all nine locale modules, English provider configuration docs.
Field chain: existing /api/models displayNameOverride/displayNameSource -> ModelRow optional fields -> Name action/dialog -> existing display-name save/reset endpoint -> persisted provider modelDisplayNames -> reload /api/models. No new persisted field or endpoint is needed.
Activation: save/reset/unchanged cancel; blank/too long/slash/control input; one submit under double click; save failure retains dialog; reload failure remains recoverable; focus returns after close; original selector always visible and alias action remains separate.
Credit: Co-authored-by: Zig Zag <shafishahin786@proton.me>.
Browser smoke: render real isolated app, open Name dialog and observe screenshot; use mocked management responses or isolated disposable home, never mutate personal config. GUI tests/build/i18n/lint and docs build are remote CI obligations; not run locally.

## Layer 3 — #3780 provider JSONL

MODIFY src/cli/provider.ts and src/cli/capabilities.ts to accept --jsonl, emit existing configured-array objects one per line, reject combined --json/--jsonl before reading config. MODIFY tests/cli/cli-provider.test.ts, public CLI docs and skills/ocx/references/01_management_surface.md, 02_json_shapes.md, 03_recipes.md. Regenerate or reconcile derived surface with generator source; no unrelated output.
Field chain: argv -> consumeFlag -> output choice; no config serialization changes. JSONL entries use exactly existing JSON configured fields; no credentials added. The real config loader seeds providers; a zero-provider CLI scenario is not a reachable acceptance claim. Preserve existing loader behavior. Extend source tests to compare every emitted object with --json.configured for multiple registry/custom providers, ensure empty stdout on both conflicting flag orders, and verify escaping. Update all seven translated CLI provider tables and describe consumer-side line processing without claiming producer streaming.
Activation: multiple providers including custom names -> one parseable record each; default human and --json unchanged; both flags rejected; unknown args still rejected; conflicting flags -> empty stdout before config loading.
Credit: Co-authored-by: 투린 <me@turin.my>.

## Verification and disposition

Static git diff --check and independent source audits throughout. Existing focused test paths are reviewed for target coverage, but ALL LOCAL SUITES NOT RUN by owner instruction. Final ci.yml workflow_dispatch lane=all on published final SHA supplies typecheck, full tests and platform results; inspect actual job conclusions and head SHA. Add missing coverage within source scope if audit identifies a contract gap. Inspect GUI workflow coverage and obtain remote GUI/build evidence if not present in final dispatch.
Source-of-truth: provider configuration and CLI docs above; update structure/03_catalog-and-subagents.md only for native overlay contract. No new enforcement layer; tests/CI are evidence, admin bypass is owner-authorized and recorded.
Before merging: fresh heads and native membership, independent review dispositions, final CI proof, original author trailers, screenshot for GUI PR. If infeasible, record concrete cause and leave only that layer unmerged. After each merge: verify mergeCommit SHA and inclusion on fetched dev. Close superseded original PR only once its delivery is on dev and preserve attribution.

Audit amendment: native label restoration preserves an external edit only subject to existing metadata normalization, notably pinned Astra replacement. Do not change native normalization policy. Add the Astra external-edit regression and qualify the promise consistently in all four affected docs. The native feature must preserve metadata including capabilities; English/Japanese wording is explicit. Final physical branch order is native -> JSONL -> GUI to activate final GUI gates; numeric sections above identify features, not alternate dependency claims.

GUI audit amendment: confirmed persisted save/reset must reconcile editor snapshot and draft even when reload fails. A saved:true error is distinct from an unpersisted error. Stalled requests must not lock every dialog exit indefinitely: use existing UI request cancellation/deadline conventions, and represent uncertain write outcome without claiming rollback. Add focused source tests for first-save/reset plus reload failure, saved:true errors, duplicate protection and stalled cancellation.

Plan audit synthesis (Astra high Anscombe): GO-WITH-FIXES, four blockers folded. (1) Lower layer CI is explicitly waived/deferred, never labeled passing; fresh head/base checks plus resulting tree equivalence tie admin merges to final combined evidence. (2) Removed unreachable empty-provider CLI scenario; loader behavior preserved. (3) Confirmed-persistence vs refresh state and tests required. (4) First rederive stalled-request reachability through installed global createBoundedFetch; reuse existing bound if it already applies, add no duplicate budget. Any remaining timeout scenario must be production-reachable.
