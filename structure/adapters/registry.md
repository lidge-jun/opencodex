# Adapter Registry Authority

## Decision

Runtime adapter construction has one authority: `src/adapters/registry.ts`.

`src/server/adapter-resolve.ts` may resolve a provider/model onto an adapter id, but it does not maintain a second adapter factory inventory. The selected persisted/configured adapter id remains an untrusted string until the registry lookup succeeds. Unknown ids fail with the existing `Unknown adapter: <id>` error instead of widening configuration types around a closed compile-time union.

## Semantic inheritance is not constructor inheritance

Some adapters share another adapter's routed-tool semantics while retaining independent runtime construction:

- `azure` and `azure-openai` inherit the `openai-responses` contract.
- `mimo-free` inherits the `openai-chat` contract.
- `cursor` stays direct because its `runTurn` transport and gated native-file fallback are distinct.

The registry records those relationships with `contractParent`. A parent relationship does **not** mean the registry recursively constructs a parent adapter and injects it into the child. Azure and MiMo keep owning their existing internal composition. This avoids making production constructors depend on test/conformance needs and keeps this authority refactor behavior-neutral.

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
short-lived private profile copy, optionally inside Bubblewrap when enabled. Only numeric quota windows leave that process. An advanced launcher
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

## Moonshot `$ref`-with-siblings normalization

Moonshot/Kimi enforce the draft-07 reading where `$ref` must stand alone and 400 the whole
request when a node carries both. Codex's own deferred tool catalog emits exactly that shape,
so the schema is not something a user can fix from configuration (issue #2673).

> Decision record: [ADR-0093](../decisions/ADR-0093-moonshot-ref-with-siblings-normalization.md)

ZCode native tool execution in `src/adapters/zcode/desktop.ts` uses host user permissions by default,
not client-side tool dispatch. `OCX_ZCODE_SANDBOX=1` explicitly enables the optional
Bubblewrap workspace boundary; harness restrictions apply where the native process runs.

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
profile separation and does not turn the latter into a security boundary.

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

The hardened ZCode boundary accepts only exact active-session events, canonicalizes protected paths in
optional sandbox mode, distinguishes unavailable quota probes from valid empty entitlements, requires
unique provider bindings and GUI-session-only Desktop metadata, and disables caller-tool capability
for every combo containing a ZCode target.
