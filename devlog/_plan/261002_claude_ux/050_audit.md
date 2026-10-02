# 050 Audit fold (wp1)

Independent inherited-model reviewer: NEAR-PASS. Folded into 020/030 as binding requirements:

1. `ensureClaudeIntercept` is a method of `ClaudeInterceptLifecycle` (claude-intercept-lifecycle.ts), so a later start goes
   through the same dispatch wrapper (`listener ??= requestServer`) and `ownsListener` classifies it as the intercept ingress;
   expose it through `OptionalListenerSet` and the existing `linkListener: () => optionalListeners` seam (index.ts gains no lines).
2. One `inflight` promise; `stopped` flag refuses ensure after stop; `stop()` awaits the in-flight start; ensure awaits a
   pending startup start first and only starts a new pair if it resolved to null.
3. Record the last start outcome: pure precheck (disabled / client role / ephemeral port) plus bind error mapping
   (EADDRINUSE on the CONNECT proxy → `port_in_use` with port). Picker proxy bind failure stays non-fatal and is reported as
   `pickerReason`.
4. Port mismatch (bound port ≠ configured) gets reason `port_mismatch`: rebind is out of scope; the copy explains the bound port
   is in use for this run and how to change it, never "restart".
5. Use startServer's live config object; recompute `observeClaudeDesktopMode` on each ensure.
6. Security: ensure (POST /api/claude-intercept/start and the triggering PUTs) is refused on the hub-management ingress and for
   data-plane API keys; same gate everywhere; tests prove it.
7. GUI routing list for wp3: app-routing.ts (Page union, page list, `#claude` redirect inverted), App.tsx title map + NAV,
   `nav.claude` and all copy in all locales, INTEGRATION_TAB_HASHES old hashes kept as redirects, integration-tabs.ts:34,
   overview-clients.ts:318/367, api-surface-cards.tsx:20, Integrations.tsx:20, Claude.tsx:10-11.

Notes kept: agent-settings-routes.ts sibling move up front (1943/2000); a later start may run picker CA drain/keychain → GUI
pending state; routing off keeps the pair bound (relay-native).

