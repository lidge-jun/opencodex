# Remaining implementation and acceptance plan (revision 4)

This is one dependency-ordered work unit, not separate independently mergeable PRs. P and A are read-only with respect to product code; B starts only after architect reflection and independent audit.

## File change map and order

1. MODIFY gui/src/api-targets.ts; NEW gui/src/hooks/useApiTargets.ts (or a smaller existing owner if audit identifies one); MODIFY gui/src/App.tsx and gui/src/api.ts. Stable logical key = normalized advertised origin plus link identity where necessary, not API-key rotation. Discovery creates target generation; configuration and session reconciliation consume it before readiness. Refresh on pairing/session/focus and server mismatch, coalesced to prevent discovery/session loops. Keep parked drafts above any remount. Failure preserves draft but disables unsafe writes with actionable feedback.
2. MODIFY src/client/machine-listener.ts, src/client/hub-relay.ts and relevant GUI transport owner. Define a bounded expected-target request field through creation -> serialization -> parsing -> comparison -> stripping -> forwarding. Compare the exact snapshot forwarded; malformed/mismatched claims refuse without upstream call. Absent-field compatibility remains explicit; only negotiated support may be claimed as a fence. Link read-only behavior stays read-only. No new Settings PATCH baseline is added; conflict handling uses the latest observed snapshot and preserves existing last-write-wins semantics for unobserved edits.
3. MODIFY gui/src/provider-workspace/target-drafts.ts, provider-draft-merge.ts, ProviderSettings.tsx, ProviderDetails.tsx, ProviderJsonEditor.tsx and useJsonConfigEditor.ts. Store entry includes ownership/revision/reset generation, tombstones survive pending operations, conditional commits preserve current edits. Deep merge nested pacing maps, preserve own JSON keys, unify conflict state and validate numeric strings. Same-name re-add does not inherit deleted-instance edits. Label fallback strips non-display identity fields.
4. MODIFY gui/src/usage-summary-resource.ts, gui/src/components/AddProviderModal.tsx, gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx, gui/src/pages/use-dashboard-data.ts, Providers.tsx, use-providers-fetch.ts, use-providers-crud.ts, use-providers-oauth.ts, use-target-oauth-state.ts, useProviderAccountPools.ts and useCodexAccountPool.ts. Pass logical identity plus generation through cache/load/dedupe/mutation/completion. Reject stale callbacks before incrementing a newer request sequence; fence before send and before state/toast updates. Include affinity retry, account roster recovery and quota coordinator paths.
5. MODIFY relevant GUI tests and NEW small app/relay regression files if existing files are at caps. New root tests registered in layout and expected shards. MODIFY all affected locale catalogs, docs-site web-dashboard guide and structure/dashboard-and-usage plus source owners for relay if changed. Never raise ratchet caps or commit screenshot evidence to this branch.

## Acceptance activation and observations

- Real App discovery returns A then B at the same relay base: displayed label/config/accounts belong to B; A draft remains parked; returning to A restores it. Same-hub reconnect/key rotation retains logical identity. Verify configure/bootstrap does not erase a just-created valid session or trigger an event loop.
- A request carries expected A while relay current snapshot is B: deterministic refusal with zero upstream requests; matching request reaches A; direct transport and legacy absent-field behavior remain compatible. Test in-flight connection replacement at the forwarding seam.
- A save is pending while edits change, target changes A-B-A, discard occurs, or removal succeeds: only same-instance newer edits survive; stale completions cannot resurrect/reset current drafts, toast on B or use old account ids on B.
- Concurrent saved pacing edits touch different models/subfields: merge both; same-field changes produce explicit resolvable conflict. Concurrent provider addition/deletion and JSON own keys retain correct semantics. Restore uses current saved values. Baseline A-B-A leaves banner, buttons and handler consistent.
- Non-empty invalid RPM/delay/concurrency: validation message, no PATCH, no success notice. Clean external endpoint change updates both field and picker; unrelated save preserves it.
- New target with same provider names refetches all generic/Codex rosters immediately, not after periodic polling. Failed deletes do not remove drafts; confirmed deletes do.
- Synthetic two-target browser exercise uses real App and local relay fixture, no real accounts/homes. Assert request destinations as well as DOM state. Capture changed UI at desktop width; inspect image before publishing to pr-assets. Report precisely which real-runtime or mocked seams were exercised.

## Verification commands and evidence

Commands already demonstrated available: isolated bun test --cwd gui --isolate tests/provider-target-drafts.test.tsx tests/provider-target-drafts-store.test.ts tests/provider-same-origin-api-base.test.tsx tests/provider-first-response-guidance.test.tsx (43 pass on d625); isolated bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/lab/core-lab-boundary.test.ts (63 pass); bun run typecheck/privacy:scan/structure:check exit 0. They directly observe named tests, src type graph, tracked privacy patterns and structure claims respectively.

Additional verifiers to validate before final plan acceptance or use: GUI lint/i18n/build scripts; app-target discovery suites; tests/clients/client-hub-relay.test.ts and client-machine-listener.test.ts for the new transport condition; Codex pool and generic account tests; synthetic browser harness. These additional runs are NOT RUN by main for this cycle. Build/test processes use env -i and temporary HOME/OPENCODEX_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR. Never real ~/.opencodex.

## Responsibility and remaining audit questions

Main owns plan dispositions, phase transitions, integration, fresh final review requests, CI inspection, screenshot upload and maintainer judgment. One isolated implementation child may implement the audited map; no child may push or merge. Architect reflects on this revision; a different reviewer audits it. Detailed unfixed-boundary notes remain in .tmp, not this public plan.

Audit must validate the selected capability/legacy and identity contracts; remaining execution details are session-event recursion, the explicit browser fixture activation and bounded tombstone lifetime. No unresolved question may be converted into an asserted guarantee.

## Revision 2 concrete additions

### Interface chain

- `relayTargetCheck`: created by src/client/machine-api.ts status DTO; serialized by machine status response; parsed/validated in gui/src/api-targets.ts (absent/unknown => legacy); consumed by the target-aware mutation wrapper and notice. Existing status consumers tolerate the optional field.
- Expected-target header: created from captured logical target in GUI transport; serialized only for machine relay requests; parsed and bounded at src/client/machine-listener.ts / hub-relay.ts; consumed by comparison against HubRelayTarget, then stripped before forwarding. Missing field preserves legacy callers; malformed/mismatch refuses the opting-in request. Direct requests do not carry this internal relay header.
- Target generations and entry revisions: created in discovery/store owners, in-memory only (serialization/deserialization N/A), consumed by config/cache/roster/mutation/save completion; never substituted for logical draft identity.

### Added witnesses and proposed test files

NEW gui/tests/api-target-lifecycle.test.tsx: real discovery/session/pair/focus lifecycle, same-origin relay remap, key rotation stable identity, zero standalone polling, event recursion bounded. NEW tests/clients/client-hub-relay-target.test.ts: capability DTO, exact-match forwarding, mismatch/invalid/no-header behavior, internal header stripping, replacement during dispatch uses one snapshot. Register root test in layout and expected shards.

MODIFY gui/tests/provider-target-drafts.test.tsx and provider-target-drafts-store.test.ts: entry reset/removal/mount CAS, ABA, same-instance edits, nested pacing merge, current Restore and coherent conflict controls, invalid numeric values, own `__proto__` property and label fallback. MODIFY gui/tests/api-targets.test.ts, use-providers-crud-update.test.tsx, relevant provider account pool and codex-account-pool-behaviour/stale-refresh/handlers tests: per-consumer late-response and no-old-id-on-new-target assertions.

NEW gitignored .tmp/8325-pabcd/browser/ harness: two local synthetic servers plus the real relay route and real App, target change while a draft is parked and a request is pending; inspect recorded request destinations and visible target/values. Do not commit harness screenshots to this branch. Final screenshot upload is only to pr-assets with immutable commit link.

First demonstrate every new witness red on d625 or its documented narrow ablation; record command, SHA, exit and failure. Then run the unchanged witness on the fix. The architecture review must validate test command availability and paths before B; new tests cannot be honestly reported as already executed in P.

### Enforcement and compatibility statement

Tier: server request precondition plus client early warning. Executing surfaces: expected-target-v1 relay handler and GUI target-aware mutation wrapper. Known bypass: legacy caller omits optional field, legacy relay ignores unnegotiated field, or a client intentionally supplies a different target. Residual risk: legacy preflight has a read/send race, and a target claim is not authentication. Wording downgrade: legacy is explicitly a preflight check, never atomic enforcement. Final layer for opted-in supported relay requests: compare against the same connection snapshot used to forward; no claim of protection for old endpoints. Existing authentication/CSRF stays mandatory and unchanged.

L-A UX tests: supported listener shows normal target-aware saving; legacy listener preserves existing flows with the explicit target-scoped limitation notice; mismatching preflight sends no mutation, retains draft and triggers discovery. Correct the dashboard guide's unconditional guarantee and old machine-key identity wording. New fields must not appear in CLI output or modify persisted configs.

## Revision 3 audited amendments (supersede conflicting optional choices above)

### Mutation capture API and field chain (D2/D11)

MODIFY gui/src/api.ts and gui/src/pages/use-providers-crud.ts plus the other mutation consumers already listed. Introduce an in-memory immutable capture `{apiBase, targetKey, origin, requestGeneration}` at save/action start. Creation is the UI/hook action boundary; serialization adds the expected-origin header only for a captured relay request with negotiated support; deserialization is bounded relay parsing; consumer is the same HubRelayTarget snapshot later passed to forwarding. Captured authority is checked before send and before apply. A live sessionHeaders lookup may supply authentication only after the captured target is verified; it cannot replace the captured expected target with the new target.

A target switch between click and actual fetch must result in no mutation to the new target, not a newly labeled request. A switch after send must reach either the captured target or the relay's no-forward 409. Test both barriers deterministically. The relay check precedes readBoundedRelayRequestBody; duplicate, comma-combined, invalid and oversized expected-target values are rejected without reading/forwarding the body. No expected-link mutation field is added: the link branch is read-only, with that invariant tested. Absent headers retain older-caller behavior.

### Conflict resolution (D5)

MODIFY useJsonConfigEditor.ts and ProviderJsonEditor.tsx with tests for edit-to-resolve and still-conflicting edits. On a conflicting rebase, show the partial merge: adopt non-conflicting external values, preserve user values only at conflicting paths, adopt the newest observed baseline and retain unresolved conflict metadata. A user can resolve by editing individual paths, not only by discarding all edits. Revalidate at Save and retain unrelated concurrent values. A-B-A saved-baseline changes must leave banner, Save button and handler in agreement. Settings's conflict promise is limited to the latest observed snapshot, not an atomic PATCH baseline guarantee.

### Remaining cache and completion map (D7/D8/D11)

MODIFY gui/src/usage-summary-resource.ts to accept logical target identity for provider usage cache keys without changing other callers' default contract. MODIFY useCodexAccountPool.ts module seeds, initial-load key, usage resource, generations and all action completions to use the logical identity. MODIFY Providers.tsx preset and roster recovery keys, and generic pool bootstrap keys. Tests cover same relay URL with different target data, immediate refetch, seed isolation across remount, and late action no-state/no-toast on another target. CRUD remove/disable/default completions are included.

### Numeric authority, lifetime and ownership

Use src/config/schema/leaf-validators.ts as the existing accepted pacing bounds for top-level, model and key fields; empty text is unset. Do not add guessed stricter limits. Tombstone/revision metadata remains in page memory with one current record per visited target/provider and explicit eviction that cannot resurrect a still-pending completion; audit the bound and lifetime before implementation.

Source-of-truth review fan-out includes structure/runtime.md, remote-link.md, fallback-policy.md and gui-and-management-api.md in addition to dashboard-and-usage.md. Update only contracts/explanations actually changed. Register client-hub-relay-target.test.ts in scripts/test-layout/layout-clients.json and tests/fixtures/test-layout-expected.json.

### Browser and verifier activation

Use `bun run build:gui` for the exact candidate, then serve its real App bundle with two synthetic local HTTP target servers and the actual machine relay handler. The fixture changes its live connection from A to B while keeping the relay URL fixed. Trigger the real discovery lifecycle (pair/session/focus or negotiated mismatch); assert no A mutation reaches B and A draft survives return. Preserve same-origin/session handling and record simulated seams. No external production hubs/accounts are used.

Explicit existing verifier commands: `bun run lint:gui`, `cd gui && bun run lint:i18n`, `bun run build:gui`, root typecheck/privacy/structure, focused GUI and client relay tests. Independent A verified existing relay/machine suites 41 pass, GUI CRUD/editor 18 pass, Codex pool 47 pass, lint/i18n pass at d625. New test files, build and browser activation are NOT RUN in this plan; their failure-before-fix and success receipts are B/C work, not invented evidence.

## Revision 4 exact interface and activation details

D5: `threeWayMergeJson` returns the partially merged value together with conflict paths. Non-conflicting current server values are present in the editor after Keep; conflicting paths retain user values and are marked unresolved. The editor records the resolution baseline and user-change intent rather than reinterpreting the untouched old whole document as a new edit. On text edits, parse and recompute conflict/resolution state; explicitly edited conflict paths can be resolved, while untouched paths remain flagged. Save stays disabled while unresolved and the handler also checks the same predicate. Once resolved, Save re-merges against the latest observed server state and sends that merged next plus its corresponding baseline. A later external change reintroduces conflicts as needed. Tests assert the editor's partial value, preservation of concurrent provider additions, edit-to-resolve, still-conflicting edits and a second external change before Save.

D2/D11: `targetFetch(capture, input, init)` in gui/src/api.ts validates the immutable capture before entering installApiAuthFetch/authenticated fetch. Capture is created by the UI/hook action at click/save start, before any await. Its requestGeneration changes on a logical target transition, including A-B-A, not on a successful same-target refresh or session token rotation. The current target must still match the captured base/key/origin before authentication headers are attached. For negotiated relay support the header comes only from capture.origin. No caller can silently refresh its capture in a retry; an explicit new user action is needed after target change. Requests to legacy relay perform the documented fresh status preflight with the same original capture and then invoke authenticated fetch, with the acknowledged TOCTOU limit.

Bound expected-target to 512 UTF-8 bytes; accept only a canonical HTTP(S) origin without userinfo/path/query/fragment and reject duplicate/comma-combined values. This bound applies only to the opt-in protocol field, not existing configured base URL storage. Reject before body read. Legacy notice appears once per page/target when attempting a relay mutation without negotiated capability: "This proxy checks the save target before sending, but cannot verify it atomically. Update the proxy for target-bound saves." Localize this intentional compatibility notice; it carries no key or credential.

D7/D8/D11 call map: Providers.tsx, AddProviderModal.tsx, ProviderWorkspaceShell.tsx, use-dashboard-data.ts and useCodexAccountPool.ts pass logical identity to usageSummary30dResourceKey. Keep its default behavior for callers without a target context. Both Providers and AddProviderModal preset keys include identity. Update gui/tests/dashboard-contracts.test.ts source assertions to the actual contract and add behavioral tests; do not remove an invariant merely to change its spelling. Add usage summary resource, Add Provider modal and dashboard target-scope suites to focused validation.

Browser fixture remap: run an isolated client machine listener on one fixed loopback port, initially configured for synthetic hub A; terminate and re-create that listener on the same port with synthetic hub B while leaving the browser and two hub fixtures running. Reconnect/response timing is controlled by fixture barriers, not sleeps alone. Verify the relay URL is byte-for-byte unchanged, the real App rediscovery updates identity/session readiness, and destinations recorded by A/B match the original action capture. Separately exercise the relay handler's immutable-snapshot seam with a controlled connection change between capture and forwarding. Same-target restart/key rotation must keep drafts; A-B-A must fence old callbacks while restoring the parked draft.

## Build entry clarifications after revision-4 audit PASS

- Include gui/src/pages/Dashboard.tsx as the App-to-useDashboardData targetKey wrapper.
- Lifecycle metadata is bounded to one current record per visited target/provider during the page lifetime, plus authority held by currently pending requests; there is no persistent store or arbitrary eviction that revives stale work.
- useApiTargets owns a single in-flight discovery plus request-generation comparison; event bursts coalesce, and same-target session refresh cannot recursively schedule discovery indefinitely.
- Dependency edges: discovery identity (1) precedes store lifecycle integration (3), consumer wiring (4), then acceptance/docs (5). Relay protocol (2) is independently implementable but integration (4) consumes its negotiated contract. One writer implements these in that order.
- Mutation capture also records transport; it is checked with base/key/origin/generation before current authentication is read. No late live-transport lookup may silently retarget the request.
- Settings conflicts concern concurrent saved values already observed by this dashboard. No atomic PATCH precondition is claimed.
- Fixed-port browser fixture restart creates fresh machine management auth state; the real App must re-bootstrap its machine session and reconcile shared readiness. No retained test token is injected to hide session recovery.

Audit receipt: same independent reviewer task 8325-audit-plan-r4 concluded VERDICT: PASS, four earlier blockers closed. Seven nonblocking clarifications above are folded without changing the selected architecture. Final code reviews and actual E2E/CI remain outstanding.

## Revision 5: capture ownership at the data owner and dialog boundary

The e207 review found that the transport was fenced but the capture was created one
level too late. This revision records the corrected ownership, without changing the
selected architecture.

- A rendered surface owns its capture. `useRenderTargetCapture(apiBase, targetKey)`
  creates it on the render that last saw that target identity and replaces it only when
  the identity changes. A module target change that has not re-rendered the surface
  cannot retarget its next action.
- `onUpdateProvider(name, patch, capture?)` is the typed callback. The form passes its
  render capture; `ProviderDetails` injects its own for Overview notes and the xAI
  toggle; `useProvidersCrud.updateProvider` uses the passed capture and never replaces
  it with a live one. Account mode captures before its confirmation dialog.
- Every mutation and read owner creates its capture at render: the account pool,
  OAuth, Add Provider OAuth, Kiro, Codex pool, auto-switch and Anthropic pool hooks.
  The logical target is threaded through ProviderAuthPanel, the Kiro dialog, the
  Anthropic pool card and CodexAccountPool. A parameterized render-gap suite
  exercises every owner.
- The Settings leave dialog captures its target when it opens, closes on a target
  change, and uses the form owner-checked discard.
- A remove confirmation captures when it opens and refuses after a target change,
  including A-B-A. Key remove/add/alias guard every completion. The add-key form and the
  Add Provider completion do not survive a switch. Kiro polls with the session capture
  and ends when it is stale. CodexSet threads the logical target.
- The render-owned capture changes only where the capture is created. Every stale
  capture is still refused before authentication or fetch; there is no send exception.
  After the identity check, the relay capability is read from the live target, so a
  same-identity downgrade uses the fresh legacy preflight and a downgrade with a target
  change refuses before fetch. This corrects an implementation drift from plan
  revision 4; the architecture itself is unchanged.

