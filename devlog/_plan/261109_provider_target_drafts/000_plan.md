# Provider drafts and target changes (#8325)

Provider Settings and JSON edits belong to the server on which editing began. This unit finishes the existing candidate with target discovery, draft lifecycle and save-boundary verification, then records the maintainer's value, UX and compatibility judgment before publication. The user intentionally gains preserved drafts and explicit conflict resolution; ordinary single-target editing and existing configuration formats stay compatible.

## Scope and workflow

- Archetype: satisfy-spec, one remaining implementation/acceptance unit.
- Trigger: owner-required PABCD and maintainer judgment, 2026-11-09.
- Goal: target-specific drafts, truthful target labels and saves, no unintended cross-target effects.
- Non-goals: #8326/#8351, generic account redesign, credential persistence, releases, native-stack creation, real-user configuration changes.
- Verifier: focused GUI and relay tests, root layout/ratchet/Lab guards, typecheck, lint/i18n/build, privacy and structure checks, synthetic two-target browser exercise, fresh exact-head independent and security reviews, hosted PR CI.
- Stop: issue-linked PR merged only after all acceptance and owner judgment are supported; unresolved items hold publication/readiness/merge as appropriate.
- Artifact: this plan and 010_acceptance.md; private investigation and detailed review synthesis remain in .tmp/8325-pabcd/.
- Outcomes: validated merge, or explicitly documented hold with remaining evidence.
- Escalation: incompatible legacy transport contract or inability to demonstrate target-bound mutations requires main disposition before implementation; no guard bypass.

## Starting point and authority

Candidate d625b8c06aeff5481f62ea19fd4f70354eca46ac already exists on base 295159fb59c7afc094c7fd5c65a78635cbc207d2. It predates this formal cycle and is not retrospectively represented as audited implementation. The current P cycle plans remaining acceptance and repairs. Session: 01a1bb00-c621-73e0-baaa-e88ca7d2b746. No host goal or loop was created.

One ordinary PR against dev. No rebases; merge dev only after GitHub reports CONFLICTING. Screenshots go only to pr-assets, linked by commit SHA. Full local suites may use the documented resource exception with focused evidence and explicit NOT RUN; test:changed is not evidence for subprocess-only behavior. Batch cross-platform dispatch stays with coordinator.

## Decisions and consultation

Architect: thread:delegated-task:command%3Amcp%3A59b13298-b9f9-4693-8cbd-c7bfd07c45f9%3Adelegate-task%3A8325-pabcd-architect-d625. Proposal retrieved 2026-11-09. Revision-1 reflection returned ALIGNED; main folded G1 and A1-A7 in revision 2. Revision-2 independent audit returned GO-WITH-FIXES with four blockers; dispositions follow in revision 3.

- D1 ACCEPT WITH AMENDMENT: stable logical origin/link identity, separate transport/request generation, event-driven rediscovery plus focus. Same-hub key rotation must not discard drafts. Capture discovery generation; coalesce session events; do not remount the draft-store owner. Add bounded connected-only reconciliation if events cannot detect external remapping. Standalone users start no connected-target polling.
- D2 ACCEPT WITH AMENDMENT: expected-target relay precondition checked against the same immutable connection snapshot used for forwarding, before upstream dispatch. Consume/strip internal headers. Capability/legacy behavior and direct transport must be explicitly audited; an unsupported header is not proof of protection. Prefer existing protocol and endpoint seams. The reader sees only intentional target-change feedback.
- D3 ACCEPT: per-entry revision, mount ownership and reset/removal generation; async completion uses compare-and-set. Preserve newer edits in the same live instance; reject completions from replaced or discarded instances.
- D4 ACCEPT: deep field-wise pacing rebase with explicit conflicts, retaining unrelated model/key edits.
- D5 ACCEPT: one conflict predicate shared by banner, disabled state and all save entry points.
- D6 ACCEPT: all non-empty numeric fields validated; an empty patch is not invalid-input success.
- D7/D8/D11 ACCEPT: logical identity and request generation flow through CRUD, OAuth, generic/Codex pools, roster recovery and quota consumers. No stale target effects or account-id requests after generation changes.
- D9/D10 ACCEPT: own-key-safe JSON merge and labels derived from safe origin text, never composite key material.
- D12 ACCEPT: app-level activation, actual synthetic relay requests, visual evidence, compatibility tests and exact-head reviews/CI.
- PATCH baseline option: AMEND to an audit decision, not an automatic broad API change. Prefer existing update preconditions; if a new optional baseline is needed for intended same-field conflict semantics, specify old-caller compatibility and add server regression coverage before Build.

## Verification already observed

On d625, main ran 43 targeted GUI cases and 63 root layout/ratchet/Lab cases, all passing; typecheck, privacy:scan and structure:check exited 0. These commands directly name the changed tests or validate tracked source/docs. This is starting evidence, not acceptance of the remaining target lifecycle. Author build/lint and reviewers' larger GUI runs are separate reports; final evidence is bound to the eventual exact head. Live two-target browser E2E and final hosted CI are NOT RUN.

## Maintainer judgment required before merge

VALUE: issue remains real and not superseded; verify issue/PR search live. NO UNINTENDED UX CHANGE: document preserved drafts, target labels and explicit conflict resolution; verify untouched flows/defaults/config formats and old transport behavior. NO REGRESSION: failing-first witnesses plus surrounding behavior and installed/legacy contract checks in isolated homes. Post a short Maintainer judgment comment citing commits/tests and both exact-head review receipts. Green CI alone never justifies merge. Use normal squash with match-head; admin only when GitHub requires an unavailable review approval under the owner's rule.

## Revision 2: main disposition of architect reflection

Reflection task 8325-architect-reflection-r1 returned ALIGNED for D1-D12, with material G1 and amendments A1-A7. Main folds them as follows; no product change has been made in this P phase.

G1: choose L-A, capability advertisement plus legacy preflight. New machine status advertises `relayTargetCheck: "expected-target-v1"`. A supporting relay validates the captured expected target before forwarding. A legacy relay is checked immediately before a mutation; mismatch refuses, requests discovery, and preserves drafts. A one-time target-scoped notice explicitly says the legacy preflight is not an atomic relay guarantee. Never imply the header alone protects an older runtime. Old clients without the optional field retain their existing behavior. No strict header-less rejection is introduced.

A1: stable identity is shared.serverOrigin plus link.linkId in link mode; direct hub uses hub origin, standalone uses window origin. API-key rotation is not a target change. Logical key, discovery/request generation, and entry reset/removal generation are distinct types/contracts. No machine-status poll starts on standalone. Reconciliation must not destroy a successfully minted session for an unchanged target.

A2: HubRelayTarget is the immutable forwarding snapshot. The relay consumes `x-opencodex-expected-target` before header filtering; compare canonical origin from that same target.managementUrl. Mismatch: HTTP 409 with `{error:"target_changed"}` and Cache-Control:no-store, no upstream call. Link mode remains read-only and compares the link identity where relevant. Capability support belongs to the machine listener, not the upstream hub.

A3: entry tombstones last for the page lifetime and are bounded by visited target/provider pairs. A new provider instance supersedes its deletion generation. Discard advances the reset/mount authority before clearing. Saves compare captured authority before any store write or clear.

A4: pacing conflicts display paths for model rule fields and key rule fields. Empty numeric text means unset; nonempty invalid text must never yield success. Validate top-level, per-key and per-model rules against the existing runtime's accepted bounds; verified bounds are RPM 1/60..60_000, integer delay 1..3_600_000, and integer concurrency >=1 without a new upper cap. Each nonempty rule needs at least one valid field.

A5: add explicit immediate-roster, retry-identity and late add/remove/alias action cases. Codex and generic account actions cannot send old-target identifiers through a new target generation.

A6: merge output uses null-prototype objects or own data-property construction, preserving prototype-named keys without changing the prototype. Label fallback displays only the text before the first NUL separator; a composite key never appears in the DOM.

A7: required activation is a browser using the real App, two synthetic local HTTP target servers and an actual local relay handler, with isolated homes and synthetic config. This is accepted as deterministic two-target integration evidence; live external service accounts are neither required nor authorized. Component-only rerender screenshots do not satisfy it. The evidence labels every fixture seam. Each new behavioral witness must first fail against d625 (or an explicitly scoped ablation where the interface did not exist), then pass on the implementation head. Known existing tests must not be weakened.

Settings PATCH decision: no new server baseline precondition in this unit. Conflict detection is against the latest saved snapshot the dashboard has observed; an unobserved concurrent edit can still be last-write-wins, as before. JSON retains its existing server baseline contract. The UI and docs must not claim atomic Settings conflict prevention.

## Revision 3: independent audit dispositions

Audit task 8325-audit-plan-r2: GO-WITH-FIXES (blockers=4), detailed private evidence .tmp/8325-pabcd/audit-rev2.md. All four are accepted, not waived. B remains held pending reflection of interface/flow changes and re-audit.

1. D5 amended: explicit conflict resolution by editing must work. On merge conflict, adopt the latest observed saved baseline and a partial merge that includes non-conflicting external changes while retaining user values at conflicting paths; edit/revalidate those paths and rerun the merge before saving. The baseline, banner, disabled state and handler share one conflict authority. An edit is not automatically a valid resolution; unresolved or newly conflicting paths stay blocked.
2. D2/D11 clarified: each mutation captures an immutable request target at the user action boundary, before any await or deferred fetch. The transport must never derive an expected target from its mutable live target at send time. A target generation change before send refuses the original action; an already sent opt-in request is checked by the relay using its forwarded snapshot.
3. Settings server baseline option rejected for this unit as a separate API/semantics change. Preserve existing PATCH compatibility and explicitly document last-write-wins for changes not yet observed. This does not relax cross-target binding or preservation of unrelated observed changes.
4. D7/D8/D11 expanded: 30-day usage cache, Codex module-level seeds and Add Provider preset cache join the logical-target consumer map, so a stable relay URL cannot reuse another target's data.

Bounded audit additions accepted: pre-body relay check; duplicate/oversized field refusal; no unused link mutation header (link remains read-only); page-memory target-scoped legacy notice; numeric bounds from src/config/schema/leaf-validators.ts; bounded draft lifecycle metadata; safe own-key merge and NUL-free labels; explicit source ownership/test registration and browser activation steps.

## Revision 4 reflection dispositions

Architect reflection 8325-architect-reflection-r3: ALIGNED with three material detail gaps. Main accepts G3-1/G3-2/G3-3 and B3-1..B3-7. Revision 4 specifies partial merge editor content, the action-captured targetFetch API and all usage/preset consumers. It removes stale optional-link/PATCH and unverified-bound wording. No product implementation has started in this cycle; same independent reviewer re-audits this revision.

## Audit acceptance and Build authorization

Revision-4 re-audit returned VERDICT: PASS with no material blockers. Main accepts the verdict; Build entry clarifications in 010 include the Dashboard wrapper, concrete lifecycle bound, discovery coalescing owner, dependency edges, captured transport, observed-only Settings conflicts and fresh-session fixture restart. Build is authorized for the planned remaining delta, not a retroactive approval of d625. Main retains publication and maintainer judgment authority.
