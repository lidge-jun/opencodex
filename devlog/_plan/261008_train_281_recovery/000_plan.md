# Recover the 2.81.0 release train

The previous coordinator stopped before integration and publication. Continue its four remaining deliveries, verify their combined behavior, then publish 2.81.0 and the improved homepage. Existing lane owners retain their branches.

Loop: satisfy-spec, C4 release; trigger: owner request to finish the previous train and deploy. Scope: #6370 carry, #6743 independent Anthropic pool, #6748 picker fixture cleanup, homepage mobile/GitHub stars. Exclude unrelated PRs, provider policy, live service restarts, destructive cleanup and credential changes. Verification: exact-head PR checks and independent reviews, frozen candidate cross-platform CI, release workflow and registry/asset/Pages readback. Stop only when all delivery receipts pass; unresolved policy or external access is NEEDS_HUMAN, not completion. Evidence lives in this unit and ignored `.tmp/train281-recovery/`. No user token/time budget was imposed; use existing repository GitHub access, bounded polling and no new paid services. Reassess actual failures; do not invent resource exhaustion.

| Phase | Document | Dependency | Exit |
| --- | --- | --- | --- |
| wp1 | this plan | none | recovered roadmap reflected and independently audited |
| wp2 | 010_integration.md | wp1 | four qualified merges, superseded table, frozen C full CI |
| wp3 | 020_publication.md | wp2 | version pre-move, promotion, npm/GitHub/assets and homepage readback |

Main owns GitHub mutations and this task checkout. Spend and homepage lanes were resumed in their assigned checkouts. The active Anthropic owner retains its no-local-test instruction, including composition checks; use hosted proof for that lane. No cancellations or rebases; no changes in peer working trees. Per-PR CI remains mandatory.

Architect proposal: Planck, handle `01a11a91-1357-7af0-a98b-c819216afe72`. Accept REC-281-01 through REC-281-09: preserve owners, separate exact-head gates, keep lane execution restrictions, attribute failures, serialize merges, freeze C, pre-move dev without changing C, promote M with release-line policy, and independently verify published artifacts and Pages. The homepage dependency and deployment receipt repair omissions in the original roadmap. Reflection and audit are recorded below when received.

The pre-existing roadmap is `devlog/_plan/261008_train_281/` in the previous coordinator checkout. Its implementation contracts remain authoritative for lane work. This recovery unit changes execution ownership and explicitly adds the later homepage requirement; it does not redefine product contracts. Architecture/source-of-truth updates stay in their owning implementation PRs. No new runtime field or enforcement mechanism is added here.

Baseline observed: dev `aeebf11e5a2c49b5f2edb2e0d8ecafd95e872119`, public release v2.80.0 at `250f17afd8ff44c93c620d87c1f346ef56f64fb4`. Refresh all volatile facts before mutation.

Architect reflection: ALIGNED after narrowing the release CI event requirement; only Service lifecycle may use a documented exact-M manual equivalent. Main accepted that correction. Homepage recovery moved to fresh thread 01a11a97-e166-7973-a13c-8bac65626d95 after two confirmed provider failures; it must reconcile existing writers before takeover.

Independent roadmap audit: Socrates `01a11a98-8c20-7a90-85ad-cc29c6f08d81`, VERDICT PASS, no blockers. Read-only policy/workflow review and whitespace check passed; product execution remains pending.

Recovery update: fresh homepage task also failed with the same provider error. Main reclaims the existing four-file change into its own checkout after confirming terminal task state, no running homepage process and reconciling child writers. Preserve original partial files. This changes execution ownership only, not review/QA/CI scope.
