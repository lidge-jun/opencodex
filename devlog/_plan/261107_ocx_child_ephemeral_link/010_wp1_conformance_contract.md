# `wp1` — Shared Golden Conformance Vectors & Ephemeral Child Contract Helpers

> Continuity handoff (`LOOP-CONTINUITY-01` from `wp0` D at `a5c605fafc`): `wp0` locked the docs-first roadmap with zero production edits (`VERDICT: PASS` / `GO-WITH-FIXES (blockers=0)`). Revalidated `010_wp1_conformance_contract.md` against current HEAD: `isAllowedRequestOrigin` (`src/server/auth-cors.ts:118`) is added to `Header dependencies` and `routeCases` so DNS-rebinding `Host` and cross-origin `Origin` `403` rejections are locked in the shared golden fixture alongside route admission, smuggling, HMAC v2, OCX-6 digests, child-parity, and `#1798` journal round-trips. Architect consultation: covered by `ARCH-06` & `ARCH-07` (`ALIGNED` on handle `01a1b18b-a2f3-7b53-971a-9b2c9cccecf7`, `000_roadmap.md` §3.1).

- **Phase ID**: `wp1` (depends on `wp0`; satisfies `c-2`)
- **Header dependencies**:
  - Existing types/functions consumed: `linkRouteAllowed` (`src/link/routes.ts:15`), `linkManagementRouteAllowed` (`src/link/management-routes.ts:72`), `isAllowedRequestOrigin` (`src/server/auth-cors.ts:118`), `computeLinkRelayProof`, `computeLinkConnectionProof`, `verifyLinkRelayProof`, `verifyLinkConnectionProof` (`src/link/relay-auth.ts:45-95`), `HomeCodexSettings`, `codexSettingsDigestPayload`, `codexSettingsDigest` (`src/link/codex-settings.ts:30-182`), `parseLinkChildParityReport` (`src/link/child-parity.ts:67`), `validateHubRelayRequestHeaders` (`src/client/hub-relay.ts:49`), `classifySyncResult` (`src/cli/sync-fanout.ts:52`), `externalCodexModelProvider` & `ensureRootWebSearchDisabled` (`src/codex/inject/config-toml.ts:30,366`), and `stripJournaledOpenaiBaseUrl` (`src/codex/injected-marker.ts:106`).
  - Shared types exported/validated in this phase: `EphemeralChildConfigProjection`, `isDetachedEphemeralChildConfig`, `isEphemeralChildHealth` (`src/link/ephemeral-child.ts`), and `ConformanceSuite` (`tests/fixtures/link/ocx-child-conformance.json`).
- **Scope**:
  - **IN**: `src/link/ephemeral-child.ts` (NEW), `tests/fixtures/link/ocx-child-conformance.json` (NEW), `tests/clients/link-ocx-child-conformance.test.ts` (NEW — named `link-*` to satisfy `seeds.json` vs `cli` prefix rule), `scripts/test-layout/layout-clients.json` (MODIFY), `tests/fixtures/test-layout-expected.json` (MODIFY).
  - **OUT**: `native/ocx-child/**` (`wp2`), `src/server/management/**` (`wp3`), `structure/**` & `docs-site/**` (`wp4`).

## 1. Exact File Changes

### 1.1 NEW `src/link/ephemeral-child.ts`

Pure, zero-side-effect TypeScript contract helper module in `src/link/` (starts no timers, sockets, or processes on import; unreachable from `src/router.ts`, `src/server/lifecycle.ts`, and `src/server/responses/core.ts`):

```ts
/**
 * Contract predicates for the lightweight `ocx-child` ephemeral Remote Link Child runtime.
 *
 * Kept pure inside `src/link/` so enrollment and diagnostics can distinguish a clean detached
 * `ocx-child` host from a full standalone `ocx` daemon without changing `LinkStore` on disk.
 */

export interface EphemeralChildConfigProjection {
  readonly port: number;
  readonly runtimeRole: "standalone" | "client";
  readonly ephemeralChild: true;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/**
 * True when `config show --json` came from a clean, detached `ocx-child` binary ready for
 * Home-initiated enrollment (`runtimeRole: "standalone"`, `ephemeralChild: true`, valid port).
 * An already-attached `ocx-child` reports `runtimeRole: "client"` and returns `false`.
 */
export function isDetachedEphemeralChildConfig(value: unknown): value is EphemeralChildConfigProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ephemeralChild === true
    && (record.runtimeRole ?? "standalone") === "standalone"
    && isValidPort(record.port);
}

/** True when a `/healthz` payload identifies a live `ocx-child` client relay on `expectedPort`. */
export function isEphemeralChildHealth(value: unknown, expectedPort: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.service === "opencodex"
    && record.role === "client"
    && record.ephemeralChild === true
    && record.port === expectedPort
    && typeof record.pid === "number"
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.startedAt === "string"
    && Number.isFinite(Date.parse(record.startedAt));
}
```

### 1.2 NEW `tests/fixtures/link/ocx-child-conformance.json`

Deterministic JSON document (`"schema": "ocx.child.conformance/1"`) containing 6 golden vector arrays shared verbatim between `bun test` and `cargo test`:

1. `routeCases` (24 vectors):
   - Every allowed `POST` data-plane route (`/v1/responses`, `/v1/responses/compact`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`, `/v1/audio/transcriptions`, `/v1/alpha/search`, `/v1/images/generations`, `/v1/images/edits`, `/v1/live`, `/v1/realtime/calls`, plus all 10 `CONTEXT_PATHS` under `/v1/alpha/{history,notes}/v2/*`) -> `expectedAction: "relay_data"`, `expectedAuthHeader: "bearer"`.
   - `GET /v1/catalog`, `HEAD /v1/catalog`, `GET /v1/hub-state`, `HEAD /v1/hub-state`, `GET /v1/models`, `GET /v1/opencodex/artifacts/item-1` -> `expectedAction: "relay_data"`, `expectedAuthHeader: "bearer"`.
   - `GET /v1/usage` -> `expectedAction: "relay_data"`, `expectedAuthHeader: "x-opencodex-api-key"`.
   - `GET /v1/link-management/codex-settings` (empty query -> `relay_management`; `?foo=1` -> `reject_404`), `GET /v1/link-management/api/settings` (clean query -> `relay_management`; `?refresh=1` -> `reject_404`).
   - `GET /healthz` -> `local_healthz`; `GET /readyz` -> `local_readyz`; `HEAD /readyz` -> `reject_404`.
   - `GET /v1/responses` with `Upgrade: websocket` (loopback `Origin`) -> `reject_426_websocket`; `GET /v1/responses` with `Upgrade: websocket` + `Origin: https://evil.example` -> `reject_403_origin`; `POST /v1/responses` with `Host: evil.example:10100` -> `reject_403_origin`; `POST /v1/responses` with `Origin: https://evil.example` -> `reject_403_origin`; `GET /v1/catalog` with `Upgrade: h2c` -> `reject_404`; `GET /api/config` & `DELETE /v1/responses` -> `reject_404`.
2. `framingCases` (10 vectors):
   - Valid `Content-Length: 42` with caller credentials (`Authorization: Bearer sk-user`, `x-api-key: ant-user`, `x-goog-api-key: g-user`, `api-key: az-user`, `x-opencodex-api-key: ocx-user`, `chatgpt-account-id: acc-1`, `cookie: sid=1`, `Connection: keep-alive, x-custom-secret`, `x-custom-secret: drop-me`, `x-request-trace: keep-me`) -> `allow` and exact `strippedHeaderNames` leaving only `x-request-trace`.
   - Valid `Transfer-Encoding: chunked` without `Content-Length` -> `allow`.
   - Simultaneous `Content-Length: 10` + `Transfer-Encoding: chunked` -> `reject_400_smuggling`.
   - Duplicate `Content-Length` (`10`, `10` or `10`, `20`) -> `reject_400_smuggling`.
   - Non-digit `Content-Length: +10` / `10abc` -> `reject_400_smuggling`.
   - Non-chunked `Transfer-Encoding: gzip, chunked` -> `reject_400_smuggling`.
   - `Upgrade: websocket` in relay header validator -> `reject_400_smuggling`.
   - Header value containing `\r` or `\n` -> `reject_400_invalid`.
3. `relayAuthCases` (3 deterministic vectors using synthetic test-only tokens like `"ocx_data_0000000000000000000000000000000000000001"` so `privacy:scan` sees obvious zero-entropy test fixtures):
   - Locks `tokenSha256Hex`, `expectedCallerProof`, `expectedListenerProof`, and `expectedConnectionProof` computed over raw 32-byte `Buffer.from(tokenSha256Hex, "hex")`.
4. `settingsDigestCases` (4 vectors):
   - All-null defaults (`fastMode: null, multiAgentMode: null, webSearchSidecarEnabled: true, subagentDefaults: null`).
   - Populated `fastMode: true, multiAgentMode: "v1", webSearchSidecarEnabled: false, subagentDefaults: { model: "gpt-5.6-sol", reasoningEffort: "high" }`.
   - Populated `fastMode: false, multiAgentMode: "v2", webSearchSidecarEnabled: true, subagentDefaults: { model: "anthropic/claude-sonnet-4-5", reasoningEffort: null }`.
   - `multiAgentMode: "default"` with `subagentDefaults: null`.
5. `childParityCases` (6 vectors):
   - Valid pre-apply (`lastApplyAt: null, appliedCodexSettingsDigest: null`), valid post-apply, mismatched nullability (`lastApplyAt: null` with non-null digest -> invalid), extra unknown property -> invalid, out-of-range timestamp -> invalid, negative `sequence` -> invalid.
6. `journalRoundtripCases` (8 vectors):
   - `clean_absent_config`: `preAttachToml: null` -> attach -> unchanged detach -> `expectedFinalToml: null` (file unlinked), `expectedDetachOutcome: "exact_restore"`.
   - `preserve_comments_and_crlf`: CRLF `config.toml` with `# user comment` and `[mcp_servers.git]` -> attach -> sync with updated `fastMode` + `subagentDefaults` -> unchanged detach -> byte-exact CRLF restoration (`"exact_restore"`).
   - `app_rewrite_1798_comment_strip`: attach -> Codex App strips all `# Auto-injected by opencodex...` comments and adds `model = "gpt-5.6-sol"` + `[projects."/work"]` -> detach -> strips `openai_base_url`, `experimental_realtime_ws_base_url`, `model_catalog_json`, and managed settings by exact journaled value while preserving `[projects."/work"]` (`"surgical_restore"`).
   - `web_search_disabled_and_restored`: user had `web_search = "live"` -> attach with `webSearchSidecarEnabled: false` writes `web_search = "disabled"` -> `#1798` strips marker + user adds `approval_policy = "never"` -> detach restores `web_search = "live"` and keeps `approval_policy = "never"` (`"surgical_restore"`).
   - `user_changed_base_url_preserved`: attach -> user edits `openai_base_url = "https://custom.gateway.example/v1"` -> detach preserves user's custom `openai_base_url` while removing remaining owned keys (`"surgical_restore"`).
   - `corrupt_managed_span_refused`: attach wrote Design B root keys -> external edit corrupts `config.toml` with an unterminated quoted assignment on a managed root key (`openai_base_url = "http://127.0.0.1:10100/v1`) -> detach refuses (`expectedDetachOutcome: "refuse_conflict"`) leaving `config.toml` and `codex-journal.json` untouched.
   - `conflict_tampered_catalog_refused`: attach wrote `opencodex-catalog.json` -> user hand-edits `opencodex-catalog.json` -> detach refuses (`expectedDetachOutcome: "refuse_conflict"`) rather than deleting user-modified catalog.
   - `refuse_external_model_provider_on_attach`: `preAttachToml` has `model_provider = "openrouter"` + `[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"` -> `expectedAttachOk: false`, `expectedDetachOutcome: "not_attached"`.

### 1.3 NEW `tests/clients/link-ocx-child-conformance.test.ts` & Test-Layout Shards

- Resolves fixture via `fixturePath("link", "ocx-child-conformance.json")` from `../helpers/repo-root`.
- Verifies every vector in `routeCases`, `framingCases`, `relayAuthCases`, `settingsDigestCases`, `childParityCases`, and `journalRoundtripCases` against OpenCodex's live TypeScript implementations (`linkRouteAllowed`, `linkManagementRouteAllowed`, `validateHubRelayRequestHeaders`, `computeLinkRelayProof`, `computeLinkConnectionProof`, `codexSettingsDigestPayload`, `codexSettingsDigest`, `parseLinkChildParityReport`, `externalCodexModelProvider`, `stripJournaledOpenaiBaseUrl`, `ensureRootWebSearchDisabled`), plus unit tests for `isDetachedEphemeralChildConfig` and `isEphemeralChildHealth`.
- Registers `"link-ocx-child-conformance.test.ts": "clients"` in BOTH:
  - `scripts/test-layout/layout-clients.json`
  - `tests/fixtures/test-layout-expected.json`

## 2. Conditional-Path Activation Scenarios (`C-ACTIVATION-GROUNDING-01`)

1. **WebSocket `Upgrade` vs generic `Upgrade` rejection**: Driven in `routeCases` (`Upgrade: websocket` on `/v1/responses` -> `reject_426_websocket`; `Upgrade: h2c` on `/v1/catalog` -> `reject_404`) and asserted against `linkRouteAllowed` + ingress rules.
2. **Smuggling header combinations (`CL+TE`, duplicate `CL`)**: Driven in `framingCases` and asserted to return `reason: "smuggling"` from `validateHubRelayRequestHeaders`.
3. **Raw 32-byte vs ASCII-hex HMAC key**: Driven in `relayAuthCases` and asserted against `computeLinkRelayProof` / `verifyLinkRelayProof` (plus negative assertion that HMAC over ASCII hex differs).
4. **Detached vs already-attached `ocx-child` config**: Driven against `isDetachedEphemeralChildConfig` (`runtimeRole: "client"` returns `false`; `ephemeralChild` missing returns `false`; port `< 1024` returns `false`).

## 3. Phase Verifiers

- `bun test tests/clients/link-ocx-child-conformance.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/lab/core-link-boundary.test.ts tests/lab/core-lab-boundary.test.ts` (exit `0`)
- `bun run typecheck` (exit `0`)
- `bun run privacy:scan` (exit `0`)
