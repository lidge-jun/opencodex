# 002 — Management API surface the companion consumes

Research document: what already exists, verified live against `127.0.0.1:10100` on
2026-07-25 and cross-read in `src/`. No proxy change is required by anything here.

## 1. Discovery

`src/config.ts:324` — `resolveRuntimePortPath()` returns `<configDir>/runtime-port.json`,
where the config dir defaults to `~/.opencodex` (overridable by `OPENCODEX_HOME`).

Live content:

```json
{ "pid": 14582, "port": 10100 }
```

Resolution order the app implements:

1. `OPENCODEX_HOME` if set, else `~/.opencodex`.
2. Read `runtime-port.json`; use `port` when it parses and is in `1..65535`.
3. Fall back to `10100`.
4. Host is always loopback (`127.0.0.1`).

`pid` is present and could be liveness-checked, but the app treats a failed HTTP probe
as the authoritative "not running" signal — simpler, and it matches what the user sees.

## 2. Authentication

`src/server/auth-cors.ts:120` — `isApiAuthRequired(config)` returns
`!isLoopbackHostname(config.hostname)`. **On a loopback bind (the default), management
requests need no credential at all.**

When required, `hasValidApiAuth` (`auth-cors.ts:161`) accepts any of:

- `x-opencodex-api-key: <key>`
- `authorization: Bearer <key>`
- `x-api-key: <key>`

validated against `OPENCODEX_API_AUTH_TOKEN` or `config.apiKeys[].key` with
`timingSafeEqual`.

App behaviour: attempt unauthenticated first. On `401`, read the token from the macOS
Keychain and retry with `x-opencodex-api-key`. Never log the token, never write it to
`UserDefaults`, never include it in error strings surfaced to the UI.

## 3. Read endpoints

### `GET /api/settings`

Bind/runtime configuration plus an embedded `startupHealth`. **Exact live key set**
(enumerated, because an earlier draft of this plan assumed a field that does not exist):

```text
codexAutoStart · port · hostname · streamMode · startupHealth · codexRuntime
```

Used for: the port/hostname the app displays, and as the cheapest liveness probe.

**`defaultProvider` is NOT in this response.** It lives in `GET /api/config` (below).

### `GET /api/config`

The safe config DTO (`src/server/auth-cors.ts:287-337` builds it; secrets are stripped).
Live key set:

```text
port · hostname · defaultProvider · codexAutoStart · websockets · providers
```

Live value: `"defaultProvider": "openai"`.

This is the **only** source for `defaultProvider`, which Phase 3 needs to disable the
toggle on the provider that cannot be disabled (§4). `/api/providers` does not mark the
default.

### `GET /api/startup-health`

```json
{
  "routingKind": "opencodex-local",
  "autostartEnabled": false,
  "serviceInstalled": true, "serviceViable": true, "serviceEnabled": true,
  "serviceRunning": true, "serviceStale": false, "serviceConflict": false,
  "serviceSupported": true,
  "shimInstalled": false, "shimHealthy": false,
  "platform": "darwin",
  "routingInjected": true, "localRoutingDependency": true,
  "status": "at-risk",
  "rebootSafe": false,
  "protection": "none",
  "shimCoverage": "none",
  "recommendedCommand": "ocx service install",
  "commands": { "installService": "...", "installShim": "...", "restoreNative": "..." }
}
```

`status` is the single field the menu bar icon derives its state from. Observed values
include `protected` and `at-risk`; the app must treat the field as an open string and
degrade unknown values to a neutral state rather than crashing.

`recommendedCommand` is a **string to display**, never a command the app executes
silently.

### `GET /api/usage`

Accepts `?range=` and `?surface=`.

**Supported ranges are exactly `7d`, `30d`, and `all`** — `src/usage/summary.ts:95-98`:

```ts
export function parseRange(input: string | null | undefined): UsageRange {
  if (input === "7d" || input === "30d" || input === "all") return input;
  return "30d";
}
```

Unrecognized values silently fall back to `30d`. Verified live: requesting
`?range=24h` returned `"range": "30d"` with 30 daily buckets. **There is no 24-hour
contract and no hourly bucketing.** `rangeWindow()` (`summary.ts:105-108`) only ever
produces day-granular windows. Adding an hourly range would require a `src/` change,
which is out of scope, so the UI uses `7d` and labels it truthfully.

```json
{
  "range": "30d", "surface": "all", "since": 1782323333603, "generatedAt": 1784915333603,
  "summary": {
    "requests": 232507, "measuredRequests": 225380, "estimatedRequests": 14618,
    "inputTokens": 33521662469, "outputTokens": 127401110,
    "cachedInputTokens": 31920236280, "reasoningOutputTokens": 25395837,
    "totalTokens": 36536664705, "coverageRatio": 0.969, "estimatedCostUsd": 34018.25
  },
  "days": [ { "date": "2026-06-28", "requests": 1746, "totalTokens": 0, "models": [] } ]
}
```

Note the magnitudes: request counts reach six figures, token counts reach 3.6e10, and
cost reaches five figures. **Every numeric in the UI must be abbreviated and use tabular
figures**; naive rendering destroys the layout. This is a hard design input, recorded in
`003`.

`days[]` is day-granular and is the source for the **usage trend** sparkline. It is not
"recent activity" — see `/api/logs` below for that distinction.

### `GET /api/logs`

`src/server/management/logs-usage-routes.ts:66-69` — returns recent request log entries
through `requestLogDto`, filterable by query params. Each entry carries request time,
model, provider, status, latency, and token counts.

This is the real "recent activity" source, and PR #421 used it. **Decision: not consumed
in v1.** Per-request rows carry model names and timing for a user's actual traffic; a
menu bar popover that is always one click from view is the wrong surface for that, and
the dashboard already renders it with proper filtering. The popover shows aggregate
trend only. This is a deliberate exclusion, not an oversight, and the endpoint stays
available if the requirement changes.

### `GET /api/provider-quotas`

```json
{
  "generatedAt": 1784915336899,
  "reports": [
    { "provider": "openai", "label": "OpenAI (Codex login)", "source": "chatgpt:wham",
      "quota": { "weeklyPercent": 44, "weeklyResetAt": 1785258443, "resetCredits": 3 } },
    { "provider": "anthropic", "label": "Anthropic Claude", "source": "anthropic:oauth-usage",
      "quota": { "weeklyPercent": 58, "weeklyResetAt": 1785265199718,
                 "customWindows": [ { "label": "5h", "percent": 1, "resetAt": 1784928599718 } ] } },
    { "provider": "xai", "label": "xAI Grok", "source": "xai:grok-billing",
      "quota": { "monthlyPercent": 86.83, "monthlyResetAt": 1785542400000 } }
  ]
}
```

Traps the app must handle:

- The window key differs per provider: `weeklyPercent`, `monthlyPercent`, or only
  `customWindows[]`. There is no single canonical percent field.
- `weeklyResetAt` is **seconds** for `openai` (`1785258443`) but **milliseconds** for
  `anthropic` (`1785265199718`). Timestamps must be normalized by magnitude, not by
  assuming a unit.
- `quota` may be absent entirely for a provider with no usage source.

### `GET /api/providers`

```json
[ { "name": "openai", "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "hasApiKey": false, "liveModels": true, "models": [],
    "authMode": "forward", "disabled": false, "codexAccountMode": "pool" } ]
```

`hasApiKey` is a boolean presence flag — the key itself is never returned. `disabled`
drives the toggle in Phase 3.

## 4. Write endpoints

### `POST /api/stop`

`src/server/management-api.ts:136-147`. The full body matters:

```ts
stopServiceIfInstalled();
const restore = restoreNativeCodex();
setTimeout(async () => { await drainAndShutdown(...); process.exit(0); }, 200);
return jsonResponse(restore.success
  ? { success: true,  message: "Proxy stopping, native Codex restored." }
  : { success: false, message: "Proxy stopping, but native Codex restore failed: … Run `ocx restore`." });
```

The response body carries a `success` boolean: `false` when `restoreNativeCodex()`
failed, in which case the proxy still exits but native Codex is left pointing at a port
that is about to close. Clients should decode the boolean and tell the user to run
`ocx restore`; the accompanying `message` is a server-formatted string and should not be
surfaced verbatim.

Three consequences, all load-bearing:

1. **It answers `200` before draining.** The app treats `200` as "stop accepted", not
   "stopped", and re-probes until the port stops answering.
2. **A 200 does not mean the restore succeeded.** See the `success` flag above.
3. **It calls `stopServiceIfInstalled()` first — deliberately stopping launchd so the
   supervisor cannot respawn the proxy.** A service-managed proxy therefore stays down.
   **There is no automatic restart, and no start endpoint exists.** Any UI that says
   "Restart" would be lying. See `030` for the corrected action design.

### `PATCH /api/providers?name=<provider>`

`src/server/management/provider-routes.ts:127`. Body must be a plain object.

For the disabled toggle the body is exactly `{ "disabled": true|false }`:

- `provider-routes.ts:177` — non-boolean `disabled` is `400`.
- `provider-routes.ts:178` — disabling `config.defaultProvider` is rejected `400` with
  `"cannot disable the default provider; set another default first"`. **The app must
  disable the toggle for the default provider and explain why, rather than firing a
  request that is guaranteed to fail.**
- `provider-routes.ts:239` — a `disabled`-only patch skips the heavier merged-shape
  validators, so the toggle stays a cheap, low-risk call.
- `codexAccountMode` is mutually exclusive with every other field
  (`provider-routes.ts:139`) and is **out of scope** for this app.

Unknown provider names return `404`.

## 5. Endpoints deliberately not consumed

`/api/oauth/*` (account operations are a Non-goal), `/api/update/*` (self-update is the
dashboard's job), `/api/debug/*` (verbose, privacy-sensitive), `/api/storage`,
`/api/combos`, `/api/models`, `/api/keys`. Adding them later does not require a proxy
change, so the surface stays extensible.

## 6. Polling contract

| Data | Endpoint | Interval | Rationale |
| --- | --- | --- | --- |
| Liveness + health | `/api/startup-health` | 5 s | Cheap, drives the icon |
| Usage summary | `/api/usage?range=7d` | 60 s | Aggregation is expensive; `7d` is a real range |
| Quotas | `/api/provider-quotas` | 60 s | Upstream-rate-limited |
| Providers | `/api/providers` | on popover open | Changes rarely |
| Config (`defaultProvider`) | `/api/config` | on popover open | Changes rarely |

Polling pauses entirely while the popover is closed except for the 5 s liveness tick, and
backs off to 30 s after three consecutive failures. This keeps an idle menu bar app from
behaving like a load generator against the user's own proxy.
