# GUI And Management API SOT

## Dashboard serving

The bundled React dashboard is built into `gui/dist` and served by the same Bun proxy. `ocx gui`
starts the proxy when needed and opens `http://localhost:<port>`.

## API ownership

`src/server/index.ts` authenticates and routes `/api/*`, then delegates the management surface to
`src/server/management-api.ts`:

| Endpoint area | Responsibility |
| --- | --- |
| Config/settings | Read safe config/settings views; mutate supported settings only. Full `PUT /api/config` is disabled so masked secrets are not round-tripped. |
| Providers | Create/update/delete provider configs and enrich registry metadata. |
| Models | Fetch routed model lists, disabled model visibility, and catalog-facing ids. |
| OAuth | Login/status/logout for OAuth-backed providers, plus multiauth account management: `GET /api/oauth/accounts`, `PUT /api/oauth/accounts/active`, `DELETE /api/oauth/accounts` list masked accounts per provider, switch the active one, and remove one. Login accepts `addAccount: true` to force a fresh browser identity. |
| Key providers | Expose API-key provider presets for setup and dashboard flows. Multi-key pool per key-auth provider: `GET /api/providers/keys`, `POST /api/providers/keys`, `PUT /api/providers/keys/active`, `DELETE /api/providers/keys` masked list, add (upsert + activate), switch, and remove keys. `provider.apiKey` always mirrors the active pool entry so routing stays single-key. |
| Subagents | Read/write the featured `subagentModels` list capped at five ids. |
| Logs | Surface request/runtime logs for local diagnosis. |
| Debug | Debug page (`/#debug`): provider + usage toggles, refresh/follow log viewer. `GET/PUT /api/debug`; `GET /api/debug/logs` and `GET /api/debug/usage-logs` (monotonic `after` cursor, legacy `since` accepted). CLI: `ocx debug provider|usage …` (both streams via running proxy API). |
| Usage | `GET /api/usage` aggregate read-only summary derived from `~/.opencodex/usage.jsonl`; measured / reported / unreported / unsupported / estimated counts, daily zero-filled grid, model and provider breakdowns. Never exposes prompts. |
| Stop | `POST /api/stop` — restore native Codex, stop any installed service, and exit the proxy. |

Provider writes must not round-trip masked API keys as real secrets. Dashboard actions that change
model visibility or subagent selection should trigger catalog/cache sync behavior through the server
path that owns it.

## Sidebar stop button

The dashboard sidebar includes a stop button that calls `POST /api/stop`. The button shows a
confirmation prompt, then fires the request and accepts the connection drop (the proxy exits). The
endpoint restores native Codex config, stops any installed service to prevent respawn, and exits.

## UX boundary

The dashboard is a local control surface, not a separate service. It should reflect the same config
and catalog invariants documented in this folder rather than inventing parallel state.

## Usage accounting

`src/usage/log.ts` writes append-only JSONL to `~/.opencodex/usage.jsonl` with file mode `0o600`.
`src/usage/summary.ts` turns that file into the `/api/usage` shape — totals, daily zero-filled
grid, model and provider breakdowns, and `measured / reported / unreported / unsupported / estimated` counts.
Missing usage is never treated as zero. The dashboard Usage tab renders the same shape, and the
main Dashboard surfaces a 30d token / coverage summary. The in-memory `requestLog` is capped at
200 entries and is **not** the source of truth for aggregation — the JSONL on disk is.

For diagnosing upstream-shape / usage-extraction issues run `ocx debug usage on` (or set
`OPENCODEX_USAGE_DEBUG=1` before start). The proxy then writes a rolling debug record per finalized
request to `~/.opencodex/usage-debug.jsonl` (mode `0o600`, auto-trimmed to the most-recent 100 lines
once it exceeds 200) with the upstream content-type, body kind (`sse / json / other / none`), a 2KB
body sample, and the extracted usage. Off by default; the hot path is guarded so production stays
untouched.

## Provider debug logging

Provider transport diagnostics (dropped SSE frames, adapter dial/stream events, etc.) are opt-in:
`ocx debug provider on` / `ocx debug provider off` on the running proxy, the Debug-page toggle, or `OCX_DEBUG=1` on
the next start (legacy `OCX_DEBUG_FRAMES` still enables the same path). Lines
use the `[ocx:<adapter>:<event>]` prefix, go to the proxy terminal, and are buffered for
`ocx debug provider logs` / `ocx debug provider logs -f`. Usage JSONL tails with
`ocx debug usage logs [-f]`. Separate from provider buffered logs above.
