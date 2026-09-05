# 050 — Remote-hub Claude Desktop alias routing

Status: proposed implementation roadmap, authored during the D-lane docs-only P cycle. No implementation or runtime verification is claimed. Source baseline: `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c` (2026-09-06 KST). Owner: D; main owns orchestration, 000/010, stack publication and integration.

## Loop specification

- Archetype: spec-satisfaction repair; C3 routing/integration slice, with C4 review of the additive data-plane response and credential-consuming client call.
- Trigger: public issue [#3646](https://github.com/lidge-jun/opencodex/issues/3646), captured in `.tmp/d-delivery/issue-3646.json`. Reporter observed dated Desktop aliases sent unchanged to Anthropic on a remote hub. This is a report plus source-supported mechanism, not a reproduced current-head result.
- Goal: applying Desktop on an already connected client writes the hub origin and exact hub-issued model IDs; those IDs select the intended upstream on the hub. Unknown managed aliases produce an actionable 400 without inference traffic.
- Non-goals: thinking/redacted-thinking replay, cache retention, native subscription authentication rules, quota repair, family redesign, changes to connect/pairing/rotation permissions, automatic upload of client profiles, or provider/catalog reorganization. No changes to B's Fable alias encoding.
- Verifier: CI or a main-authorized remote runner executes the focused files and process-separated regression below against the published head; Desktop config bytes and captured upstream URL/model are the oracle. No local tests, suites, typecheck, build or live server are authorized in this task.
- Stop: both hub snapshot application and inference-route proof pass; stale managed aliases cannot escape to upstream; canonical native and B3649 paths retain their behavior. Original #3646 remains partly unresolved because its thinking/cache requests are separate.
- Memory artifact: this document and main's 000/010 records; implementation/CI receipts belong in `.tmp/d-delivery/` until main records verified public outcomes.
- Outcomes: DONE for the alias slice only; NOOP requires current-head reproduction to prove all slice behaviors already work. BLOCKED requires an external prerequisite; no current implementation or CI evidence is available yet.
- Escalation: main reclaims after two distinct failed worker packets; any new delegated write scope is a P amendment. A discovered undisclosed security issue goes only in `.tmp/d-delivery/`, and must not be added here.
- Resource scope: docs worker writes only this file and performs source/API reads. No goals, orchestration, Git/GitHub writes, tests or credential-bearing live probes. Main must bind implementation runner/time/cost limits before B; this document does not enlarge that authority.

## Existing owners and necessity decisions

Do nothing leaves the mismatch. Configuring an identical profile manually on every machine is a workaround, not an apply contract. Deleting Desktop aliases breaks its picker contract. Reuse the hub's generation/discovery path and the client's connection/token readers; do not introduce a profile-upload service or infer a route by reversing a date hash.

| Current owner / exact anchor | Current behavior and consequence |
| --- | --- |
| `src/cli/claude-desktop.ts:44` (`applyProfile`) | Enables the local integration, builds local state and saves a local profile before checking for a local live process. Line 59's delegated apply targets the local runtime. Line 102's offline writer uses the local port/key. Connected-client handling must branch before these operations. |
| `src/cli/runtime-api.ts:45` (`runtimeBaseUrl`) | Resolves a live local proxy; not a remote hub management client. Do not retarget this shared function. |
| `src/client/state.ts:40` / `src/lib/service-secrets.ts:31` | Existing connection-state and service-token readers. `src/client/connect.ts:497` already proves token ownership by matching fingerprints before remote catalog download. Reuse that pattern. |
| `src/claude/desktop-profile.ts:86,149,161,171` | Validates date aliases, allocates one of 365 slots, preserves stored assignments and probes on collisions. Independent reconciliation on a client can choose different IDs from the hub. |
| `src/claude/desktop-3p.ts:190,292,304,316` | Collects entries and reverse-map, installs a process-local registry, and resolves it. Real `anthropic/claude-*` entries deliberately remain identity-preserving. |
| `src/claude/desktop-3p.ts:333,563,626` | Config generation hardcodes loopback; writer preserves foreign keys, updates metadata and uses existing atomic replacement/rollback behavior. Retain the writer transaction. |
| `src/server/index.ts:1349,1479` | Existing authenticated `/v1/models` GET, origin checks and Anthropic discovery branch. The latter builds the hub registry from the hub's catalog and profile. |
| `src/cli/index.ts:490` | Production CLI startup installs the registry. Calling `startServer()` directly in a test is not equivalent to this startup path. |
| `src/claude/inbound-model-options.ts:39` | Resolution order: strip `[1m]`, readable alias, Desktop registry, exact map, dateless map, classifier, unchanged ID. Unknown managed IDs currently fall into later choices. |
| `src/server/claude-messages.ts:635,675,695,713` | Messages normalizes/directs selectors, resolves during debug capture, then checks native passthrough inside a try with Anthropic 400 mapping. |
| `src/server/claude-messages.ts:1050,1092` | Count-tokens resolves and checks passthrough after its body-read try; adding a throwing resolver without extending this error boundary would become an uncaught error. |
| `tests/claude-integration/claude-messages-endpoint.test.ts:77` | `mockChatUpstreamCapturing()` captures actual upstream JSON; reuse it to prove route selection instead of checking a decoded string only. |
| `structure/09_client-integrations.md` | Existing source of truth: client config ownership, direct remote model traffic and local integration lifecycle. Add only the Desktop remote-apply contract. |

Pre-write searches performed: `resolveDesktop3pAlias`, `buildDesktop3pRegistry`, `buildClaudeDesktopState`, `desktopProfile`, `runtimeRole`, `downloadClientCatalog`, `readClientConnectionState`, `wantsNativePassthrough`; mapped `src/claude` with `cxc map`. No new routing registry or second writer transaction is needed.

## Chosen contract

The hub owns the routing IDs and shared family profile; the connected client owns its Desktop file and connection credential. Remote apply downloads exact hub-generated Desktop entries instead of uploading local assignments or regenerating IDs from the local catalog.

Extend the existing authenticated model-discovery route with an explicit opt-in response:

```text
GET /v1/models?ids=desktop&format=desktop-config
Accept: application/json
anthropic-version: 2023-06-01
x-opencodex-api-key: <existing connected-client data credential>

200 { "version": 1, "models": [Desktop3pModelEntry, ...] }
Cache-Control: no-store
```

This response contains no credentials, upstream URLs, raw profile assignments or admin state. It uses the same catalog visibility, native selection and hub profile as ordinary Desktop discovery. Existing requests without `format=desktop-config` keep their present wire shape. A format request with incompatible `ids=cli` or `client_version` returns 400; the exact format also selects the Desktop branch independently of User-Agent. Version is a snapshot format discriminator, not a new pairing protocol version.

Generate entries and install their inverse map together in the same synchronous call. Do not build a registry and then independently reconcile another list. Use `generateDesktop3pModels` with the already-loaded `desktopNativeSlugs`, `goOrdered`, hub profile and `nativeContextLimits(config)` at the existing discovery branch. With no stored profile, retain the existing hash IDs. With a stored profile, use its stable date assignments. Do not silently create or overwrite the hub profile on GET.

Remote apply writes the normalized `state.value.serverUrl` as the gateway origin and the validated local service token as the gateway key. Static/hybrid modes copy snapshot entries exactly; discovery mode still fetches/validates a snapshot before writing, but omits `inferenceModels` as today. Remote failure must leave the existing Desktop config unchanged, with no fallback to local models, local port, or a client-generated decode table.

Existing clients with stale date assignments must reapply and reselect the hub-issued entry. The fix cannot recover an arbitrary client's untransmitted date-to-route table. To preserve a deliberately customized family profile, an operator configures that profile on the hub using the existing management profile mechanism; data credentials do not acquire profile-write authority.

## Diff-level implementation map

All entries below are planned; this docs task changes none of them. Preserve current exports and callers. Keep one semantic alias slice in the D stack; if implementation exceeds a reviewable diff, main splits the hub contract below the client consumer with dedicated amended decade docs before implementation, not two hidden cycles in this page.

### MODIFY `src/claude/desktop-3p.ts`

1. Extract the body of `writeDesktop3pConfig` after generated-config construction into private `writeDesktop3pConfigObject(generated: object)`, retaining path resolution, foreign-key preservation, selected-profile selection, fingerprint generation, metadata write and rollback byte-for-byte. The existing export calls it with `generateDesktop3pConfig(...)`.
2. Add exported `writeRemoteDesktop3pConfig(options: { baseUrl: string; apiKey: string; mode: Desktop3pConfigMode; models: Desktop3pModelEntry[] })`. Build the same owned envelope with the supplied origin; use `assertDesktop3pModelsValid` before the writer. This function must not call `collectDesktop3pModels`, `reconcileDesktopProfile` or install any registry in the client process. No HTTP and no token lookup in this writer.
3. Add `isUnresolvedDesktop3pAlias(id: string): boolean` next to `resolveDesktop3pAlias`, recognizing only the emitted namespaces: `claude-opus-4-8-2026MMDD`, `claude-opus-4-8-[a-z][a-z0-9]{2}`, and legacy `claude-opus-4-[a-z][a-z0-9]{2}`. Reuse/export the date-shape predicate from `desktop-profile.ts` if necessary, instead of duplicating its calendar validation. Return false for a registered alias or an explicitly published real Anthropic model ID.
4. Extend the private collection result with `realAnthropicIds: Set<string>` populated from the same candidates. Keep that companion set of exact real `anthropic/claude-*` IDs when installing each collected registry, assigned together with the registry in BOTH `buildDesktop3pRegistry` and `generateDesktop3pModels`. Do not infer all dated Claude IDs are synthetic. An explicit genuine catalog ID is identity-preserving; unrelated dates/families must not match the managed namespace.
5. Preserve registry exclusions for real Anthropic routes, stable collision ordering, canonical native IDs, family defaults and 1M fields. No changes to allocation, hashing or Fable encoding.

### MODIFY `src/server/index.ts`

At `/v1/models` after existing admission/origin checks, parse the explicit format and reject conflicting query selectors. Include format requests in the Anthropic branch condition. In that branch, before ordinary `buildAnthropicModelInfos`, return `{version:1, models:generateDesktop3pModels(...)}` for this format. Keep current disabled-Claude behavior explicit: return versioned empty models for this format, ordinary `{data:[]}` for ordinary discovery. The client treats an empty snapshot as non-applicable and preserves its old config.

Use the existing no-store response/header convention. No management auth changes, no new startup await, no `/api/*` relay expansion. Ordinary registry rebuilds and the snapshot path must share exactly the same candidate set and profile; pass context caps consistently. No route-specific provider facts.

### MODIFY `src/client/hub-client.ts`

Add `downloadDesktop3pModels(serverUrl, admissionToken, options = {})` returning `{version:1, models: Desktop3pModelEntry[]}`. Reuse `normalizeHubOrigin`, `fetchBounded`, `boundedText`, `parseJson`, `jsonCompatibleContentType`, `HubClientError` and the existing download size/timeout policy. GET the exact opt-in URL above; redirects remain refused. Reject non-2xx, 304, wrong content type, unsupported version, malformed/oversized/empty entries, duplicate names, invalid family/boolean fields and malformed labels. Validate unknown JSON structurally before `assertDesktop3pModelsValid`; that helper alone assumes typed inputs. Copy only documented entry fields into the returned value.

Use distinct errors such as `desktop_snapshot_unsupported`, `desktop_snapshot_invalid` and `desktop_snapshot_http_<status>`; never put the key or response body into messages. An older hub returning `{data:...}` is unsupported, not a successful empty list. No new credential storage, caching or dependency.

### MODIFY `src/cli/claude-desktop.ts`

Add private `applyConnectedDesktopProfile(mode, connection, deps)` next to `applyProfile` and optional dependency seams for remote downloader/writer using their real function types. At the beginning of `applyProfile`, inspect connection state. Connected state takes this helper before `buildClaudeDesktopState`, saving profiles or looking for a local proxy. Invalid/mismatched client state fails explicitly; only standalone/disconnected takes the existing path.

The connected helper reads the service-token state and compares its fingerprint to the connection, as `syncConnectedClient` already does; a pending rotation is reported for recovery, not guessed around. After token validation, enable the Desktop integration using the existing desired-state API BEFORE awaiting the snapshot download; then re-read connection identity, token ownership and desired enabled state immediately before writing. An OFF transition during the download must remain OFF, so never unconditionally re-enable after the await. If the connection or token changed during download, abort and preserve the old file. Pass the snapshot verbatim to `writeRemoteDesktop3pConfig`. Preserve policy warning and CLI success/failure shape. No runtime management POST and no local profile reconciliation in this branch.

Also branch the command's apply invocation BEFORE its current preliminary `buildClaudeDesktopState`. Route `import --apply` on a connected client to an explicit explanation that remote apply consumes the hub profile; do not save a local import and then claim it changed the hub. Local `show`/export remain local views and must be labeled as such when connected; `move`/`default` remain local edits with the same clarification. No new remote profile editing UI or data-plane writes.

### MODIFY `src/claude/inbound-model-options.ts`

Keep readable alias and registered Desktop alias precedence. After the exact `modelMap` lookup but BEFORE date-stripped mapping and classifier fallback:

```diff
 const exact = map[model];
 if (typeof exact === "string" && exact.length > 0) return exact;
+if (isUnresolvedDesktop3pAlias(model)) {
+  throw new AnthropicRequestError(
+    "Unknown Claude Desktop alias; reapply the Desktop profile from the connected hub",
+  );
+}
 const stripped = model.replace(/-\d{8}$/, "");
```

Import the existing error class from `inbound-records`. Exact operator mappings remain deliberate recovery overrides; a broad dateless mapping or classifier must not silently substitute a different route for a missing managed alias. Keep `[1m]` stripping first. Do not strip an unknown date and send base Opus. Real bare Opus/Haiku and configured real dated Anthropic IDs retain their native behavior.

### MODIFY `src/server/claude-messages.ts`

Messages already catches `AnthropicRequestError` across selector normalization, debug resolution, native decision and translation. Confirm every new throw stays inside that boundary. For count-tokens, extend a bounded `try/catch` around fast decoding, debug resolution and `wantsNativePassthrough`; return `anthropicErrorResponse(400, err.message)` for this existing error type and preserve ordinary unexpected-error handling. Do not catch everything as success or bypass the resolver for token counting.

Coordinate exact ordering with B3649's canonical Fable selector normalization. The managed-alias guard must not classify a valid reversible Fable selector as a missing Desktop date/hash, and the normalized Fable model must still reach both native endpoints as canonical Fable. No edits to thinking replay, cache policy or subscription admission.

### Tests and documentation (planned MODIFY unless noted)

- `tests/clients/desktop-3p.test.ts`: snapshot writer keeps exact names, flags and hub origin; no local registry installation; owned config metadata/foreign fields and write-failure behavior stay intact.
- `tests/clients/desktop-profile.test.ts`: only if exporting/reusing the date-shape predicate; preserve existing profile allocation fixtures.
- `tests/claude-integration/claude-desktop-cli.test.ts`: connection/token identity, no local runtime call, snapshot errors and race-before-write; invoke the CLI handler so the pre-apply local-state bug cannot hide.
- `tests/claude-integration/claude-messages-endpoint.test.ts`: concrete route/guard rows below and format endpoint contract; reuse capturing upstreams and isolated-home conventions.
- `tests/claude-integration/claude-native-passthrough.test.ts`: canonical native/dated exemption and B Fable coexistence. Extend existing inference capture, not a resolver-only assertion.
- NEW `tests/claude-integration/claude-desktop-remote-hub.test.ts`: process-separated hub/client regression below. Register it in `scripts/test-layout/layout.json` explicit mapping AND `tests/fixtures/test-layout-expected.json`.
- `docs-site/src/content/docs/guides/claude-code.md:128`: explain hub-owned IDs, remote apply and reselect migration, local versus hub profile views and unsupported-old-hub failure. Preserve the separate thinking/cache limitation.
- `docs-site/src/content/docs/reference/proxy-formats.md`: additive opt-in snapshot response, compatibility and error semantics.
- `structure/09_client-integrations.md`: remote Desktop apply's origin/credential/list ownership and process-local decode boundary. Translations must not contradict the new remote behavior; main assigns exact locale follow-up only after reading their existing sections.

## Acceptance and activation matrix

Run these only on CI/main-authorized remote infrastructure. Each row names a state that reaches the intended branch. A 200 response or a display label alone is insufficient.

| ID | Constructible activation | Observable required result |
| --- | --- | --- |
| R1 | Separate hub and client homes/processes; hub has two loopback mock chat providers with DISTINCT IDs, a stored date profile and native entries; client has deliberately different local assignments. Fetch snapshot via the connected data key, apply through CLI, then submit the written `inferenceModels[].name` to hub `/v1/messages`. | Written origin is hub origin, wire ID equals hub snapshot ID; only the selected mock captures a request with its literal expected model. Decoy/default/Anthropic capture counts are zero. Assert upstream host/path AND body model. |
| R2 | Same setup, stop and restart the actual hub CLI against the same saved config, submit the previously written date ID BEFORE any model GET. | Same intended upstream/model. This proves startup registration rather than a warm discovery side effect. Use the real `src/cli/index.ts start` path with isolated home, not a direct `startServer` call plus test-installed registry. |
| R3 | Hub has no Desktop profile; client has a locally saved date profile. Remote apply uses hub snapshot hashes. | File names equal the returned hashes; submitting one reaches its expected upstream. No invented date profile is saved to hub. |
| R4 | Hub knows one date alias; submit a DIFFERENT valid date in the managed namespace, with no exact modelMap. Run once with no fallback, once with distinct dateless and classifier mappings configured. | Both messages and count-tokens return Anthropic-shaped 400, all upstream captures zero. Setting the fallbacks makes this row detect accidental fallback-before-guard behavior. |
| R5 | Unknown current/legacy managed hash; separately an exact operator modelMap entry to a third distinct target. | Missing hash rejects; exact map reaches precisely that third target. Expected IDs are fixture literals, not calculated by the resolver under test. |
| R6 | Publish a real dated `anthropic/claude-*` model through the real hub catalog; send it with the existing native-passthrough test credential. Also send canonical bare Opus and Haiku. | Existing native upstream path and original model preserved. Unknown synthetic dates still reject. Do not match every `-YYYYMMDD` string as managed. |
| R7 | With B3649 integrated, exercise canonical Fable, its actual reversible 1M selector with and without `[1m]`, and a registered Desktop date/hash carrying `[1m]`; cover messages/count-tokens. | Canonical Fable goes to native with the intended beta/identity behavior; Desktop alias selects its routed target. No new false 400 or suffix leakage. Read B's actual helper/signature before implementing this row. |
| R8 | Token absent or fingerprint differs; disconnected/invalid client state; rotation pending. | Explicit failure before snapshot network call or writer; old Desktop file bytes unchanged. Standalone local apply remains supported. |
| R9 | Hub returns old `{data:...}`, 401/403/404/500, redirect, invalid JSON/version/entry fields, duplicate names or empty snapshot. | Failure explains reapply/upgrade as appropriate; no local fallback, local profile save, credential echo or Desktop file replacement. |
| R10 | Suspend remote response via an explicit deferred promise; change connection identity/token or desired state before releasing it. | Immediate pre-write reread rejects/skips, old Desktop file unchanged. No timing sleeps. |
| R11 | Request ordinary OpenAI/Anthropic/CLI `/v1/models`, then snapshot format, then ordinary discovery again. | Original shapes retained, snapshots bounded/versioned/no-store; all published aliases still decode to the same targets. Explicit conflicting query format rejects. Missing credential/origin uses existing admission policy. |
| R12 | Remote writer applies static/hybrid/discovery to a temp Desktop library containing foreign profile keys. | Static/hybrid preserve exact server entries and existing foreign keys; discovery omits static entries but targets hub; existing metadata and atomic write semantics retained. |

R1/R2 must isolate process globals: do not invoke client generation and hub handling in the same imported module instance. Launch processes with isolated OPENCODEX_HOME/Codex/Desktop paths and explicit loopback ephemeral listeners on the remote runner. Use stdout readiness or `/readyz`, bounded deadlines and deterministic teardown. Mock external providers only; use real request handlers, authentication and alias generator. Install no real credentials and send no billable request. Existing native-passthrough fetch capture may be reused for the distinct Anthropic sink; fail any unexpected external URL.

Planned focused command on the remote runner, not here:

```sh
bun test tests/clients/desktop-3p.test.ts tests/clients/desktop-profile.test.ts tests/claude-integration/claude-desktop-cli.test.ts tests/claude-integration/claude-desktop-remote-hub.test.ts tests/claude-integration/claude-messages-endpoint.test.ts tests/claude-integration/claude-native-passthrough.test.ts
```

Main obtains current-head CI typecheck/full relevant suite, layout guards and privacy evidence according to repository policy; checks awaiting approval or skipped jobs are not passes. Optional additional oracle experiment (not a completion prerequisite): prove it on remote infrastructure by disabling the new remote apply branch (R1 must fail) and the missing-alias guard (R4 must fail), then restore and verify. Do not claim RED/GREEN without those artifacts.

## Integration, stale checks and open gates

- Main confirmed B3649 only normalizes the native Fable picker alias in `src/server/claude-messages.ts`; preserve that normalization and consume its landed implementation.
- [B #3649](https://github.com/lidge-jun/opencodex/pull/3649) was read through `gh pr view` on 2026-09-06: its diff owns `src/claude/model-info.ts`, `src/server/claude-messages.ts` and model-info/native-passthrough tests. Coordinate B first or explicitly rebase the shared handler; this lane does not change `model-info.ts` or reimplement its native selector. Contributor test counts in that body were not independently verified here.
- Re-read current implementations at this phase's P: all anchors refer to the baseline above. D's preceding changes and B's merge can move handlers/tests. In particular, verify native-ID exemption construction and absence of a new startup await before adding branches.
- Hub snapshot using existing hash IDs when no profile exists is deliberate. Existing stale client-only date mappings are not reconstructible; reapply is the migration. If keeping all historical IDs without reselect is required, that is additional identity persistence/versioning work and needs an amended plan, not a date-strip fallback.
- Lifecycle boundary: this change reuses Desktop's existing writer/enable semantics. It does not add Desktop to `OcxConnectedClientId` or promise `ocx disconnect` newly restores this profile. Document the existing Desktop remove/disable mechanism only after confirming its current commands; do not invent a disconnect guarantee.
- Implementation gate: independent review must confirm the additive snapshot disclosure fits current model-discovery policy and the exact native date exemption preserves real Anthropic IDs. No new security finding is claimed in this document.
- Completion/closure: use “Refs #3646 — alias-routing slice” rather than automatic `Closes #3646`. After dev ancestry proves this slice landed, main can close the implementation PR immediately, but #3646 can close only after the distinct thinking/cache request is explicitly tracked elsewhere or resolved. Do not claim the whole issue fixed by an alias-only patch.
- Verification performed in this docs task: read the supplied issue capture, current source and adjacent tests; read-only PR #3649 lookup; document inspection. No tests, typecheck, code edits, commits, pushes, GitHub mutations or FSM/goal operations.

## Roadmap lock clarification

The implementation cycle certifies the published candidate; final dev-ancestry and source disposition stay mandatory in the landing work-phase. Before closing #3646, preserve the separate thinking/cache request in an existing exact-scope issue or a templated follow-up, link that disposition explicitly, and do not claim this alias fix repairs cache behavior. The owner authorized issue/PR closeout after dev integration.
