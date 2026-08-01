# Current Architecture and Gap Analysis

## Current ownership

### Provider registry and config

- `src/providers/registry.ts` is the canonical preset source for CLI init, GUI
  presets, key-provider setup, catalog hints, and runtime canonicalization.
- It currently defines `openai` as one forward-auth provider and
  `openai-apikey` as one API-key provider.
- `src/providers/derive.ts` clones selected registry fields into config seeds and
  the GUI/CLI projections.
- `src/types.ts` stores Codex account-pool state globally on `OcxConfig`; an
  `OcxProviderConfig` has no declaration of whether a forward provider is Direct
  or pool-owned.

### Routing and authentication

- `src/router.ts` routes explicit `<provider>/<model>` ids first, then defaults,
  known model patterns, configured model lists, and finally the default provider.
- `src/codex/auth-context.ts::resolveCodexAuthContext` always evaluates the global
  pool. It does so without receiving the selected provider or provider mode.
- `applyCodexAuthContextToProvider` injects selected pool credentials into any
  forward provider.
- `src/codex/routing.ts::getEligiblePoolAccounts` already inserts the main account
  into the eligible pool. This is correct for Multi and must be preserved.

### Request paths

- `src/server/responses.ts::handleResponses` parses and routes the model before
  resolving auth. This is the correct route-aware seam, but it currently calls the
  route-blind resolver.
- `src/server/responses.ts::handleResponsesCompact` routes first, then independently
  resolves the same route-blind pool context. Its catch block silently falls back
  to raw forwarded credentials.
- `src/server/index.ts` resolves pool auth during WebSocket upgrade, before any
  frame/model exists. It resolves again before each frame and passes the decision
  into `handleResponses`, preventing that handler from making a provider-aware
  decision.
- `src/server/images.ts` and `src/server/search.ts` find a forward provider and then
  call the global pool resolver, so their account behavior depends on config order.
- `src/web-search/index.ts` and `src/vision/index.ts` repeat a separate first-forward
  scan and combine that provider with the main route's auth context, so internal
  sidecars can cross credential ownership even after standalone handlers are fixed.

### Catalog and UI

- `src/codex/catalog.ts` emits bare native OpenAI rows plus namespaced routed rows.
- Its routed gatherer currently returns no rows for any forward-auth provider because
  the ChatGPT backend has no `/models` endpoint. A new `openai-multi` provider would
  therefore be addable but have no selectable models unless the native Codex catalog
  is explicitly projected into a namespaced Multi view.
- `src/server/management-api.ts` exposes those rows to the GUI.
- `gui/src/components/AddProviderModal.tsx` consumes registry-derived presets, so a
  new featured registry row can become a separately addable tier without a bespoke
  modal.
- `gui/src/pages/Providers.tsx` shows forward providers only as generic
  `passthrough`; it does not distinguish Direct and Multi.
- `gui/src/pages/CodexAuth.tsx` owns account-pool management globally. This remains
  appropriate, but copy/navigation must make clear that it powers Multi only.

## Confirmed defects

1. **Direct and Multi are the same provider today.** A globally active pool account
   can override `openai`, so Direct is not direct.
2. **WebSocket auth is selected before routing.** A single socket can carry frames
   for different provider namespaces, but the account is chosen before the frame
   model is inspected.
3. **Sidecar provider selection is order-sensitive.** Adding two forward OpenAI
   providers would make “first forward provider” an accidental policy.
4. **OpenAI API GPT-5.6 context metadata is stale.** The registry pins 372,000 while
   current official OpenAI model pages state a 1,050,000 context window.
5. **Pro mode has no selectable representation.** Upstream Pro is a request mode on
   a base model, not a separate model id, while the requested OCX UX needs stable
   picker ids.
6. **Generic pattern routing will become ambiguous.** Adding `openai-multi` to the
   known OpenAI names without explicit namespace policy could let a bare `gpt-*`
   model select whichever provider appears first.
7. **Legacy behavior would silently change.** Simply reinterpreting `openai` as
   Direct would strand existing users who configured account rotation through the
   old combined provider.
8. **A second forward tier has no catalog today.** Forward providers are skipped by
   routed model discovery, so Multi needs a deliberate native-catalog projection;
   it must not query the OpenAI platform API or invent a static API model list.
9. **`chatgpt` is a fourth configured provider today.** Startup auto-upserts it and
   OAuth login persists it into `config.providers`; management and config-order
   routing can therefore expose it beside the requested three tiers.

## Architectural decisions

- Declare account ownership as provider metadata, not as provider-id string tests.
- Resolve Codex account context only after a request's model route is known.
- Keep bare native `gpt-*` ownership with Direct; Multi and API selections are
  explicit namespaced routes.
- Project the same Codex-native model source into namespaced Multi rows. Direct and
  Multi share model capability ownership but remain separate picker identities.
- Keep virtual Pro transforms as trusted built-in registry metadata. Do not expose
  arbitrary JSON body overrides through user config or management APIs.
- Keep the global account store and routing engine; only gate their use by selected
  provider mode.
- Make sidecar provider choice deterministic and explicit.
- Retain `chatgpt` only as a legacy credential-login alias; remove it from configured
  providers, public discovery, cards, and routing without deleting stored credentials.

## Rejected alternatives

- **One `openai` provider plus a toggle:** history and picker selections cannot
  express which credential policy was intended, and per-request switching remains
  ambiguous.
- **Infer Multi when accounts exist:** Direct would cease to be a stable contract.
- **Check `providerName === "openai-multi"` throughout handlers:** duplicates policy
  and makes custom/renamed forward providers unpredictable.
- **General request override maps in config:** unnecessarily creates a body-injection
  surface for a three-alias requirement.
- **Rewrite Pro ids in catalog/history:** loses the user's selected identity and
  breaks disable/subagent/history consistency.
