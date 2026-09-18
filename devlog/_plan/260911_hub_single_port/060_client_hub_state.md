# 060 — PR6: a connected client reports the hub's state, not its own

Unit: `devlog/_plan/260911_hub_single_port`. Stack position 6, branch
`codex/260911-l4-client-hub-state`, based on `codex/260911-l4-hub-token-ux` = `8c277294c`
(`test(service): drop the installLaunchd import the restack left unused`), so PR1 launchd repair,
PR2 loopback companion, PR3 hub local clients and PR4 hub token UX are all in ancestry. Sibling of
the docs PR 5 on the same base. Issue: lidge-jun/opencodex#4236.

## The incident this closes

Verbatim from the operator: an agent running on a connected **client** machine read that
machine's local `~/.opencodex/config.json` and `ocx status`, saw `xai ✗ not logged in`, no grok
provider and only five delegable models, and concluded **the hub could not serve grok** — while
the hub has xAI logged in and serves grok.

Nothing malfunctioned. Every number the agent read was correct *about the client*, and a client
stores no provider credentials and no featured roster by design. The defect is attribution: three
surfaces reported local facts in the voice of the system.

1. **`ocx status`.** `collectStatus` read only `readConfigDiagnostics()` plus local probes, and
   the human renderer printed `OAuth logins:` from `oauthLoginSummary()` — this machine's
   credential store, empty on a client. The only hub-aware output was one buried
   `Remote hub: connected (<url>)` line.
2. **The Claude Code spawn surface.** `cmdClaude` gated the roster writer on
   `typeof route === "number"`, false on a connected client (`route` is a `ClaudeRoutingTarget`),
   so `~/.claude/agents/ocx-*.md` was whatever a previous standalone run had left — and when it
   did run it built from local `config.subagentModels`, capped at five. That is the "only 5
   delegable models" the operator saw.
3. **`ocx config show`.** `runtimeRole: "client"` and the `client` block were printed but
   unlabelled, and `client.priorCatalog` — a base64 catalog snapshot up to 64 MB — sat in the
   middle of the document burying them.

## What shipped

### 1. `GET|HEAD /v1/hub-state` on the hub's data plane

`src/remote/hub-state.ts` (contract + caps + `parseHubStateBody`), `src/server/hub-state.ts`
(`buildHubState`, pure), the route in `src/server/index.ts` immediately after `/v1/catalog`, and
one `AUTH_MATRIX` row.

Admission is `resolveApiAuth` + `isAllowedRequestOrigin`, identical to `/v1/catalog` (#809) and
for the same reason: nothing here forwards a caller credential upstream. No query parameters,
`Cache-Control: no-store`, no validator (so no 304 can cross identities), `content-length` set,
HEAD identical minus the body.

Body:

```json
{ "schemaVersion": 1, "runtimeRole": "hub", "hubVersion": "…", "origin": "…|null",
  "providers": [{ "name": "", "adapter": "", "authMode": "key|forward|oauth|local|null",
                  "hasCredential": false, "disabled": false }],
  "oauth": [{ "provider": "", "loggedIn": false }],
  "subagentModels": [], "truncated": false, "claudeCode": { "enabled": true } }
```

A provider the operator marked `disabled` is **not exported at all** (review round, below), so
`disabled` is always `false` from a hub of this version; the field stays in the contract because an
older hub does send `true` and a client reading one must still label the row. `truncated` says out
loud that a cap was hit, so a prefix is never presented as the whole list.

`hasCredential` is the `!!p.apiKey` presence projection `GET /api/providers` already ships.
`loggedIn` is `oauthLoginSummary`'s boolean with the **email and account id dropped, not masked**.
`buildHubState` constructs every row field by field and never spreads a provider or a login
record, which is what makes "no keys, no emails, no account ids" checkable by reading one
function — a spread would silently begin exporting whatever field is added to those records next.

The role gate 404s with its own `hub_state_not_a_hub` code unless `runtimeRole === "hub"`, so a
standalone or client install gains no surface at all. It runs **after** admission on purpose:
answering an anonymous caller would turn the route into a free "is that host a hub?" probe. The
distinct code also keeps `tests/server/api-key-attribution.test.ts` honest — it is what tells
"this host is not a hub" apart from "this build has no such route", and the latter would let every
accepted admission cell pass vacuously.

Bounded by construction (≤200 providers, ≤200 oauth rows, ≤32 roster entries, ≤200 chars per
string) plus a 64 KB ceiling that returns 507 `hub_state_too_large`. Deliberately **not** on
`loopbackRouteAllowed`: the unauthenticated loopback listener exists for inference wires the hub's
own local clients speak, a hub's own `ocx status` reads its config directly, and Ingwannu's review
note on #4236 is explicit that local management discovery goes to the authenticated surface.

### 2. Client side: `fetchHubState` + `resolveHubState` + a 0600 cache

`src/client/hub-client.ts` gains `fetchHubState`, beside `downloadClientCatalog` because it is the
same kind of call: bounded, schema-validated, unconditional GET with the per-client data key. A
404 surfaces as `hub_state_unsupported` — the version-skew case, which the CLI renders as
"upgrade the hub" rather than a bare code that reads like a client bug.

`src/client/hub-state.ts` owns the resolution and the cache. Every failure path — 404, 401,
unreachable, non-JSON, malformed JSON, foreign schema, future schema, oversized — lands on
`stateSource: "cache"` or `"unavailable"` with an operator-facing reason, and **none of them
reaches back into local config**. That substitution is the defect, not a graceful degradation: a
locally sourced report is byte-indistinguishable from a hub-sourced one.

The last good response is cached at `<OPENCODEX_HOME>/hub-state.json` through `atomicWriteFile`
(0600), stamped with the `(serverUrl, apiKeyId, connectedAt)` triple and compared with
`sameClientConnectionOwner`. A stale cache is still the *hub's* state; an unstamped one would be a
*different* hub's after a disconnect and reconnect, which is not staleness but a lie. Symlinked or
oversized cache files are refused rather than followed.

### 3. `ocx status`

`CliStatusJson` gains `runtimeRole` and an always-present `remoteHub` block —
`{ connected, origin, stateSource, reason?, fetchedAt?, ageSeconds?, hubVersion, providers, oauth,
subagentModels, truncated, claudeCodeEnabled }`. `schemaVersion` stays 1 (additive, same rule as
`versionSkew`), and `connection` is untouched: it describes the **link**, `remoteHub` describes
what is on the other end of it.

Human output on a connected client:

```
🔗 State from hub https://hub…:8443: provider credentials, logins and delegable models below are the HUB's, not this machine's.
✅ Proxy: running (PID …) (local)
   …
   OAuth logins (hub https://hub…:8443):
     xai        ✓ logged in
   Providers (hub https://hub…:8443):
     xai        openai-chat — no API key (authMode oauth)
   Delegable models (hub https://hub…:8443): xai/grok-4.6, gpt-5.6-sol
   Hub version: 2.51.0
   Local-only (not used for routing while connected):
   OAuth logins (local):
     xai        ✗ not logged in
```

When the hub cannot be read the banner becomes
`⚠️  Hub <origin>: state unavailable (<reason>) — provider and login lines below are LOCAL and do
not describe the hub.` and the local heading becomes `Local-only credential state (this is NOT the
hub's…)`. A cached read is labelled `cached Ns ago` rather than presented as live.

The banner is the **first** line of the report, above the proxy line, because the failure mode is
a reader taking the provider/login lines in isolation. `(local)` tags go on proxy, health,
dashboard, config, PID file, runtime, runtime source, default provider, Codex autostart, restart
safety, routing detail, service, shim and Codex runtime/version/source/home — and only while
connected, because on a standalone install every line is local and tagging them all would train
the reader to skip the tag.

`remoteHubBannerLine` and `remoteHubStatusLines` live in `src/cli/status.ts` so the sentences are
testable without spawning the CLI, matching `hubStatusLines` from PR4.

### 4. The Claude Code spawn surface

The `typeof route === "number"` gate is gone. `buildClaudeAgentDefs` and `injectClaudeAgentDefs`
take an explicit `rosterOverride`, defaulting to today's behaviour including "unset means the
defaults, an explicit `[]` means none". On a connected client `cmdClaude` passes the hub's roster
through `resolveHubRosterForClaude`; an unreadable hub falls back to the local list **and prints
a warning**, because an unannounced fallback is exactly how this stayed invisible.

`entryParts` already kept the raw id when a provider is absent from local `config.providers`, so
`xai/grok-4.6` yields `ocx-grok-4-6.md` on a credential-less client instead of reaching
`decodeRoutedModelIdOrThrow` and aborting the whole sync. That was latent and untested; it now has
a test.

`syncClaudeAgentDefsAtProxyStartup` uses the same roster from the **cache only** — startup makes
no hub round trip, so an offline hub cannot stand between an operator and a local proxy start.

### 5. `ocx config show`

`_remoteHub` is the **first** key on a client:
`{ connected, origin, note: "provider credentials and model availability live on the hub; run ocx
status" }`. It must be read before the empty `providers` map, not after it. `client.priorCatalog`
prints as `<omitted: N bytes>`, mirroring `sanitizeModelCostsForDisplay`. `connected` is observed
from `collectClientConnectionStatus()`, not assumed from the presence of a `client` block (review
round, finding 3), and when it is false the note names what is wrong instead.

Both are display-only. `config export` emits the real config untouched, so round trips still
validate; a persisted `client.note` was rejected because `clientConnectionSchema` is `.strict()`
and persisted prose drifts.

## Decisions

- **One data-plane read, not a widened `/api/*`.** The client holds only the per-client data key.
  The relay (`/api/machine/hub-relay/*`) is browser-only — it needs a local gui-session and
  forwards whatever hub key the browser supplies — so it is not a CLI channel. Ingwannu's review
  note forbids adding `/api/*` to the unauthenticated listener or copying an admin credential into
  exported client configuration, and this does neither.
- **Booleans only, forever.** Emails, account ids, quotas and usage must never be added: a data
  key opens this. The disclosure delta over `/v1/catalog` and `/v1/models`, stated exactly (the
  first draft said "only two booleans", which was wrong — see the review round): `hasCredential`,
  `loggedIn`, `authMode`, the featured roster, and the NAME and adapter of an **enabled** provider
  those routes omit for want of a usable credential. That last one is the point of the route, and
  it is the whole widening. A `disabled` provider is not exported at all.
- **`authMode` is included** even though it was not in the original sketch. Without it
  `hasCredential: false` on an OAuth provider reads as "not configured" — the precise inference
  that went wrong. It is shape, not secret.
- **The five-row roster cap stays.** It is a Claude Code picker constraint (the Agent tool's model
  argument is a 4-alias enum and the picker shows five rows), not the bug; sourcing the five from
  the wrong machine was. The operator's "only 5 delegable models" is fixed by making those five
  the hub's, and the hub can now change which five without touching the client.
- **`stateSource` is three-valued, and "unavailable" is a reportable outcome.** A two-valued
  ok/failed flag would have invited the same silent local fallback at the next call site.
- **An always-present `remoteHub` object** rather than `null` when disconnected, so a consumer
  never branches on the key existing; `connected: false` carries it.
- **The cache write is a side effect of `ocx status`.** Accepted deliberately: without it an
  offline hub leaves a client with no hub facts at all, and the alternative (fetch-on-demand only)
  makes `ocx claude` useless on a flaky link. The file is 0600, owner-stamped, and holds nothing
  secret.
- **No loopback-listener allowlist entry.** Default per the plan; a hub reads its own config
  directly and has no use for the route.
- **`src/server/management/route-registry.ts` untouched.** That registry declares `/api/*`
  management routes; `/v1/catalog` and `/v1/models` are not in it either. The `AUTH_MATRIX` row is
  the data-plane declaration, and it is driven against a real request by
  `tests/server/api-key-attribution.test.ts`.

## Verification (exact commands, this branch)

```
bun x tsc --noEmit                                                      # clean
bun run privacy:scan                                                    # Privacy scan passed
bun test tests/server/v1-hub-state.test.ts                              #  8 pass 0 fail
bun test tests/server/api-key-attribution.test.ts                       # 25 pass 0 fail
bun test tests/clients/client-hub-state.test.ts                         # 20 pass 0 fail
bun test tests/cli/cli-status-hub-state.test.ts                         # 12 pass 0 fail
bun test tests/cli/cli-status-json.test.ts                              # 53 pass 0 fail
bun test tests/cli/cli-config-show-client.test.ts                       #  6 pass 0 fail
bun test tests/cli/cli-config-command.test.ts                           #  2 pass 0 fail
bun test tests/cli/cli-transport-honesty.test.ts                        # 22 pass 0 fail
bun test tests/claude-integration/claude-agents-inject-client.test.ts   # 14 pass 0 fail
bun test tests/claude-integration/claude-agents-inject.test.ts          # 20 pass 0 fail
bun test tests/claude-integration/claude-agent-startup-sync.test.ts     #  9 pass 0 fail
bun test tests/claude-integration/claude-cli.test.ts                    # 51 pass 0 fail
bun test tests/server/management-route-registry.test.ts                 # 13 pass 0 fail
bun test tests/ci-workflows/docs-remote-hub-claims.test.ts              #  7 pass 0 fail
bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts    # 17 pass 0 fail
```

`bun test tests/server/server-auth.test.ts` is 111 pass / 1 fail — `native passthrough upstream
reset still logs 502 and penalizes the pool`, the same pre-existing failure PR4's devlog (040)
recorded on this exact base. Not a regression; this PR touches one declarative array in
`src/server/auth-cors.ts` and adds a route block to `src/server/index.ts`.

Four new test files, registered in `scripts/test-layout/layout.json` (`explicit`) and
`tests/fixtures/test-layout-expected.json`:

- `tests/server/v1-hub-state.test.ts` — 401 before the role is disclosed, 200 with the data key,
  HEAD, cross-origin 403, 404 on `standalone` and on an absent role, POST refused, and a
  **serialized-body secret scan** with a real-looking provider key and a real-looking OAuth
  credential (access, refresh, email) configured.
- `tests/clients/client-hub-state.test.ts` — every failure mode of the fetch, cache freshness and
  age, owner mismatch, rotated `apiKeyId`, malformed and symlinked cache files, and that a
  missing token never becomes a live read.
- `tests/cli/cli-status-hub-state.test.ts` — the banner and block sentences, plus three spawned
  `ocx status` runs: a live local fake hub (which asserts the client presents its own data key),
  an unreachable hub, and a standalone machine whose output gains no banner and no `(local)`.
- `tests/claude-integration/claude-agents-inject-client.test.ts` — the hub roster drives the defs,
  `xai/grok-4.6` with no local `xai` provider does not throw, the cap still applies, the
  `generated-by: opencodex` marker still protects a user-authored `ocx-*.md`, `injectAgents: false`
  still prunes, and the announced fallback is announced.

No repository-wide suite (operator instruction); hosted CI at the pushed head is the proof.

### Live-hub safety

This machine is a live OpenCodex hub. `ocx service …`, `ocx start/stop/ensure/sync/restore/connect/
disconnect` and `launchctl` were **not** run, and the real `~/.opencodex`, `~/.codex`,
`~/.claude/agents` and `~/Library/LaunchAgents` were not touched. Every test sets
`OPENCODEX_HOME` to a `mkdtemp` directory; `tests/preload.ts` arms `OCX_TEST_HOME_GUARD=1` for
every invocation including a bare `bun test <file>`.

## Review round (PR #4255)

Seven findings, all accepted. The two that mattered are the same mistake the PR itself is about,
committed by the PR: a boundary comment that claimed less disclosure than the code performed, and a
`connected: true` inferred from configuration rather than observed. The rest are honesty gaps —
a reason string that printed a raw error code, a silent truncation, a cache outliving its
connection, an untested 404, and two docs claims.

### 1. The projection exported every provider row, and three comments said otherwise (should-fix)

`buildHubState` mapped **all** of `config.providers`, including rows with `disabled: true`.
`/v1/catalog` and `/v1/models` both filter a disabled provider out (`src/router.ts:490`,
`src/codex/catalog/provider-fetch.ts:512`), so this route was the only data-plane surface that
named one — while `src/remote/hub-state.ts`, the route comment in `src/server/index.ts` and this
devlog all asserted the delta over `/v1/catalog` was "only the two booleans". A wrong boundary
claim is worse than no claim: it is what a future reviewer checks the code against.

Fixed on both sides. `buildHubState` drops a disabled provider entirely — a client cannot route to
it, so absence is the truthful report, and `authMode` already explains a present-but-keyless row
without it. The three comments and the devlog now state the delta exactly: `hasCredential`,
`loggedIn`, `authMode`, the featured roster, and the **name and adapter of an enabled provider the
catalog omits for want of a usable credential**. That last item is the point of the route and the
whole widening.

`HubStateProvider.disabled` stays in the contract, always `false` from a hub of this version. An
older hub does send `true`, and a client reading one must still be able to label the row rather
than present it as routable; dropping the field would have made a new client quietly promote an
old hub's disabled providers.

### 2. `hub_state_http_<status>` and the content-type code printed as bare codes (should-fix)

`fetchHubState` throws `hub_state_content_type_invalid` and `hub_state_http_<status>`
(`src/client/hub-client.ts:497,502`); `hubStateFailureReason` had a case for neither, so the
`ocx status` banner could read `state unavailable (hub_state_http_507)`. That sends an operator
hunting for a client bug when the hub has in fact answered and said something — 507 is the hub's
own `hub_state_too_large`.

Both render as sentences now: "the hub's state response was not JSON" (captive portal, TLS
terminator, error page) and "the hub answered HTTP N to the state request". The prefix branch
validates the suffix is numeric, so a non-numeric code still falls back to the code rather than
printing `HTTP oops`.

### 3. `_remoteHub.connected` was hardcoded `true` (should-fix)

Any config with `runtimeRole: "client"` and a `client` block got `connected: true` — including a
machine whose data key was revoked at the hub, rotated away, or whose token file was deleted. The
presence of configuration is not evidence the connection works, which is #4236 in miniature.

`remoteHubConfigNote` now takes the connection status and requires both halves —
`state === "connected"` **and** `token === "owned"`, the comparison of the token file's
fingerprint against the connection record that only `collectClientConnectionStatus()` performs.
When either fails the note says which (`…its hub data-plane token is missing; run ocx connect
status`) instead of claiming a working link. The parameter is a thunk, so the guard returns first
on a standalone or hub install and the probe never runs; the call site imports `./connect`
dynamically so `ocx config get/set` does not drag the client lifecycle in.

### 4. `.slice(0, MAX_HUB_STATE_PROVIDERS)` truncated silently (nit)

A hub with 240 providers served 200 and said nothing, so a client would have told its reader the
other 40 do not exist. `truncated: boolean` is now part of the contract, set when the provider,
oauth or roster cap is hit, and `remoteHubStatusLines` appends "(the hub truncated this state to
fit its response caps; some rows are not listed)". The parser treats an absent `truncated` as
`false` (an older hub sends no such key) but still refuses a present non-boolean.

### 5. The hub-state cache outlived the connection (nit)

`disconnectClient` removed the token, the catalog and the connection record but left
`<OPENCODEX_HOME>/hub-state.json` naming the former hub's providers and logins. It is owner-stamped
so a reader would reject it, but it is the wrong artifact to leave where someone might read it.
Unlinked after `connection_cleared`, best effort: the disconnect has already succeeded by then and
a stubborn cache file must not fail it or block a retry.

### 6. The loopback 404 was asserted nowhere, and the PR body named the wrong file (nit)

The decision "no `loopbackRouteAllowed` entry" had no test. Now
`tests/server/loopback-listener-integration.test.ts` starts a real hub with the unauthenticated
loopback listener, asks it for `GET /v1/hub-state`, and asserts a 404 whose code is `not_found` —
the **listener's** refusal, not the route's `hub_state_not_a_hub`, which would have proved the
request reached the handler. The same run then reads the route successfully on the public listener
with a data key, so the 404 cannot pass vacuously through a missing route.

The PR body claimed `v1-hub-state.test.ts` pins the standalone 404. It does pin a standalone 404 of
its own, but the admission-matrix proof lives in `tests/server/api-key-attribution.test.ts`;
the body now says so.

### 7. `structure/01_runtime.md` did not mention hub-state (nit)

"Remote Hub hardening ownership" named `src/remote/protocol.ts`, `src/client/hub-client.ts` and
`src/client/hub-relay.ts`. It now also names `src/remote/hub-state.ts` (contract, caps, shared
parser) and `src/client/hub-state.ts` (resolution, owner-stamped 0600 cache, and the rule that a
failed read reports "unavailable" rather than degrading to local state).

### Verification (review round, this machine)

```
bun run typecheck                                           # clean
bun run privacy:scan                                        # Privacy scan passed
bun test tests/server/v1-hub-state.test.ts                  #  9 pass (was 8)
bun test tests/clients/client-hub-state.test.ts             # 26 pass (was 20)
bun test tests/cli/cli-config-show-client.test.ts           #  9 pass (was 6)
bun test tests/cli/cli-status-hub-state.test.ts             # 13 pass (was 12)
bun test tests/cli/cli-status-json.test.ts                  # 54 pass
bun test tests/server/api-key-attribution.test.ts           # 25 pass
bun test tests/server/loopback-listener-admission.test.ts   # 31 pass
bun test tests/server/loopback-listener-integration.test.ts # 36 pass (was 35)
bun test tests/clients/client-connect.test.ts               # 49 pass (cache-removal assertion)
bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts   # 17 pass
```

No new test files, so `layout.json` and `tests/fixtures/test-layout-expected.json` are unchanged.
No repository-wide suite (operator instruction); no `ocx service …`, `ocx start/stop/ensure/sync/
connect/disconnect/status` or `launchctl` was run, and every test kept `OPENCODEX_HOME` in a
`mkdtemp` directory.

## Left undone

- **ko docs.** The paragraph landed in `docs-site/src/content/docs/guides/remote-hub.md` (en)
  only, as scoped. The Korean copy still describes a client that reports its own state.
- **`GET /api/machine/hub-state` on the client's own listener**, so the local dashboard sees the
  same data without a hub gui-session. Sketched in the plan as optional; not built.
- **A `loggedIn: false` hub provider cannot be distinguished from one the hub has never
  configured** in the `oauth` array, because `oauthLoginSummary` enumerates every known OAuth
  provider. That matches what a hub operator sees locally, so it is consistent rather than wrong,
  but a `configured` boolean would be clearer.
- **Staleness policy.** A cached hub state has no expiry; it is reported with its age and the
  reader decides. A TTL that flipped `cache` to `unavailable` after N minutes would need a
  defensible N.
- **`ocx doctor`** still reports local provider/login state on a client. Same class of defect,
  separate surface.
