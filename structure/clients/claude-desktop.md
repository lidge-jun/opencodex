# Claude Desktop Integration

Native result continuations and function-result injection follow [the mode-specific result and control contract](../transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.
Explicit Codex CLI installation observation does not launch or reconfigure a desktop client. See the [read-only observation contract](../runtime.md#explicit-codex-cli-installation-observation).

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Desktop callers retain their existing ingress through the Responses
[core module ownership](../transports/responses.md#core-module-ownership). This surface retains its existing behavior.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Codex-native model discovery follows the [shared retirement policy](../catalog.md#shared-catalog).
That projection does not migrate existing user-selected Desktop configuration or usage history.

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](../transports/responses-wire-shapes.md#passthrough-sse-stream-shapes-314).
Translated Anthropic first-frame usage follows the [runtime snapshot contract](../runtime.md#anthropic-streaming-usage-snapshots); Desktop profile state and usage-ledger ownership are unchanged.

Claude-only connections keep their existing non-failing readiness policy; displayed catalog reasons follow the [terminal rendering contract](../runtime.md#cli-readiness-diagnostics) whether they surface at connect time or on a later refresh.

The hub-side CLI dashboard uses the [management ingress address](../runtime.md#hub-management-dashboard-address); this does not change connected Desktop profile endpoints.

Native main reauthentication follows the [CLI JSON output contract](../runtime.md#native-main-reauth-json-output).

The Codex restart command follows the [CLI restart scope contract](../runtime.md#cli-codex-restart-scope).

Native OpenAI pool routing also accepts
[Orca-linked accounts](../codex-home.md#orca-source-owned-account-import), whose source resolution
belongs to the shared account store. The import CLI adds pool rows independently of Desktop profiles.

## Desktop modes: gateway and first-party

`src/claude/desktop-first-party.ts` owns the Desktop mode contract. Two modes exist and are
mutually exclusive on one machine:

- **first-party** (opt-in, with account risk): Claude Desktop itself is left on claude.ai — login, Chat tab,
  connectors and remote control are untouched and no config-library profile is written. The apply
  writes only an authenticated `HTTPS_PROXY=http://opencodex:<token>@127.0.0.1:<port+100>` and `NODE_EXTRA_CA_CERTS=<config>/claude-intercept/ca.pem`
  into the `env` block of Claude Code's `settings.json` (via `src/claude/intercept/settings.ts`),
  creating the local authority first. Only the Claude Code process Desktop spawns for the Code tab
  (and its subagents, and any standalone `claude` CLI) reads that env, so only their
  `api.anthropic.com` traffic reaches the [Claude intercept pair](../runtime.md#claude-intercept-pair).
  The Desktop and standalone CLI first-party switches are independent intents. They share only the owned
  settings env; it remains while either intent is desired. A client whose intent is off may still traverse
  that proxy, but every path relays to real Anthropic when its intent is off. The account-risk warning applies
  to either routed first-party client.
- **gateway** (default for new installs): the existing third-party profile written by
  `src/claude/desktop-3p.ts`; the whole app switches to the local gateway. The dashboard,
  `--gateway`, and legacy `--static|--hybrid|--discovery-only` shape flags also select it.

`resolveClaudeDesktopMode` uses observations from `observeClaudeDesktopMode` in this order:
explicit `claudeCode.desktopMode` → selected owned gateway row → persisted
`desktopProfile.appliedFingerprint` → legacy Desktop-owned first-party env →
gateway. This env observation preserves Desktop installs that predate mode persistence
only while CLI first-party intent is off. An owned env observed with
`claudeCode.cliFirstParty === true` is not Desktop-mode evidence, even when the
intercept is disabled; foreign proxy settings do not count.
`resolveClaudeDesktopApplyMode` preserves the resolved mode.
An apply for a first-party install with `claudeCode.intercept.enabled: false` is refused with
`intercept_disabled` rather than switched to gateway. New installs apply gateway.
`src/claude/desktop-risk.ts` owns the account-suspension warning: first-party sends subscription
traffic through a local interception proxy, which Anthropic may treat as a terms violation.
`GET /api/claude-desktop/status` exposes it as `riskWarning` when first-party is resolved or its
owned settings are still observed; otherwise the field is `null`.
`/api/sync` and roster-update auto-apply never write a gateway profile while the resolved mode is
first-party; both re-resolve after model discovery before writing.

Mode switches establish the replacement before removing the previous connection. A failed
first-party apply (disabled intercept, CA failure, unreadable settings or foreign env) preserves
the gateway; a failed gateway apply preserves the first-party env. After a successful first-party
write, `removeDesktop3pStandardPivot({ replaceWhileEnabled: true })` retires the owned gateway.
A refused pivot that has not changed Desktop rolls back only the managed env keys while they still match this apply;
unrelated settings survive, and rollback failure is reported explicitly. If Desktop already pivoted to standard but credential cleanup is incomplete, first-party stays active and its mode is recorded. After a successful gateway
write, only env values anchored on OpenCodex's CA path are removed. The committed gateway mode and profile fingerprint are persisted together before first-party
cleanup via `src/claude/desktop-gateway-state.ts`. Cleanup failure remains a partial failure, while
subsequent default applies and status retain the gateway choice. A separate persistence failure
is reported explicitly; its mode/profile snapshot is not claimed to have been saved. These file operations are ordered,
not a crash-atomic transaction across the settings file and Desktop library.
Disabling Desktop integration removes its gateway profile. It removes the owned first-party env
only when `claudeCode.cliFirstParty` is not set; otherwise the env stays for the CLI. With Desktop
first-party ON, `ocx ensure` re-applies a stale env; the proxy port follows the public port.

Surfaces: `ocx claude desktop apply [--first-party|--gateway]` in `src/cli/claude-desktop.ts`;
`ocx claude config set --first-party on|off` and the Claude Code page switch control the CLI intent; `ocx ensure` refreshes a stale or absent env while it is on.
`POST /api/claude-desktop/apply` with `mode` ∈ `first-party|gateway|static|hybrid|discovery` and
`GET /api/claude-desktop/status` (`mode`, `riskWarning`, `firstParty.{applied,stale,interceptEnabled,interceptRunning,proxyPort,caCertPath}`)
in `src/server/management/agent-settings-routes.ts`; the native toggle in
`src/server/management/native-integration-routes.ts` applies the resolved mode on enable. Managed
Windows policy health only applies in gateway mode, because first-party never touches Desktop's own
configuration. Ordinary Chat-tab traffic is out of scope for both modes.

`src/claude/desktop-gateway-state.ts` adopts the exact committed Claude subtree and rebases the live hand-edit guard only after persistence succeeds. Pending disjoint live edits survive; later hand edits remain protected during unrelated whole-config saves. Gateway mode and fingerprint are recorded before cleanup and diagnostic awaits.

### Intercept credential lifetime

`src/claude/intercept/proxy-auth.ts` reads a bounded base64url credential through a checked
regular-file descriptor, rejects links and foreign POSIX owners, and never replaces invalid
existing entries. Creation hardens before no-replace publication. The authenticated listener
reads this current authority for every CONNECT; absence or invalidity denies admission.
An explicit first-party apply can recreate a missing token and the live listener follows it
without restart. Rejected CONNECT requests include a Basic proxy-authentication challenge.
Temporary cleanup failures warn without replacing a committed result or an earlier error;
retained temporary entries keep their ACL memo until absence is confirmed. Established tunnels
are not revoked by this new-connection check.

### First-party model bindings

`src/claude/intercept/model-bindings.ts` owns `claudeCode.intercept.modelMap`. In first-party mode the
Code tab picker is filled by claude.ai's model selector config, so no local file can add an opencodex
row; the only lever is the picker's Anthropic id on each request. A binding maps such an id
(`claude-sonnet-4-6`) to a route in the Desktop route vocabulary (`provider/model` or `native/<slug>`).
`src/server/index/serve-options.ts` passes `claudeIntercept` to `handleClaudeMessages` and
`handleClaudeCountTokens` only for the `claude-intercept` ingress; the handlers resolve models against
`claudeCodeForIngress`, a request-scoped `claudeCode` view whose `modelMap` is the global map with the
bindings overlaid (binding wins per key, `native/` targets normalized to the bare slug, global values
left verbatim). The live config object is never copied or persisted with the merged map. Every other
resolution rule is unchanged, so a bound id is translated rather than natively passed through, dated
ids reach undated keys, and an `ocx-route` directive still wins. `ocx claude` sessions and the public
Messages listener never see bindings.

`PUT /api/claude-desktop/first-party-bindings` (`{ set?, remove? }`) validates ids and routes against
`buildClaudeDesktopState().models` (available routes, native included), commits through
`mutatePersistedConfig` and adopts the committed `claudeCode` into the live config; `GET
/api/claude-desktop/status` reports `firstParty.modelBindings` and `firstParty.pickerSuggestions`.
Surfaces: `ocx claude desktop bind|unbind` (`src/cli/claude-desktop.ts`) and the dashboard card
`gui/src/components/ClaudeFirstPartyBindings.tsx`. Provider, routing-profile and combo renames rewrite
binding values alongside `modelMap`; keys are Anthropic ids and are never migrated. Invariant tests:
`tests/claude-integration/claude-intercept-model-bindings.test.ts` and the intercept-versus-public case
in `tests/server/claude-intercept-integration.test.ts`.

Production apply and status routes use the asynchronous, read-only policy probe in
`src/claude/desktop-policy.ts`. Concurrent requests share one in-flight probe, and its
settled state is cached for 30 seconds. Each registry query is bounded to two seconds;
timeouts and unreadable results report unknown policy state without blocking the server
event loop. Injected probes may return a state or a promise, so isolated callers can exercise the same asynchronous boundary.

### Picker mode: the Desktop egress proxy

The shared CONNECT primitive accepts optional `allowedTargets` authorities. It snapshots and
normalizes that list at startup; an empty list denies all, and other host/port pairs receive 403
before tunnel selection or dialing. Authentication and loopback refusal remain in force.
Existing Claude consumers omit this option and retain blind forwarding; it enables no new integration or certificate trust.
The authority primitive accepts `validityDays` from 1 through 3650 for short-lived callers; omitted values preserve the existing 3650-day CA lifetime. This parameter does not install trust or rotate an existing authority.

When the lifecycle passes `loadPickerRoutes` (the server always does), `startClaudeIntercept` also
wires Claude Desktop picker mode: a second loopback CONNECT proxy on the dedicated picker proxy
port (`getClaudeInterceptState()?.pickerProxyPort`), used as Desktop's pinned egress proxy. Desktop
also hands that proxy to the Claude Code processes it spawns, and the two trust different CAs, so
the tunnel is chosen per client from the CONNECT head: a tunnel without a browser User-Agent (Claude
Code, trusting only the intercept CA) gets the `api.anthropic.com` intercept and every other target
blind, never the picker; a tunnel with Chromium's `Mozilla/` User-Agent (the app, trusting only the
login keychain) is asked of the picker runtime (`src/claude/intercept/picker-runtime.ts`), which
blind-tunnels every target except `claude.ai:443`.
The User-Agent is a routing hint, not a trust boundary: a client that fakes it reaches only what
any local process already reaches (the `api.anthropic.com` intercept is on the Claude Code proxy
too; the `claude.ai` relay verifies upstream and adds no credential) and breaks only its own TLS,
because each terminator presents a certificate only its intended client trusts. `claude.ai:443` is
terminated by a `node:https` HTTP/1.1 relay (`picker-listener.ts`) only while the runtime's cached
decision is armed: macOS, persisted resolved Desktop mode first-party, Desktop intent on,
`claudeCode.intercept.picker !== false`, no disarm latch, listener up, and the current picker CA
trusted in the login keychain (`picker-trust.ts`). The picker CA (`picker-ca.ts`, under
`<OPENCODEX_HOME>/claude-picker/`, 0600 key) carries critical name constraints permitting only
`claude.ai` and excluding every IPv4 and IPv6 address, and is regenerated on reload when either is
missing, which gives it a new fingerprint to trust. Trust is added without a policy string: Chromium
skips host-scoped trust settings, so `inspectPickerTrust` treats a current CA whose exported user
trust settings carry `kSecTrustSettingsPolicyString` as untrusted and the trust step replaces it; an
export it cannot read makes trust `unknown`, which never arms. A
rotated-out picker certificate stays in the login keychain because `untrustPickerCa` removes only the
current one; its key was overwritten, so it can no longer sign a leaf. The relay verifies the upstream
certificate, streams every body and upgrade unchanged, and rewrites only the bootstrap response's
local Code picker surfaces, `ccd` (what the Desktop Code tab reads) and its `code` fallback, never the
remote `ccr` (`picker-bootstrap.ts`), failing open to the original bytes; the model list
comes from a persisted snapshot (`picker-models.ts`), so a bootstrap never waits on discovery. A
CONNECT to claude.ai that arrives before the first refresh waits at most 3 s, then goes blind. A
picker proxy bind failure only disables picker mode; a picker construction or start failure closes
every socket the start had bound before rethrowing. Nothing is logged but method, bootstrap or
other, and status.

`src/claude/desktop-picker.ts` owns every mutation while a server is running. One controller lock
serializes `enable`, `disable`, and `transition`; the latter wraps a whole Desktop mode change so
cleanup, mode/profile commit, and the optional picker enable cannot race. `runDesktopTransition` uses
that controller when one exists. With no controller (intercept disabled, client role, or a failed
picker-proxy bind), its offline operations remove leftover picker artifacts without creating a
terminator, and refuse enable with `proxy_unavailable`.

The controller disarms the picker runtime before disable or cleanup. The disarm latch makes new
`claude.ai` CONNECTs blind immediately and is cleared only by a completed, checked enable. If an
enable attempt added trust and a later check or profile write fails, it removes that trust again;
an earlier successful picker profile keeps the trust it needs. The owned profile helpers in
`src/claude/desktop-picker-profile.ts` use the standard row `opencodex-picker`, whose file contains
only `egressProxyUrl`. The previous Desktop selection is stored in
`<configDir>/claude-picker/profile-state.json`, never in Desktop's `_meta.json`.

The local controls are `ocx claude desktop picker on|off|status|trust`. With a live server, `on`,
`off`, and transition cleanup use the controller; `trust` performs the operator's local keychain
step and then reports the result to the server. Without a server, `on` is refused and `off` removes
owned artifacts locally. The management surface accepts `GET /api/claude-desktop/picker` and
`PUT /api/claude-desktop/picker` with `{ enabled, persist, trustedLocally?, callerAddedTrust? }`;
unknown keys are rejected, a successful enable/disable or reported refusal returns `200 { ok: true,
picker }`, and enabling without a controller returns `503 { ok: false, code: "picker_proxy_unavailable",
picker }`. `GET /api/claude-desktop/status` and `POST /api/claude-desktop/apply` expose the same
`firstParty.picker` status; first-party apply includes `picker` in its response. Selecting the
profile requires a full Desktop quit and reopen.

## Connected Claude Desktop profiles

The connection's local Codex readiness check follows the [selected-runtime probe contract](../runtime.md#remote-hub-hardening-ownership); general status hands its resolved command to this check instead of probing the version twice.
It does not discover lower-priority alternatives after a valid selection or alter Desktop ownership.

Connected `ocx claude desktop apply` reads the hub's Desktop snapshot and writes the hub origin
and exact hub-issued IDs to the local Desktop configuration. Static/hybrid embed the entries;
discovery-only keeps discovery on the hub. The hub owns family assignments and defaults; local
show/edit/import/export operations do not manage that profile. After hub changes or historical
client-only aliases, apply again and reselect the model. Connected `import --apply` is explicitly
unsupported and refuses before saving the import.

`src/claude/desktop-discovery-inputs.ts` owns the shared Desktop discovery projection used by
startup registry initialization and server discovery. `src/server/index.ts` exposes the explicit
`GET /v1/models?ids=desktop&format=desktop-config` snapshot, shaped as `{version:1,models:[...]}`
and sent with `Cache-Control: no-store`. `src/client/hub-client.ts` downloads it with the existing
data credential; `src/cli/claude-desktop.ts` selects connected apply, and `src/claude/desktop-3p.ts`
writes the resulting local Desktop configuration. No admin token, hub-profile upload or local
alias regeneration is part of this flow. Unsupported old hubs, invalid snapshots and unavailable
Desktop models fail apply without a local-catalog or loopback fallback.

Managed profile assignments persist `claude-opus-4-8-YYYYMMDD` slots across 2026-2035, not 2026
alone. The original 2026-only design held 365 slots and failed with "all 365 encoded date slots are
occupied" once a catalog exceeded 365 routes, because stale assignments are retained by design and
the set only grows. 2026 is still allocated first, so existing assignments keep their slots, and
2027-2035 are reached only after it fills. Years before 2026 stay rejected: dated ids such as
`claude-opus-4-8-20250201` are real Anthropic snapshot ids and the inbound decoder relies on that
distinction. At render time each stored slot becomes a unique `p`-prefixed four-character wire
code, disjoint from the historical three-character hash namespace. Claude Desktop strips terminal
dates when comparing active-session model identity, so writing
the persisted date slots directly would collapse every managed route to `claude-opus-4-8` and
suppress `set_model` between them (#3782). The registry accepts both forms during migration. If an
active real Anthropic id claims a persisted date slot, reconciliation reallocates the non-Anthropic
route before rendering. If any synthetic or compatibility alias matches an active real Anthropic id,
the conflicting routed row or compatibility binding is omitted with a warning, and the real
Anthropic identity remains unclaimed; a profile alias can never overwrite native routing.
`src/claude/desktop-profile.ts` owns the slot range and wire conversion.

Persisted date-shaped Desktop IDs can overlap genuine native model IDs. When available discovery and
mapping evidence cannot resolve one, Messages and count-tokens return HTTP 503 with the fixed
`desktop_model_mapping_unavailable` error rather than classifying it as invalid. Unknown legacy hash aliases
remain HTTP 400; neither case reaches date-stripping or fallback routing. Known/registered IDs,
exact operator mappings and recognized native IDs keep their existing handling. Discovery refresh
or reapplying the connected hub profile may supply the missing mapping; retry alone does not
guarantee resolution.

The remote-alias slice does not change thinking/redacted-thinking replay or prompt-cache
behavior. Those remain the separate request tracked in #3719; proxy admission alone does not
establish native Anthropic passthrough or imply that translated Anthropic caching is disabled.

### Desktop ownership across the connection lifecycle

`src/claude/desktop-remote-store.ts` owns the first protected restoration baseline and the
connection-owned Desktop fields. `src/cli/claude-desktop.ts` handles connected apply, while
`src/client/connect.ts` coordinates key rotation/recovery and disconnect. Reapply and rotation retain the original
baseline. Restoration merges into current user fields, preserves unrelated profiles, and restores
the previous selection only while the managed profile is still selected. A later valid user
selection is not changed. A newly created profile with user additions is retained in readable
standard mode instead of deleting those additions.

During initial enrollment, `src/client/state.ts` records a pending key fingerprint before the token
is published. Service uninstall retains only the matching key; an unsafe or unreadable marker leaves cleanup unverified. Connect clears its marker on commit or rollback; the marker
does not claim any Desktop restoration ownership.

A proven legacy current-hub/recognized-key profile without an original baseline can be adopted
by apply, rotation/recovery or direct disconnect without a new flag or prerequisite reapply.
Its explicit standard-fallback outcome is distinct from original restoration: only owned gateway
settings are removed, with user fields and independent valid selection preserved. Unknown keys,
changed managed fields or damaged restoration records remain conflicts, not permission to capture
new originals or overwrite user data.

Rotation changes credentials without changing model IDs, family/default choices or selecting the
managed profile again. The CLI reports `rotation: "committed"` only for the new active generation;
`rotation: "rolled_back"` means the previous generation was retained/restored and must not claim
revocation of that previous key. Incomplete recovery keeps the operation unresolved. Disconnect
restores Desktop even with `--keep-catalog`; retries preserve the original catalog choice and must
not clear a newer connection. Authorized uninstall completes or resumes owned Desktop cleanup
before removing OpenCodex state, and preserves recovery state when cleanup conflicts or fails.

The server-owned applied marker (`claudeCode.desktopProfile.appliedFingerprint` and
`appliedAt`) is committed through `src/claude/desktop-applied-marker.ts` only while the
persisted desired profile still matches the exact profile handed to the Desktop writer and
its prior fingerprint and time are unchanged. Sync compares profile presence, content and
both marker fields before committing; an initially absent profile can receive a marker, while
a concurrently deleted or changed profile or a newer marker is left intact and the existing
skip outcome is reported. Provider-change auto-apply requires a present profile and emits a
generic diagnostic when the same comparison declines its marker. Default-family key order
does not change desired content; the comparison uses each family's selected route.

The profile PUT in `src/server/management/agent-settings-routes.ts` validates against a
persisted profile snapshot and commits only `claudeCode.desktopProfile` under the config
mutation lock. Client marker fields are discarded. Unchanged desired content keeps the
latest persisted marker, including one committed while the PUT awaited model discovery;
a concurrent desired-profile edit declines the PUT with 409 instead of being overwritten.

These guarantees concern files on disk. Fully quitting and reopening Desktop is required after
apply, rotation/recovery or restoration; there is no automatic process restart or guarantee that
a running app discarded a key. Local disconnect does not revoke the hub key or remove arbitrary
external copies. Model-list snapshot version 1 remains a read-only contract, not a new lifecycle
or profile-upload API. Thinking replay and prompt caching remain separate in #3719.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

Connected `ocx status` diagnostics follow the shared
[status credential binding](../runtime.md#remote-hub-status-credential-binding).

The smaller `_remoteHub` annotation from `src/cli/config-command.ts` is intentionally independent
of Desktop recovery and catalog readiness. It observes only the validated client record and local
data-token ownership, so displaying configuration cannot enter Desktop or client lifecycle work.

## Claude Desktop config-library resolution

The Desktop profile writer and the management status probe share
`resolveDesktop3pConfigLibraryPath`. The resolver reproduces Desktop's own rule rather than a guess:
an explicit `CLAUDE_USER_DATA_DIR` (or the opencodex override) wins; on Windows
`%LOCALAPPDATA%\Claude-3p` wins; otherwise the Electron user-data path gains a `-3p` suffix if it
does not already have one. `configLibrary` is appended to that root.

`Claude-3p` is Desktop's real directory name, assembled at runtime from `"Claude" + "-3p"`, which is
why searching the app bundle for the literal string finds nothing. It is not a legacy path to migrate
away from. Resolution stays a pure function of (env, platform, home) so the Windows branch is
testable on any host: stubbing `process.platform` does not propagate to `os.platform()` under Bun.

> Decision record: [ADR-0046](../decisions/ADR-0046-claude-desktop-config-library-resolution.md)

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](../dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

Client usage transport follows [the runtime contract](../runtime.md#lifecycle), independently of Desktop inference.

The unregistered executor CLI module stores Remote Workspace state separately from client configuration; see [Remote Workspace](../remote-workspace.md).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

Desktop requests routed to the Codex pool use the shared [automatic plan exclusion contract](../providers/openai-accounts.md#automatic-pool-plan-exclusions); explicit account-qualified targets retain their selection semantics.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Provider summary defaults are Responses-specific and do not rewrite connected Claude Desktop profiles. See [inbound compatibility](../data-planes/inbound-compat.md).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

The explicit sync coordinator also accepts Cline CLI as a separate file integration. Its [paired-file recovery](integrations.md#cline-paired-files) is owned by the generic integration journal, independently of Desktop profile snapshots.

`claudeCode.stabilizePromptCache` is a default-off operator setting for
[translated instruction stabilization](../data-planes/inbound-compat.md#opt-in-claude-instruction-stabilization).
Config JSON preserves the boolean; only literal true activates the role-changing transform.
The lightweight top-level CLI help counts Cline CLI among the fifteen registered export clients; registry parity remains covered by the client help and integration tests.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](../providers/openai-accounts.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

OpenCode is a separate launcher: its management catalog read retains local admin authority in the parent, while generated provider blocks reference only the child admission environment. It does not change Desktop configuration ownership.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](../config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

The [compaction routing override](../transports/responses-failover.md#compaction-routing-overrides) is scoped to Codex Responses metadata and original Responses ingress; Claude Messages replay retains its own routing.

## Routed bundled-skill text

`src/claude/inbound.ts` bounds the text-carrier skill-directory probe to 4,096 UTF-16 code units, plus one character to recognize the terminating newline. A longer first line is preserved intact instead of being scanned or stubbed; normal POSIX, Windows, mixed and UNC separators retain their basename matching. The existing 10,000-character payload threshold and `claudeCode.blockedSkills` policy remain: `claude-api` is blocked by default, and an explicit empty list disables elision. Native Anthropic passthrough and tool-call/result pairing are unchanged. `tests/claude-integration/claude-inbound.test.ts` covers the exact 4,096/4,097 boundary and a long newline-free carrier.

## Claude Code picker descriptions

`src/claude/model-info.ts` gives every readable (`idStyle: "readable"`, Claude Code CLI) `/v1/models` row a `description` that Claude Code 2.1.257 and later shows under the picker entry instead of the generic "From gateway": `Routed by OpenCodex to native <slug>` for native rows and `Routed by OpenCodex to <provider>/<model>` for routed rows. The 1M copy keeps the base description and a Fast sibling appends ` · Fast`. Desktop 3P rows keep the ModelInfo shape without a description. `src/claude/gateway-cache.ts` preserves a string `description` when it refreshes and rewrites the gateway-model cache and drops any other type. `tests/claude-integration/claude-model-info.test.ts` and `tests/claude-integration/claude-gateway-cache.test.ts` cover both.

## Claude Code routed aliases and the context window

`src/claude/alias.ts` mints Claude Code CLI aliases as `ocx-claude-<provider>--<model>`, or `ocx-claude2-` with `~s`/`~t` escapes when the model id holds `/` or `~`. The id contains `claude`, which the picker requires, and does not start with `claude-`: Claude Code 2.1.278 accounts an unrecognized `claude-` id at 200k and applies `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to it only with `DISABLE_COMPACT=1`. Saved `claude-ocx-`/`claude-ocx2-` ids still decode, and `src/claude/context-windows.ts` and the connected-client map `readConnectedClaudeContextWindows` in `src/cli/claude.ts` register both spellings at the same window, and `decodeFablePickerAlias` in `src/server/claude-messages.ts` keeps a legacy native Fable picker value on the native passthrough, so a saved selector keeps its window lookup until it is re-picked. `effectiveModelEnv` emits a legacy selector configured in an OpenCodex slot in its current spelling (`currentClaudeAliasSpelling`), so Claude Code applies the window to it; a selection saved by Claude Code's own picker is outside OpenCodex's ownership and keeps 200k accounting until it is re-picked. `isProxyOnlyModelId` in `src/cli/claude.ts` treats all four prefixes as proxy-only for native fallback.

`claudeCode.maxContextTokens` injects only `CLAUDE_CODE_MAX_CONTEXT_TOKENS` on the `ocx claude`, launchd system-env and shell-hook paths; compact stays enabled and neither `DISABLE_COMPACT` nor `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is injected beside it, whatever the value. A `DISABLE_COMPACT` an older release injected and tracked is unset by the system-env produced-key sweep while it still holds the injected `1`; a tracked key the user changed to another value is released from tracking without being deleted, and an untracked user value is never touched. `tests/claude-integration/claude-alias.test.ts`, `claude-context-windows.test.ts`, `claude-cli.test.ts` and `tests/server/system-env.test.ts` cover these.

## Native passthrough tool-call ids

Native Anthropic passthrough in `src/server/claude-messages.ts` forwards the caller's body except for tool-call ids: `sanitizePassthroughToolCallIds` runs the request-scoped allocator from `src/adapters/tool-call-id.ts` over every `*tool_use` id and `*tool_result` `tool_use_id`. Conforming ids are reserved first and stay byte-identical, a non-conforming or overlength id is rewritten to a conforming id of at most 64 characters with call/result pairing kept, and an empty id throws `AnthropicRequestError`, so the request fails with a local 400 before the upstream fetch. `tests/claude-integration/claude-native-passthrough.test.ts` covers rewriting, pairing, the empty id, the overlength id and collision with an existing valid id.
