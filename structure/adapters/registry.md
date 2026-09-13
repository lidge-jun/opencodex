# Adapter Registry Authority

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts.

## Decision

Runtime adapter construction has one authority: `src/adapters/registry.ts`.

The OpenCode Go [chronological instruction exception](../providers/chat-compat.md#opencode-go-chronological-instructions)
uses the provider registry's destination identity inside the Chat adapter; it adds no adapter factory.

`src/server/adapter-resolve.ts` may resolve a provider/model onto an adapter id, but it does not maintain a second adapter factory inventory. The selected persisted/configured adapter id remains an untrusted string until the registry lookup succeeds. Unknown ids fail with the existing `Unknown adapter: <id>` error instead of widening configuration types around a closed compile-time union.

## Semantic inheritance is not constructor inheritance

Some adapters share another adapter's routed-tool semantics while retaining independent runtime construction:

- `azure` and `azure-openai` inherit the `openai-responses` contract.
  The inherited contract includes Meta Muse's host-gated 64-character tool-name alias when the
  constructed send URL is `api.meta.ai` (`src/responses/muse-tool-name-alias.ts`).
- `mimo-free` inherits the `openai-chat` contract.
- `cursor` stays direct because its `runTurn` transport and gated native-file fallback are distinct.
- `devin` is direct for a related reason. It streams Cognition's
  `ApiServerService/GetChatMessage` over Connect-RPC from `runTurn` with hand-written protobuf
  framing, so like Cursor it never travels the `buildRequest`/`parseStream` path. Login is
  import-first: the installed CLI's own `credentials.toml` holds an ordinary
  `devin-session-token`, the same credential `RegisterUser` mints for a browser sign-in, so
  `devin` imports that token when one exists and falls back to the Auth0 browser flow when it
  does not. `devin-cli` survives only as a deprecated alias — `ocx login devin-cli` routes to
  `devin`, and a startup merge migration rewrites any saved row still keyed under the old
  provider id, so the registry carries one Devin provider, not two.
  `AdapterFactoryContext.providerId` still tells the shared adapter which configured row it is
  serving: the Cognition tenant is recorded on the credential, not in the registry, so the
  adapter has to know the row before it can resolve a host. That adapter advertises bare local
  tool names to Cognition, so `runTurn` also owns a request-scoped return map from each unique
  bare name to the canonical Codex namespace identity. Unknown names remain subject to the shared
  undeclared-tool guard; duplicate bare names fail before dispatch rather than selecting a request
  tool by declaration order. Canonical identities are registered in that map as well, because the
  adapter accepts them on return. One tool's canonical identity can be another tool's advertised
  local name, and resolving that name to either owner would dispatch the call to a tool the caller
  may not have named, so it is treated as ambiguous and fails before dispatch too.

  There is no second Devin transport. An Agent Client Protocol adapter that spawned a local
  `devin acp` child once existed under the `devin-cli` adapter id and was removed: the CLI's
  credential turned out to be the ordinary cloud token, so the child process bought nothing that
  importing the token did not, and it cost a placeholder `buildRequest`, a disabled
  `parseStream`, an identity-only `baseUrl`, and a subprocess running in the operator's tree.
  `projectDevinCliAuthMode` rewrites any saved row that still names the retired adapter id,
  alongside the merge migration that retires the `devin-cli` provider id itself.

The registry records those relationships with `contractParent`. A parent relationship does **not** mean the registry recursively constructs a parent adapter and injects it into the child. Azure and MiMo keep owning their existing internal composition. This avoids making production constructors depend on test/conformance needs and keeps this authority refactor behavior-neutral.

Codex Spark retirement removes model-specific exceptions from the Responses adapter, without
changing contract inheritance or generic Responses Lite handling; see
[Responses transport](../transports/responses.md#responses-httpsse).

## Wrapper-cycle and runtime validation policy

`effectiveAdapterContract()` follows `contractParent` links at runtime with a visited set. Unknown parents and cycles fail closed. This is intentionally runtime validation: registry/config values can originate in persisted files written by older or hand-edited installations, so compile-time typing alone is not an adequate boundary.

## Extension policy

`zcode` uses the direct `zcode` wire and `agent-owned-with-explicit-opt-in` mutation contract.
Unlike routed function tools, native ZCode actions are informational output only. Its `runTurn`
sets `replaySafe: false`; accepted failures terminate incomplete rather than becoming automatic
failover candidates. Launcher authority comes from either the operator environment or a separately persisted,
GUI-consented Desktop connection. Data-plane requests and ordinary provider configuration cannot
set command/workspace paths. The managed Desktop bootstrap keeps credential-bearing runtime
descriptors inside the official child process; the parent sees public model identities only.
Subscription quota is separately read through the official Desktop host entitlement RPC in a
short-lived private profile copy, optionally inside Bubblewrap when enabled. Managed quota cache
identity reuses the runtime already resolved and validated while loading Desktop settings instead
of repeating synchronous host process discovery. Only numeric quota windows leave that process. An advanced launcher
requires explicit `OCX_ZCODE_DESKTOP_RUNTIME` authority and reuses its own isolated model key;
quota discovery must not silently import another Desktop account or affect routing policy.

Adding a production adapter requires:

1. one `ADAPTER_REGISTRY` entry with its factory;
2. either a direct `wire` + mutation contract or an explicit `contractParent`;
3. provider/model adapter ids that point only at registered ids;
4. registry-derived conformance coverage in the follow-up conformance layer.

Do not add a second switch/list of adapter factories in request routing. Focused tests may construct a concrete adapter directly when they are testing that adapter itself; cross-adapter production routing should use registry authority.

## Scope boundary

This decision does not change routed `apply_patch` behavior, Cursor structured-edit conversion, Azure/MiMo request construction, or provider wire selection. Those behaviors remain owned by their existing modules and focused tests. The registry exposes the universe and semantic relationships; the next stack layer consumes that metadata for generic conformance.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Moonshot `$ref`-with-siblings normalization

Moonshot/Kimi enforce the draft-07 reading where `$ref` must stand alone and 400 the whole
request when a node carries both. Codex's own deferred tool catalog emits exactly that shape,
so the schema is not something a user can fix from configuration (issue #2673).

> Decision record: [ADR-0093](../decisions/ADR-0093-moonshot-ref-with-siblings-normalization.md)

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger.

Connected CLI usage follows the [client-scoped hub usage contract](../gui-and-management-api.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
## Truncated tool finalization

The bridge keeps an open function, custom, or tool-search call incomplete when an adapter ends with a recognized truncated stop reason. Streaming emits no argument/input completion frame for that open call, and buffered JSON applies the same status. A call already closed by its own tool-call end retains its completed state. The response remains incomplete, partial output is preserved, and truncated compaction never replaces history.

A provider web search still in flight at that truncated terminal is finalized as `failed`, the same status it already receives from the error and explicit-incomplete terminals. It never returned results, so reporting it as `completed` would leave the client showing a finished search for a turn the provider cut short.

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](../transports/responses.md).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Adapter events distinguish raw reasoning content from summary-channel thinking; CCA Gemini classification is request-local. See [Google provenance](../providers/google.md).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-tiers.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

Translated Chat request construction uses the [inline-image budget](../transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

## SWE-2 model effort selection

`src/adapters/devin.ts` resolves an explicit SWE-2 reasoning effort to the native
medium/high/max UID before accepting a suffix already present in the model id.
The merged `devin` provider uses this resolver for every account, whichever login
path minted the credential. Omitted effort preserves an explicit
variant; unrelated model families retain their existing suffix precedence.

ZCode native tool execution in `src/adapters/zcode/desktop.ts` uses host user permissions by default,
not client-side tool dispatch. `OCX_ZCODE_SANDBOX=1` explicitly enables the optional
Bubblewrap workspace boundary; harness restrictions apply where the native process runs. Explicitly
consented managed connections use the official runtime's non-interactive `yolo` mode because the
bridge cannot project interactive approval prompts; advanced operator launchers retain `edit` mode.
The managed host bootstrap writes an official `PreToolUse` process hook into the disposable private
ZCode config. It preserves Bash input and deterministically sets the supported
`dangerouslyDisableSandbox=true` field; this is configuration through the vendor hook surface, not
a patch to the official runtime. ZCode's file-oriented tools remain workspace-scoped, so a
bridge-owned reminder directs outside-workspace access through Bash before reporting a host path
absent. The optional Bubblewrap path and advanced launchers receive neither the hook nor reminder.
The host child inherits only a named allowlist of tool environment variables and keeps ZCode-owned
credentials/session state under its private data root. Because the official app server has no
config-path option, a one-shot Node preload redirects only its internal `os.homedir()` lookup to a
turn-scoped private home; the process environment retains the user's real `HOME`, so native host
tools work without copying unrelated provider secrets into the child. On cancellation, the host
bootstrap signals the official runtime and inherited native tools as one POSIX process group,
escalates to a bounded forced stop, and removes the disposable turn home before returning.
The dashboard's optional recheck repeats only model-catalog and `workspace/readState` protocol
operations; it never creates or sends a model turn, starts a native tool or consumes inference quota.

## ZCode saved accounts

`src/adapters/zcode/accounts.ts` stores private UUID-scoped metadata and official profiles.
`src/adapters/zcode/native-oauth.ts` and `src/adapters/zcode/oauth-bootstrap.cjs` invoke only
ZCode's installed host OAuth/credential services; authorization URLs and safe stage codes are
projected to the browser, never tokens. The official cached-session restore and Coding Plan
refresh run before account use. Disabled/unavailable vendor profiles remain unavailable.

The provider's `zcodeAccountId` is an exact binding through routing, catalog discovery,
app-server settings, session/DB scope and quota reads. An invalid or revoked binding fails
closed, never to the legacy Desktop profile or another account. Legacy unbound `zcode`
retains its previous profile. Account providers do not participate in an implicit pool.
Native tools still run on the host by default; optional OS sandboxing is independent of
profile separation and does not turn the latter into a security boundary. Refresh failures
cross the adapter boundary only as bounded public codes, never filesystem or account paths. An
expired refresh reserves the account before waiting for an active official turn to close, then
revalidates account/connection state. The adapter checks the official refresh both before joining
the stable profile queue and again after acquiring it; if the short cache expired during a long
wait, it reloads the refreshed generation before dispatch instead of using the earlier snapshot. A caller
waiting on that shared official refresh races only its own abort signal and returns promptly without
cancelling the refresh for sibling requests. Authenticated account operations also delete valid
hidden new-account and reconnect drafts whose in-memory job disappeared after restart, while preserving active
drafts and visible accounts. Active standalone drafts reserve their eventual account-limit slot without becoming
visible; restart reconciliation releases abandoned reservations. A failed OAuth job continues to
own its hidden draft and capacity reservation until explicit cancellation or bounded expiry, so a
retry cannot stack drafts for the same account. Global Desktop controls are hidden for account-bound provider settings,
transient completion failures keep the OAuth job authenticated for retry, and canonical
global-default aliases remap to the account default before validation.
Provider activation updates config and catalog without invalidating the quota view; entitlement
refresh remains a separate, explicitly requested action rather than a side effect of connection.
Account-list snapshots reuse one Desktop runtime discovery and one persisted-catalog read across all
saved accounts. Removal checks only route-bearing selector fields (including aliases and provider
reviewer targets), then revokes the official profile before deleting provider/catalog state. A later
durability or catalog failure remains visible as a bounded partial-removal state; retry is idempotent
and cannot reconnect or select another account.
Native turn admission retains a 32-request process ceiling and a 24-request per-profile ceiling,
so one stalled profile cannot consume every reservation needed by independent saved accounts.
Closing saved-account clients remain registered as busy until the direct bootstrap actually exits;
concurrent close callers share the same shutdown promise, so refresh, reconnect and removal cannot
enter while inherited native tools are still unwinding.
Headerless `previous_response_id` chains persist owner-fenced ZCode state even with `store:false`;
the non-secret local account slot identifies the owner, while the connection/profile generation in
the adapter scope rejects stale sessions after reconnect. Internal Codex compaction always starts a
fresh official session with an empty tool allowlist, publishes no replacement ZCode session, and
fails closed on an unexpected tool event. `session/send` is sized after JSON serialization before
the native client starts, matching the managed bootstrap's one-MiB NDJSON limit.
Advanced model descriptors reject loopback, private and link-local destinations before the
official runtime receives them.
Advanced launcher scope includes a bounded content generation for its isolated configuration and
rejects a stale generation at model-read time; queued turns recheck the complete scope before
starting a child, so an in-place account or credential change cannot resume the prior session.
Account removal recognizes both the generated provider name and its configured alias in routed
selectors outside the provider record. Activation/catalog readiness applies the same
`selectedModels` and `disabledModels` visibility policy as catalog convergence, so intentionally
hidden Desktop models do not leave a connection permanently pending.

## ZCode vision input adaptation

`src/adapters/base.ts` exposes a vision-only exception to the native-agent sidecar gate.
ZCode sets `allowVisionSidecar: true` while retaining `allowExternalSidecars: false`.
`src/server/responses/core.ts` resolves the configured vision helper and rewrites images before
calling the official agent; search/image/video generation remain native-agent-owned.
`src/vision/eligibility.ts` classifies every ZCode transport model as a sidecar consumer,
including renamed/account-bound providers and Flash. The shared catalog predicate advertises
sidecar-backed image input and excludes these models from describer selection. Disabled or
unavailable vision uses explicit omission markers; recursion protection and quota/cancellation
bounds remain in the shared vision path. This does not implement native image support in ZCode.

The hardened ZCode boundary accepts only exact active-session events, canonicalizes protected paths and default-workspace aliases before
optional sandbox validation, distinguishes unavailable quota probes from valid empty entitlements, requires
unique provider bindings and GUI-session-only Desktop metadata, and disables caller-tool capability
for every combo containing a ZCode target.
