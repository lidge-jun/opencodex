# 060 — Phase 4: client machine listener and two-plane GUI

Unit: `260827_remote_hub` · Phase: 4 · Status: diff-level implementation plan

Depends on Phase 3's matching `runtimeRole: "client" + config.json.client`, token-file
ownership, connected sync, and offline disconnect, plus Phase 2's
`src/server/gui-session.ts` `serverOrigin`/`browserOrigin` contract. This phase adds no
provider execution to the client.

## 0. Structural decision

### Context

The current dashboard assumes one same-origin `apiBase`. `gui/src/api.ts:52-60`
explicitly refuses auth on cross-origin URLs, while a connected machine needs shared
pages to call the hub and machine pages to call localhost. The current full server also
cannot be reused as a client listener: it mounts `/v1/*`, provider adapters, and shared
management routes that client mode must not expose.

### Chosen move

- Add an independent, loopback-only Bun listener under `src/client/`. Its route
  allowlist copies the default-404 shape of `loopbackRouteAllowed`
  (`src/server/index.ts:665-680`) but contains only GUI/static, health/readiness,
  `/api/machine/*`, and an opt-in fixed-target relay.
- Branch in `src/cli/index.ts` before dynamically importing the full server. Connected
  mode starts only the machine runtime; disconnected mode follows today's full-server
  path.
- Add one GUI `ApiTargets` owner. Page components continue to receive an `apiBase`, but
  App selects shared vs machine explicitly and the fetch auth layer keeps independent
  in-memory session/CSRF state per logical target.
- Extend the existing `/api/usage` projection with exact `apiKeyId`. Connected Usage
  defaults to that key id and can explicitly toggle hub-wide; disconnected Usage calls
  the local server unchanged. No usage row is copied between stores.

### Rejected alternatives

- A generic localhost reverse proxy: caller-controlled destination/path creates an SSRF
  and credential-forwarding surface. The relay destination is fixed by validated client
  state and redirects are rejected.
- Serving `/v1/*` on the machine listener: Codex/Claude must dial the hub directly, and
  a local data plane would make fallback/provider execution possible.
- One token slot keyed only by browser origin: direct hub and localhost share the same
  browser origin claim but have different server origins and credentials; one slot can
  send a hub session to a machine endpoint or vice versa.
- Mirroring hub usage into local `usage.jsonl`: it creates two authorities and was
  explicitly rejected in `001_interview.md`.

### Dependency direction and invariants

`src/cli/index.ts -> src/client/runtime.ts -> machine-listener/machine-api/hub-relay`.
The client leaf may reuse `src/server/gui-static.ts` and `src/server/management-auth.ts`;
the full server never imports the client listener. No new subsystem import enters
`src/router.ts`, `src/server/lifecycle.ts`, or `src/server/responses/core.ts`.
`src/server/index.ts` is unchanged, so the synchronous window from `Bun.serve` to Lab
activation remains unchanged and contains no new `await`.

## 1. IN / OUT

### IN

- Loopback-only client listener, explicit default-404 route allowlist, GUI assets, and
  local machine-session/CSRF enforcement.
- `GET /api/machine/status`, `GET /api/machine/clients`,
  `POST /api/machine/sync`, `GET|POST /api/machine/shim`, and
  `POST /api/machine/disconnect`.
- Opt-in fixed-target `/api/machine/hub-relay/*` selected only by
  `client.managementTransport === "relay"`.
- GUI machine/shared target discovery, independent auth state, per-call plane routing,
  stable hub-offline states, and mode-aware stop/restart actions.
- Connected usage = hub store filtered to this machine's `apiKeyId` by default, with an
  explicit hub-wide toggle; disconnected usage = local `usage.jsonl` unchanged.

### OUT

- `/v1/*`, providers, OAuth storage, routing, Lab, shared config mutation, or local
  usage persistence on the machine listener.
- Caller-selected relay hosts/schemes, redirects, WebSocket tunneling, arbitrary files,
  cookies, or generic forward-proxy behavior.
- Usage replication, merge, import, backfill, or schema migration.
- Tailscale service installation/deployment docs (Phase 5) and relay rate/backpressure
  hardening beyond fixed bounds (Phase 6).

## 2. File-change map

All existing paths were verified in the current tree. For NEW client paths, `src/`
exists and this phase extends the Phase-3-created `src/client/` leaf; every other NEW
parent exists. No generated `gui/dist` file is edited.

| Action | Exact path | Diff-level change |
|---|---|---|
| NEW | `src/client/machine-auth.ts` | Define machine-session header contract for requests that also carry a hub credential; adapt to existing management-auth validation and strip local headers before relay. |
| NEW | `src/client/machine-api.ts` | Exact `/api/machine/*` route dispatcher and non-secret DTOs; all mutation orchestration stays here. |
| NEW | `src/client/hub-relay.ts` | Fixed destination/path allowlist, header/body bounds, redirect rejection, response filtering, and no-log relay. |
| NEW | `src/client/machine-listener.ts` | Loopback Bun listener, route allowlist/default-404, GUI/session bootstrap, health/readiness, and dispatch to machine API/relay. |
| NEW | `src/client/runtime.ts` | Client-process PID/runtime state, signal/drain handling, start/recycle, and transition to standalone after disconnect. |
| MODIFY | `src/cli/index.ts` | Read client state before full-server import; dynamically start client runtime when connected; retain current standalone branch byte-for-byte. |
| MODIFY | `src/server/management/logs-usage-routes.ts` | Read optional `apiKeyId`, include it in the projection-only filter, keep filtered responses out of the summary cache. |
| MODIFY | `src/usage/summary.ts` | Extend `UsageFilterEcho` and `projectUsageSummary` to filter exact entry `apiKeyId` before model/provider attribution projection. |
| MODIFY | `tests/api-usage.test.ts` | Add exact key slice, no-match, cache-poisoning, and combined surface/provider/model/key filter cases. |
| MODIFY | `tests/usage-summary.test.ts` | Add pure key projection, old-row exclusion, combo behavior, and exact-case id tests. |
| MODIFY | `tests/cli-start-journal-order.test.ts` | Prove connected start skips stale-process journal restore only for a matching durable client owner and starts no full data plane. |
| NEW | `tests/client-machine-listener.test.ts` | Listener bind/allowlist/auth/API/startup/offline matrix. |
| NEW | `tests/client-hub-relay.test.ts` | Fixed target, header separation, body caps, redirects, errors, and SSRF negatives. |
| NEW | `gui/src/api-targets.ts` | Canonical `ApiTargets`, machine-status discovery, per-plane call-base selection, relay URL construction, and disconnected fallback. |
| NEW | `gui/src/connect-pairing.ts` | Own the visible pairing-code form and activation flow: paste a one-time code, POST the exact `/opencodex-session` exchange through the selected direct/relay shared target, and install the returned session only in the shared target's in-memory auth slot. |
| MODIFY | `gui/src/api.ts` | Replace `needsApiAuth`'s one same-origin slot with exact target classification and per-target in-memory session/CSRF state; attach both auth domains only on relay. |
| MODIFY | `gui/src/App.tsx` | Discover targets before page fetches; supply both call bases instead of one page base; machine health remains live when hub is down; connected stop becomes disconnect/recycle; import and MOUNT the `connect-pairing` form in the connected-without-hub-session state (banner slot above page content) so the pairing UI is reachable, not just defined. |
| MODIFY | `gui/src/stop-proxy.ts` | Add mode-aware machine disconnect request while preserving existing standalone `/api/stop` behavior. |
| MODIFY | `gui/src/pages/Startup.tsx` | Keep existing settings/startup-health/windows-tray/startup-action calls on the shared base; use the machine base only for new `/api/machine/*` status/shim sections. |
| MODIFY | `gui/src/pages/Integrations.tsx` | Pass the shared base to all existing integration descendants, including ApiKeys and Grok; pass the machine base only to new local-client controls. |
| MODIFY | `gui/src/pages/ApiKeys.tsx` | Keep existing `/api/keys`, `/v1/models`, and model-test calls on the shared base while mounted under Integrations. |
| MODIFY | `gui/src/pages/Grok.tsx` | Keep existing `/api/grok*` calls on the shared base while mounted under Integrations. |
| MODIFY | `gui/src/pages/Usage.tsx` | Add this-machine/hub-wide scope control, key-id query/cache key, source label, and hub-offline behavior without local fallback. |
| MODIFY | `gui/src/pages/Storage.tsx` | Pass its selected shared `apiBase` through to `StorageWorkspace`. |
| MODIFY | `gui/src/components/storage-workspace/StorageWorkspace.tsx` | Remove module-global `VITE_API_BASE`; use the supplied shared-plane base for Codex-log storage calls. |
| MODIFY | `gui/src/styles-usage-workspace.css` | Style compact usage-source/scope controls and connected/offline qualification without changing layout direction. |
| MODIFY | `gui/src/i18n/en.ts` | Source-of-truth copy keys for pairing code/submit/error, connected source, this machine, hub-wide, hub offline, disconnect, and relay warnings. |
| MODIFY | `gui/src/i18n/de.ts` | Add the same pairing and connection keys. |
| MODIFY | `gui/src/i18n/fr.ts` | Add the same pairing and connection keys. |
| MODIFY | `gui/src/i18n/ja.ts` | Add the same pairing and connection keys. |
| MODIFY | `gui/src/i18n/ko.ts` | Add the same pairing and connection keys. |
| MODIFY | `gui/src/i18n/ru.ts` | Add the same pairing and connection keys. |
| MODIFY | `gui/src/i18n/tr.ts` | Add the same pairing and connection keys. |
| MODIFY | `gui/src/i18n/zh.ts` | Add the same pairing and connection keys. |
| MODIFY | `gui/src/i18n/zh-TW.ts` | Add the same pairing and connection keys. |
| NEW | `gui/tests/api-targets.test.ts` | Target discovery, per-plane call-base selection, relay construction, and hub-down fallback. |
| MODIFY | `gui/tests/api-auth-memory.test.ts` | Independent machine/shared sessions; direct/relay header matrix; no cross-target leakage; bootstrap validation. |
| MODIFY | `gui/tests/api-auth-deadline.test.ts` | Per-target shared resolution/watchdog behavior. |
| MODIFY | `gui/tests/usage-layout.test.ts` | Connected own-key default, hub-wide toggle, disconnected local source, cache partition, and offline rendering. |
| MODIFY | `gui/tests/app-stop.test.ts` | Standalone stop vs connected disconnect/recycle. |
| MODIFY | `gui/tests/integrations-routing.test.ts` | Existing Startup/Integrations/ApiKeys/Grok calls stay shared; only new local-client `/api/machine/*` calls use the machine base. |
| MODIFY | `tests/core-lab-boundary.test.ts` | Existing protected-root and synchronous-start checks remain green; no rule weakening. |

Verified reuse without edits: `src/server/gui-static.ts` serves assets/bootstrap;
`src/server/management-auth.ts` owns session/CSRF validation;
`src/usage/log.ts:80` already persists `apiKeyId`; `src/server/management/api-key-usage.ts:78-89`
already proves exact per-key aggregation; `gui/src/pages/Startup.tsx` and
`gui/src/pages/Integrations.tsx` already accept an `apiBase` prop.

## 3. Machine listener and API contracts

### `src/client/machine-auth.ts`

Relay requests carry two principals and therefore cannot overload one header:

```ts
export const MACHINE_SESSION_HEADER = "x-opencodex-machine-session";
export const MACHINE_GUI_ORIGIN_HEADER = "x-opencodex-machine-gui-origin";
export const MACHINE_CSRF_HEADER = "x-opencodex-machine-csrf-token";

export function requireMachineAuth(
  req: Request,
  state: ManagementAuthState,
  config: OcxConfig,
): Response | null;
export function stripMachineAuthHeaders(headers: Headers): Headers;
```

Ordinary `/api/machine/*` requests may use the existing standard session headers.
Relay requests put the hub principal in standard `x-opencodex-*` headers and the local
machine principal in the three headers above. `requireMachineAuth` maps only the local
triple into a synthetic request for the existing `requireManagementAuth` predicate,
then the relay strips that triple. An admin token still cannot mint or substitute for
a GUI session; the machine principal is issued by loopback page bootstrap and mutation
CSRF checks remain mandatory.

### `src/client/machine-listener.ts`

```ts
export interface MachineListenerDeps {
  state?: OcxClientConnectionConfig;
  managementAuthState?: ManagementAuthState;
  fetchImpl?: typeof fetch;
}

export function machineRouteAllowed(url: URL, req: Request, relayEnabled: boolean): boolean;
export function startMachineListener(
  port?: number,
  deps?: MachineListenerDeps,
): Server<unknown>;
```

The bind hostname is hard-coded `127.0.0.1`; `config.hostname`, wildcard values, and
request headers cannot alter it. The allowlist is evaluated before auth or handlers:

| Method/path | Purpose |
|---|---|
| `GET /healthz` | Process liveness and PID/port identity only. |
| `GET /readyz` | Local machine-plane readiness and role; no hub/provider/account data. |
| `GET /`, `GET /opencodex-session`, static GUI assets, SPA extensionless GET | Existing GUI serving/session bootstrap. |
| `GET /api/machine/status` | Redacted connection and target state. |
| `GET /api/machine/clients` | Selected client/journal/shim status, no secret paths outside approved DTOs. |
| `POST /api/machine/sync` | Connected sync. |
| `GET /api/machine/shim` | Current Codex shim status. |
| `POST /api/machine/shim` | `{ action: "install" | "repair" | "uninstall" }`. |
| `POST /api/machine/disconnect` | Offline-capable restore and scheduled standalone recycle. |
| `/api/machine/hub-relay/*` | Only when relay is explicitly selected; methods/path further constrained by relay. |

Everything else, including every `/v1/*`, `/api/config`, `/api/usage`, provider route,
unknown machine route, wrong method, and WebSocket upgrade returns JSON 404. A future
route is unreachable until added to this function.

### `src/client/machine-api.ts`

```ts
export interface MachineStatusV1 {
  mode: "client";
  connected: true;
  machineBase: string;
  sharedBase: string;
  sharedServerOrigin: string;
  managementTransport: "direct" | "relay";
  apiKeyId: string;
  protocolVersion: 1;
  connectedAt: string;
  catalogSyncedAt?: string;
  hubReachability: "unknown" | "online" | "offline" | "unauthorized";
}

export interface MachineApiDeps {
  sync: typeof syncConnectedClient;
  disconnect: typeof disconnectClient;
  scheduleStandaloneRecycle: () => void;
}

export function handleMachineApi(
  req: Request,
  url: URL,
  state: OcxClientConnectionConfig,
  deps: MachineApiDeps,
): Promise<Response | null>;
```

Status and clients are safe GETs but still require the loopback GUI session, matching
the dashboard management model. Sync, shim mutation, and disconnect require browser
Origin + matching machine CSRF. Bodies are strict, unknown fields rejected, and the
existing bounded management-body limit is reused. Status reports the key id and token
ownership state only; never the token, fingerprint, admin credential, pairing grant, or
raw filesystem contents.

Disconnect calls Phase 3 restore even when the hub is down, returns 202 only after local
state commits, then recycles the process on the same loopback port. The replacement sees
no `config.client` and enters today's standalone full-server path; a browser reload then
reads local `/api/usage`. If restore conflicts, no recycle is scheduled and the client
state remains visible.

### `src/client/runtime.ts` and `src/cli/index.ts`

```ts
export function startClientRuntime(
  options?: { port?: number; block?: boolean },
): Promise<void>;
export function scheduleStandaloneRecycle(): void;
```

`handleStart` reads `ClientConnectionState` before full-server import:

```text
invalid/mismatched role+client -> fail before listener/import/provider timer
runtimeRole=client + connected -> dynamic import src/client/runtime.ts; start machine listener
standalone/absent + disconnected -> dynamic import ../server; run current startServer path
```

The client runtime writes the existing PID/runtime records, installs crash/signal
handlers, drains only its listener, and never starts token/history/provider/catalog
timers. Its runtime record names the actual loopback host/port so existing process
ownership checks remain valid. Client stop preserves connection intent unless the user
requested disconnect; disconnect performs restore and recycle explicitly.

## 4. Fixed-target hub relay

### `src/client/hub-relay.ts`

```ts
export interface HubRelayTarget {
  managementUrl: string;
  browserOrigin: string;
}

export function relayHubManagementRequest(
  req: Request,
  suffix: string,
  target: HubRelayTarget,
  deps?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<Response>;
```

Activation requires all of:

1. valid connected state;
2. `managementTransport === "relay"`;
3. exact `/api/machine/hub-relay/` prefix;
4. valid local machine session (custom headers for relay);
5. suffix exactly `/opencodex-session` with GET bootstrap or POST pairing exchange, or
   inside `/api/` with an allowed HTTP method.

The destination is `new URL(suffix, state.managementUrl)` after rejecting encoded
slashes/backslashes, authority syntax, userinfo, query-host tricks, and path traversal.
The caller supplies no host/scheme/port. `redirect: "manual"`; every 3xx is an error.
Strip `Host`, connection/hop-by-hop headers, machine auth headers, proxy credentials,
cookies, and forwarding headers. Forward only the bounded management header allowlist,
including hub session, GUI-origin, CSRF, and content type.

Two separate rules govern `Origin`, and conflating them is what produced the earlier defect.

**Forwarding.** Whenever the browser sends `Origin`, forward that value verbatim, on every
allowed session-authenticated request: the `POST /opencodex-session` exchange, the `GET`
bootstrap, and every allowed `/api/` method including `POST`, `PUT`, `PATCH`, and
`DELETE`. Never synthesize it from the hub URL, the localhost bind, or the GUI-origin
header, and never drop a value the browser did send.

**Requiring.** The hub's own predicate (Phase 2 §5.2) decides when `Origin` must be
present: mandatory for the pairing exchange and for every mutation, optional for safe
same-browser `GET`/`HEAD` reads. The relay does not tighten or loosen that predicate; a
safe read whose browser sent no `Origin` still relays and still succeeds.

So the relay refuses only when it would otherwise have to invent a value: a mutation
arriving without `Origin` is rejected rather than given a synthesized one.

A previous revision forwarded `Origin` only for the exact `POST /opencodex-session`
exchange. That is both a functional and a security defect. The minted GUI session is
origin-bound and management mutations enforce Origin/CSRF, so a relayed mutation arriving
without `Origin` loses the evidence the hub requires and is refused — the relay silently
breaks every write path it is supposed to carry. Repairing that by synthesizing an
`Origin` would be worse: the relay would be attesting to a fact it did not observe, and
the hub's CSRF check would be validating the relay against itself. The browser value is
the only admissible source, so it is forwarded unchanged or the request does not go.

When the browser sends no `Origin` on a request the Phase-2 predicate requires it for,
the relay refuses rather than inventing one.
Response headers are similarly allowlisted; `Set-Cookie` and hop-by-hop headers are
never returned. Request and response bodies have named constants and abort on overflow.
No URL query, auth header, body, or response body is logged.

The hub sees its fixed canonical server origin and the browser's localhost origin from
Phase 2's split-origin session. Relay mode does not mint a new authority and cannot turn
the local machine session or admin token into a hub `gui-session`.

## 5. GUI two-plane contract

### `gui/src/api-targets.ts`

```ts
export type ApiPlane = "machine" | "shared";
export type SharedTransport = "same-origin" | "direct" | "relay";

export interface ApiTarget {
  id: ApiPlane;
  baseUrl: string;
  serverOrigin: string;
  bootstrapPath: string;
  transport: SharedTransport;
}

export interface ApiTargets {
  connected: boolean;
  machine: ApiTarget;
  shared: ApiTarget;
  apiKeyId?: string;
}

export function standaloneApiTargets(initialBase: string): ApiTargets;
export function targetsFromMachineStatus(initialBase: string, status: MachineStatusV1): ApiTargets;
export function apiBaseForPlane(plane: ApiPlane, targets: ApiTargets): string;
export async function discoverApiTargets(initialBase: string, signal?: AbortSignal): Promise<ApiTargets>;
```

Routing is selected at each call site, not once for a page:

| Call sites | Plane | Rule |
|---|---|---|
| Existing Startup calls (`/api/settings`, `/api/startup-health`, `/api/windows-tray`, `/api/startup-action`) | Shared | Preserve hub-backed behavior. |
| Existing Integrations descendants, including ApiKeys (`/api/keys`, `/v1/models`, model tests) and Grok (`/api/grok*`) | Shared | Preserve provider/config/catalog ownership on the hub. |
| Dashboard, Providers, Models, Subagents, Logs, Usage, Storage, Codex Set existing calls | Shared | Continue to use the hub target. |
| New local status/client/sync/shim/disconnect calls | Machine | Only explicit `/api/machine/*` routes use the machine target. |
| Shell health/version and connected disconnect/recycle | Machine | Remain available independently of hub reachability. |

In a standalone full server, `/api/machine/status` returns 404 and discovery returns one
same-origin target, preserving existing behavior. A connected machine status response
constructs either an exact cross-origin hub base or the local relay prefix. A network
failure to machine status is not interpreted as standalone; App renders a local-plane
startup error so it cannot accidentally send shared requests to an unknown local server.

### `gui/src/api.ts`

Replace global `memoryToken/memoryCsrfToken/memorySessionOrigin` with:

```ts
interface ApiSessionState {
  token: string | null;
  csrfToken: string | null;
  browserOrigin: string | null;
  serverOrigin: string | null;
}

export function configureApiTargets(targets: ApiTargets): void;
```

Target classification uses exact configured base URL/prefix, not arbitrary cross-origin
matching. Each target has an independent 401 resolution gate, prompt-cancel state,
watchdog, session state, and bootstrap URL. A bootstrap is stored only when
`browserOrigin === window.location.origin` and `serverOrigin === target.serverOrigin`.

Header behavior is exact:

| Request | Headers attached |
|---|---|
| Machine endpoint | Machine session in standard GUI headers only. |
| Shared direct | Hub session/admin header + hub GUI-origin/CSRF only; no machine header. |
| Shared relay | Hub session in standard headers plus machine session in custom machine headers; relay strips custom headers before hub. |
| Unknown target/cross-origin URL | No OpenCodex credential and no auth prompt. |

Tokens remain memory-only. Legacy sessionStorage cleanup remains. A 401 on one target
clears/prompts only that target and cannot wipe the other target's newer session.

### `gui/src/App.tsx`

App blocks page resource mounting until target discovery settles, then passes both bases
to mixed pages rather than assigning one plane to the whole page. Health/version polls
machine. Connected hub failure leaves shell, navigation, disconnect, and new local-machine
sections usable; existing shared sections inside Startup and Integrations render the same
stable hub-offline state as other shared calls and never substitute machine data. In
connected mode the power action uses `POST /api/machine/disconnect`; in standalone it
remains `POST /api/stop`.

`StorageWorkspace` must receive the shared base from `Storage.tsx`; its current
module-global `VITE_API_BASE` at `gui/src/components/storage-workspace/StorageWorkspace.tsx:20`
would otherwise bypass plane selection on Codex-log actions.

## 6. Usage source and filtering

### Server projection

`projectUsageSummary` changes to:

```ts
export interface UsageFilterEcho {
  provider: string | null;
  model: string | null;
  apiKeyId: string | null;
  matched: boolean;
  comboOverlap: boolean;
}

export function projectUsageSummary<T extends UsageSummary>(
  summary: T,
  filter: { provider?: string | null; model?: string | null; apiKeyId?: string | null },
  entries?: PersistedUsageEntry[],
): T & { filter?: UsageFilterEcho };
```

`apiKeyId` is trimmed and compared exactly, not lowercased. It filters entries before
attempt/model attribution. Old rows, environment-token rows, and loopback rows have no
matching id and are excluded. Provider/model filtering then applies to the retained
entries as today. Any requested filter bypasses the unfiltered summary cache and never
warms a filtered value under `range:surface`.

### GUI rule

`Usage` receives `{ apiBase, connected, apiKeyId }`:

- connected initial scope = `machine`; request includes
  `apiKeyId=<status.apiKeyId>` and reads the hub's `usage.jsonl`;
- connected explicit toggle = `hub`; omit `apiKeyId` and read the whole hub store;
- disconnected = no scope toggle/query; read the same local `/api/usage` as today;
- hub down = error/stale held hub payload for that exact source key, never local data;
- disconnect/reload = standalone target/cache key, so the local store appears;
- no endpoint writes or mirrors usage rows.

The cache key adds server origin + transport + scope + apiKeyId, preventing a prior
hub-wide payload from appearing as this-machine or a prior connected payload from
appearing after disconnect.

## 7. Test plan

| Test file | Required cases |
|---|---|
| `tests/client-machine-listener.test.ts` (NEW) | IPv4 loopback bind; GUI/bootstrap; exact allowlist; every `/v1/*` 404; unknown/wrong-method 404; safe GET auth; mutation Origin/CSRF; status redaction; sync success/failure; shim actions; disconnect offline; recycle to standalone; invalid state refuses startup; no provider/timer fake invoked. |
| `tests/client-hub-relay.test.ts` (NEW) | Relay disabled 404; direct mode 404; fixed host/path; exact `POST /api/machine/hub-relay/opencodex-session` reaches only hub `POST /opencodex-session`; browser `Origin` forwarded byte-for-byte on the pairing exchange, the GET bootstrap, and each allowed `/api/` POST, PUT, PATCH, and DELETE; a mutation whose browser sent no `Origin` is refused without contacting the hub and without a synthesized value; a safe GET/HEAD whose browser sent no `Origin` still relays and succeeds; direct/encoded traversal and authority injection rejected; redirects rejected; request/response caps; hop-by-hop/cookie/forwarded/machine headers stripped; hub auth retained; timeout/abort; no body/header log. |
| `tests/cli-start-journal-order.test.ts` | Matching durable client journal survives start; missing/mismatched client owner restores; connected branch never starts full server; disconnected branch remains current. |
| `tests/api-usage.test.ts` | Exact `apiKeyId` response/echo; old and other-key rows excluded; no match; combined filters; filtered request cannot poison cache; unfiltered next request remains whole hub. |
| `tests/usage-summary.test.ts` | Pure projection totals/days/models/providers/accounts consistency; exact-case id; combo attempts; absent id; provider/model/key cross-product. |
| `tests/core-lab-boundary.test.ts` | Protected roots import no client subsystem; `startServer` remains non-async and no new top-level-window await. |
| `gui/tests/api-targets.test.ts` (NEW) | Standalone 404 fallback; valid direct/relay status; per-plane call bases; machine-status network failure not standalone; encoded relay paths. |
| `gui/tests/api-auth-memory.test.ts` | Two simultaneous sessions; direct headers; relay dual headers; pasted pairing code exchanges through the selected shared target and stores only the returned shared session in memory; machine custom stripping contract; cross-target 401 races; server/browser-origin mismatch; unknown target receives nothing; no web storage. |
| `gui/tests/connect-pairing.test.ts` (NEW) | RENDERED form test: connected-without-hub-session state mounts the pairing form from App; submitting a pasted code fires the exact POST exchange; success hides the form and populates the shared auth slot; failure renders the error state without clearing the input. |
| `gui/tests/api-auth-deadline.test.ts` | One target watchdog does not block/clear the other; direct and relay bootstrap timeout states. |
| `gui/tests/usage-layout.test.ts` | Connected default key query; hub-wide omission; disconnected local query; source-qualified cache keys; hub-down no local fetch; scope labels/a11y. |
| `gui/tests/app-stop.test.ts` | Standalone `/api/stop`; connected `/api/machine/disconnect`; refusal re-enables action; accepted recycle tolerates connection drop. |
| `gui/tests/integrations-routing.test.ts` | Existing Startup/Integrations/ApiKeys/Grok calls use the shared base; only new `/api/machine/*` local controls use the machine base under direct and relay. |

## 8. Acceptance criteria with activation grounding

| ID | Constructible activation scenario | Expected result |
|---|---|---|
| P4-A1 | Valid connected state, then `ocx start`. | Only a 127.0.0.1 machine listener starts; no full server/provider/timer starts; PID/runtime records name it. |
| P4-A2 | Request every known data/shared route on the machine listener. | Every `/v1/*`, `/api/config`, `/api/usage`, OAuth/provider/Lab path is JSON 404; only explicit machine routes/assets answer. |
| P4-A3 | GET status/clients with valid loopback GUI session, then without it. | Valid request returns redacted DTO; missing/admin-only/expired/wrong-origin session is rejected and no secret/fingerprint leaks. |
| P4-A4 | POST sync/shim/disconnect with valid session but missing/wrong CSRF or browser Origin. | Mutation is rejected before work; exact session+Origin+CSRF reaches the handler. Admin token never becomes GUI session. |
| P4-A4b | Relay every allowed session-authenticated method — GET bootstrap, POST `/opencodex-session`, and `/api/` POST, PUT, PATCH, DELETE — from a browser origin the hub allows. | Each request arrives at the hub carrying the browser's `Origin` byte-for-byte. No case is missing `Origin`, and no case carries a value the browser did not send. |
| P4-A4c | Relay an allowed mutation whose browser request has no `Origin`, then a safe `GET` whose browser request has no `Origin`. | The mutation is refused without contacting the hub and without a synthesized `Origin`. The safe read is relayed unchanged and succeeds, preserving the Phase-2 §5.2 allowance. |
| P4-A5 | Connected direct transport with Phase-2 session issued by an exact `remoteGui.allowedTailscaleUsers` match or a consumed pairing grant; hub CORS includes the localhost browser origin. | Shared requests go directly to exact hub origin with hub headers only; machine pages remain localhost; CORS/session validation succeeds. A non-allowlisted Tailscale identity mints no session and gets no local fallback. |
| P4-A6 | Connected relay transport and valid machine + hub sessions. | Browser sends dual auth domains; relay validates machine session, strips custom headers, forwards hub session only to fixed hub target, and rejects redirect/SSRF variants. |
| P4-A7 | Relay path requested while transport is direct/disabled or caller supplies host/scheme/traversal. | Default 404/refusal before outbound fetch; no credential or body is logged. |
| P4-A8 | Hub becomes unreachable after target discovery. | Shell, machine pages, status, and disconnect remain usable; shared pages show stable hub-offline state and never fetch local substitutes. |
| P4-A9 | Connected Usage opens with key A while hub log contains A, B, environment, loopback, and old rows. | Default totals contain only A rows and echo A; hub-wide toggle contains all hub rows; no local file is read or written. |
| P4-A10 | User disconnects while hub is unreachable; recycle succeeds. | Journal/token/catalog/client state restore locally, replacement starts standalone on same port, reload shows local usage store. |
| P4-A11 | Standalone full server opens the same GUI. | `/api/machine/status` 404 selects same-origin targets; all current pages, auth, stop, usage, and injector output remain unchanged. |
| P4-A12 | Shared direct session 401s while machine session is renewed (and inverse). | Each target resolves/clears only its own in-memory state; no token crosses target and no prompt fan-out occurs. |
| P4-A13 | GUI PR is prepared for review. | PR description uses the repository template and includes screenshots of connected this-machine Usage plus hub-offline machine shell (or a maintainer-approved `gui-screenshot-waived` exception). |
| P4-A14 | Relay-connected GUI has no hub session; user pastes a fresh Phase-2 pairing code and submits the pairing form. | The form is MOUNTED from `gui/src/App.tsx` in that state (rendered test `gui/tests/connect-pairing.test.ts`), `gui/src/connect-pairing.ts` sends the exact POST exchange through `/api/machine/hub-relay/opencodex-session`, the relay forwards browser `Origin` verbatim, and the returned session/CSRF/origins are stored only in the shared target's in-memory slot. |

## 9. Verification — remote only on `lidge-ai`

No Bun test, typecheck, GUI lint/build, or browser suite runs on the local Mac. Create
the phase checkout at `/home/lidgeai/codex-runs/260827-remote-hub-phase4`, owned by
unprivileged `lidgeai`, install root and `gui/` dependencies there, and run:

```bash
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase4 && ./node_modules/.bin/bun run typecheck'\'''
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase4 && ./node_modules/.bin/bun test tests/client-machine-listener.test.ts tests/client-hub-relay.test.ts tests/cli-start-journal-order.test.ts tests/api-usage.test.ts tests/usage-summary.test.ts tests/core-lab-boundary.test.ts'\'''
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase4/gui && ../node_modules/.bin/bun test tests/api-targets.test.ts tests/api-auth-memory.test.ts tests/api-auth-deadline.test.ts tests/usage-layout.test.ts tests/app-stop.test.ts tests/integrations-routing.test.ts && ../node_modules/.bin/bun run lint:i18n && ../node_modules/.bin/bun run lint && ../node_modules/.bin/bun run build'\'''
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase4 && ./node_modules/.bin/bun run privacy:scan'\'''
```

Before the non-trivial GUI/security PR is marked review-ready, run the full repository
and GUI suites on that same remote checkout, never locally:

```bash
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase4 && ./node_modules/.bin/bun run test && cd gui && ../node_modules/.bin/bun test tests'\'''
```

Browser smoke also runs against the remote checkout through an SSH tunnel. Capture and
inspect screenshots for direct connected Usage (this-machine selected), relay connected
Usage, hub-offline machine pages, and post-disconnect standalone Usage. Put the required
GUI screenshots in the PR description; do not commit credentials, session meta, or
screenshots containing tokens. Record remote user/path/HEAD, commands, exit codes,
counts, and screenshot artifact names in C-phase evidence. Do not rerun unchanged green
checks.
