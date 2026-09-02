# 000 — Research: a Cursor tab on the Integrations page

Unit 260902_cursor_integrations_tab. Class C3 (new management route, new GUI tab, docs).
Follow-on to 260902_cursor_local_models_schema (PR #3230/#3231, landed on dev).

## What the user asked

"Turn it on from #integrations and have it just work" plus "make a clean detail page",
and shorten "DeepSeek Harness (DSH)" to "DSH" so the strip has room.

## Why this is NOT a file-toggle client

The twelve file clients own a fragment of a client config file and journal every write
(src/integrations/writer.ts). Cursor Private Inference keeps its gateway settings inside
state.vscdb (SQLite, rewritten by the running app) and its API key in macOS Safe Storage.
Writing there is the T20 exclusion (260822_senpi_cursor_transfer/090) and the reason the
community bridge polls and only writes while Cursor is closed. The env-var path cannot be
injected into a GUI app by the proxy either. So the tab is a **read-only companion**: it
detects, hands the user the two values, and confirms the connection from our side.

## What the page needs from the server

- Detection. Private Inference identity is product.json nameLong == "Cursor Private
  Inference" (verified on 3.18.25). Search roots: macOS /Applications and ~/Applications
  (*.app/Contents/Resources/app/product.json), Windows %LOCALAPPDATA%/Programs/cursor*
  and %ProgramFiles%/cursor* (resources/app/product.json), Linux best effort:
  /opt/cursor*/resources/app/product.json and ~/.local/share/cursor*/resources/app/product.json.
  Regular Cursor has nameLong "Cursor".
- Gateway values. Base URL http://127.0.0.1:<port>/v1 where port is the running port
  (readRuntimePort, as native-integration-routes does). API key: when the data plane
  requires a credential, the page says "use your API key" and offers the API Keys tab;
  otherwise the placeholder "opencodex-loopback" (the file clients' convention).
- Last seen. /v1/models already runs resolveApiAuth; add an in-memory recorder
  (src/integrations/cursor-seen.ts) keyed on User-Agent starting with "Cursor/" that
  stores {at, userAgent}. No persistence; the card wording says "since the proxy started".
- Models. The route lists the active catalog ids and classifies each with the same regex
  families Cursor uses (sibling unit 000 §4); context tier only for native GPT-5.6 via
  nativeOpenAiContextTier.

## GUI shape

- TABS gains { id: "cursor", hash: "integrations/cursor", labelKey: "integrations.tab.cursor" }
  after grok. INTEGRATION_TAB_HASHES gains "integrations/cursor". IntegrationTab and
  OverviewClientId gain "cursor"; NATIVE_MARKS.cursor = "/provider-icons/cursor-color.svg".
- Overview row: no toggle, state from the status payload.
- Detail page CursorIntegrationPage.tsx using useDataSurface like Grok.tsx; sections
  Detection / Gateway / Connection / Models / Guide link; reuses .integration-native-page
  and the existing card/notice/btn vocabulary.
- i18n: t() resolves DICTS[locale][key] ?? en[key] ?? key (gui/src/i18n/provider.tsx:25), so
  new keys live in en.ts only; other locales fall back to English until translated.
- DSH label: integrations.tab.dsh -> "DSH" in all nine locale files.

## Tests that enforce the wiring

- gui/tests/integrations-tab-coverage.test.ts, integration-marks.test.ts,
  integrations-surfaces.test.tsx (extend with cursor)
- tests/management-route-registry.test.ts (declare in route-registry.ts),
  tests/skill-ocx.test.ts (capabilities.ts + skill surface regen)
- cursor is NOT a file client: do not add it to FILE_INTEGRATION_CLIENTS.

## Verifiers (dev 83838e7fa)

| Command | Reads target |
|---|---|
| bun run typecheck | src/** |
| cd gui && bun x tsc --noEmit | gui/src/** |
| bun run lint:gui ; bun run build:gui | gui |
| bun test gui/tests/integrations-tab-coverage.test.ts gui/tests/integration-marks.test.ts gui/tests/integrations-surfaces.test.tsx | wiring |
| bun test tests/management-route-registry.test.ts tests/skill-ocx.test.ts tests/management-integration-routes.test.ts | route declaration |

Full suite forbidden; CI on exact heads is the gate.
