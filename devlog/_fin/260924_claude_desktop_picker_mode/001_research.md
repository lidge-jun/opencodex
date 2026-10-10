# 001 — Research: how the Desktop Code tab picker can list opencodex models (2026-09-24)

Evidence was read from Claude.app 2.7032.0 (`/Applications/Claude.app/Contents/Resources/app.asar`,
byte offsets below), from claude.ai renderer bundles saved during the 2026-09-23 probe (kept outside
the repository under `/tmp/ocx-claude-probe/web/`; they may be older than the live renderer), and
from this repository at `37f93da6ac`. Nothing here was observed on the wire yet; the items marked
**live** are verified in wp5.

## Desktop app facts

- `egressProxyUrl` is a config-library key supported in both deployment scopes:
  `support:{enabled:{scopes:["3p","1p"],availableInVersion:"1.44121.1"}}`, `appBehaviorOnly:!0`
  (app.asar ≈11009657). It is read once at launch and applied as Chromium `--proxy-server` with a
  bypass list for loopback and `*.local`; PAC (`egressProxyPacUrl`) takes precedence
  (≈20277302–20278073). Startup logs `[egress-proxy] pinned …; OS proxy settings ignored`
  (≈20329028). Claude Code processes the app spawns receive `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`.
  The 1.18286.0 build probed for the previous unit predates this key, which is why that unit could
  not reach the picker.
- On macOS the app reads its config library from the user-data directory with a `-3p` suffix
  (`~/Library/Application Support/Claude-3p/configLibrary/`) in both scopes; `_meta.json`
  `appliedId` selects `<id>.json` (≈11136500–11138403, ≈11158102). opencodex already owns this
  writer (`src/claude/desktop-3p-library.ts`, `src/claude/desktop-3p-paths.ts:47`).
- The model-list keys `modelCatalogUrl`, `modelCatalogEnabled` and `modelDiscoveryEnabled` are
  3P-only (`scopes:["3p"]`). No config key sets an app-level trusted CA, so Desktop's renderer
  relies on the operating system trust store for claude.ai.
- The first-party provider class (`hasClaudeAiProductFeatures(){return!0}`,
  `managesProviderRouting(){return!1}`) implements `validateSessionModel(e,t){return{ok:!0}}`
  (≈12961260). The non-Anthropic model regex (`…|gpt|grok|kimi|…`, ≈10697300) applies only to the
  custom-3P provider's `validateSessionModel` (≈12952304). In 1P, a picked id reaches Claude Code
  unchanged through `query.setModel`.

## claude.ai renderer facts (saved bundles)

- The picker catalog comes from the bootstrap response field `model_selector_config`: an array of
  surfaces `{ id, models[], description?, presets?, featured?, auto_compact_window? }`. The Desktop
  bridge takes the selectable models of the surface `"code"` and sends their ids to the app with
  `setAvailableCodeModels`. `"cowork"` has its own catalog; `"ccr"`/`"ccd"` share Code-like
  selection persistence but are not shown to feed this bridge.
- A model entry carries `id`, `name`, `section`, `description`, `badge`, `tooltip`,
  `disabled`, `disabled_reason`, `context_window`, `thinking`, `fast_mode`, `capabilities` and
  optional version gates. It is listed when `section` is `"main"` or `"overflow"` and selectable when
  it is not disabled, has no `disabled_reason` and is not `"deprecated"`. The default selection is a
  separate `model_selector_state`; `contextWindowByModel` is derived from each entry's
  `context_window`.
- The bootstrap is fetched with credentials from `/edge-api/bootstrap/{org}/app_start` or
  `/edge-api/bootstrap` with `statsig_hashing_algorithm=djb2&growthbook_format=sdk&cache_bust=1`
  (another provider defaults to an `/api` prefix) and parsed with `response.json()`; no body
  signature or integrity check exists on that path. A `bootstrap_push_revision` guard keeps a newer
  catalog revision when an older network result arrives.
- claude.ai also carries WebSockets (`/v1/sessions/ws/{id}/subscribe`, Code terminal
  `/v1/code/sessions/{id}/terminal`, `/api/ws/…` voice) and streaming responses
  (`/v1/code/sessions/{id}/events/stream`, `/v1/code/sessions/watch`, SSE chat, an MCP
  `EventSource`). A terminating proxy has to pass all of them through.

## opencodex facts

- Mode: `DEFAULT_CLAUDE_DESKTOP_MODE = "first-party"` (src/claude/desktop-first-party.ts:36);
  `resolveClaudeDesktopMode` returns an explicit `desktopMode`, then `gateway` for an applied
  gateway fingerprint, then the default (:49–53). Every apply path persists the chosen mode through
  `recordClaudeDesktopMode` (:62). An install that applied first-party before the field existed
  would silently resolve to gateway if only the constant changed, and the next implicit apply would
  retire its env. Five tests in tests/claude-integration/claude-desktop-first-party.test.ts assert
  the current default (:64, :78, :86, :138, :182).
- Intercept: the CONNECT proxy splices only `api.anthropic.com` (a startup snapshot,
  src/claude/intercept/connect-proxy.ts:15, :121) and blind-tunnels the rest; loopback targets get
  403 and non-CONNECT requests 405. The TLS listener is one `Bun.serve` with one certificate
  (listener.ts:106) and relays non-Messages paths through `fetch`, which decodes bodies and drops
  `Upgrade` (listener.ts:19–29, :62–88), so it cannot carry claude.ai as is.
- CA: `local-ca.ts` builds P-256 certificates with local DER helpers (`tlv`, `contextTag`,
  `objectIdentifier`, `extension`, :48–109) and keeps the CA out of OS trust (:9); a
  nameConstraints extension (OID 2.5.29.30) is expressible with the same helpers.
- Routed ids: `aliasForRoute` mints `ocx-claude-<provider>--<model>` (src/claude/alias.ts:94) and the
  Messages path already resolves it, so a picker entry with that id routes without a binding.
- File-size ratchet: none of the touched intercept/desktop files has a cap; `src/server/index.ts` is
  at 883 of 893, so no new wiring lands there.

## Open questions verified live in wp5

1. The live bootstrap still carries `model_selector_config` with a `"code"` surface, and a cloned
   entry renders and is selectable.
2. Chromium in Desktop accepts a claude.ai leaf chained to a login-keychain-trusted root that
   carries nameConstraints.
3. Desktop behaves with an HTTP/1.1-only terminator (ALPN) for claude.ai, including WebSockets.
