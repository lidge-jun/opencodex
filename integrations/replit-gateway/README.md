# opencodex Replit gateway companion

User-deployed Bun gateway that exposes native **OpenAI Chat** (`POST /v1/chat/completions`) and
**Anthropic Messages** (`POST /v1/messages`) to an off-platform opencodex client. Replit-managed
AI Integration credentials stay inside your Replit deployment; opencodex only stores a separate
**gateway key** you choose.

This package is **not** imported by the opencodex core runtime. Ordinary `ocx start` loads no
gateway code.

> **Not an official Replit provider.** opencodex does not ship a canonical `replit` registry
> preset. Pairing is an opt-in custom workflow documented at
> [opencodex.me/guides/replit-gateway](https://opencodex.me/guides/replit-gateway/).

> **Deployment verification pending.** The gateway code and contract are implemented, but **live
> Replit deployment is not verified** against Replit's actual injected environment contract. Treat
> this as an experimental companion until a disposable Repl canary and official or runtime
> confirmation exist.

## Prerequisites

- A **paid Replit plan** with [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations)
  enabled for your account or organization (Starter disables managed integrations; Pro/Enterprise
  may require an org admin toggle).
- **Manual integration approval** in the Replit UI when Agent asks to add OpenAI and Anthropic
  managed integrations. opencodex never automates Replit account actions.
- [Bun](https://bun.sh/) on the deployment host (Replit supports Bun).

## Quick start (local or Replit)

### 1. Copy this package

Use the `integrations/replit-gateway/` directory from the opencodex repository as the application
root (or copy it into your Repl). Install dependencies:

```bash
cd integrations/replit-gateway
bun install
```

### 2. Add a server entrypoint

Create `server.ts` beside `package.json`:

```typescript
import { createGatewayServer, loadGatewayConfigFromEnv } from "./src/index.ts";

const config = loadGatewayConfigFromEnv();
const gateway = createGatewayServer(config);

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  fetch: gateway.fetch,
});

console.info(`Replit gateway listening on :${server.port}`);
```

Run it:

```bash
bun run server.ts
```

On Replit, set the **Run** command to `bun run server.ts` and ensure the Repl type forwards
public HTTPS traffic to `PORT` (default `8080`).

### 3. Approve Replit AI Integrations (manual)

In the Replit project editor, ask Agent to add **OpenAI** and **Anthropic** managed integrations
(or enable them through the integrations flow Replit documents). When Replit shows a confirmation
prompt, **approve** each integration yourself.

opencodex documentation and tooling **do not** call Replit APIs or click approval dialogs on your
behalf.

### 4. Confirm Replit-managed environment names (unverified convention)

The gateway requires four exact environment variable **names** below. These names are an
**observed convention** from Replit-generated application code — they are **not** published as an
official Replit off-platform API contract in
[Replit AI Integrations documentation](https://docs.replit.com/features/integrations/replit-ai-integrations),
which describes managed credentials for in-Repl use only.

Inspect which names Replit injected **without printing secret values**:

```bash
# Shell: list matching names only
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u

# Bun/Node (names only)
node -e "console.log(Object.keys(process.env).filter(k=>k.startsWith('AI_INTEGRATIONS_')).sort().join('\n'))"
```

You should see at least:

- `AI_INTEGRATIONS_OPENAI_BASE_URL`
- `AI_INTEGRATIONS_OPENAI_API_KEY`
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY`

If Replit uses different names or omits variables, the documented gateway **cannot start** until
you map values into these exact names (for example via Replit Secrets) or the package is updated
after canary confirmation. **Do not log or commit values.**

### 5. Configure secrets and allowlists

Set these in **Replit Secrets** (or your process environment). Startup **fails closed** if any
required value is missing or invalid.

| Variable | Required | Purpose |
| --- | --- | --- |
| `REPLIT_GATEWAY_KEY` | yes | Bearer credential opencodex sends on every request (**32–512** printable ASCII characters; see below) |
| `REPLIT_GATEWAY_PUBLIC_ORIGIN` | yes | Public HTTPS origin of this deployment (for example `https://my-app.replit.app`) |
| `REPLIT_GATEWAY_OPENAI_MODELS` | yes | Comma-separated **exact** OpenAI model ids you allow |
| `REPLIT_GATEWAY_ANTHROPIC_MODELS` | yes | Comma-separated **exact** Anthropic model ids you allow |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | yes | Observed-convention Replit OpenAI upstream base URL |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | yes | Observed-convention Replit OpenAI upstream API key |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | yes | Observed-convention Replit Anthropic upstream base URL |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | yes | Observed-convention Replit Anthropic upstream API key |
| `PORT` | no | Listen port (default `8080`; Replit usually sets this) |

**Gateway key format:** **32–512** characters, printable ASCII only (`U+0021`–`U+007E`, no spaces
or control characters). This matches opencodex pairing (`ocx provider install-replit` and the
dashboard wizard). Generate with:

```bash
openssl rand -base64 48 | tr -d '\n'
```

Optional limit overrides (defaults and **allowed ranges** enforced by `loadGatewayConfigFromEnv`):

| Variable | Default | Allowed range |
| --- | --- | --- |
| `REPLIT_GATEWAY_MAX_REQUEST_BYTES` | `33554432` (32 MiB) | `1024` – `67108864` (1 KiB – 64 MiB) |
| `REPLIT_GATEWAY_MAX_HEADER_BYTES` | `32768` (32 KiB) | `1024` – `262144` (1 KiB – 256 KiB) |
| `REPLIT_GATEWAY_MAX_CONCURRENT` | `10` | `1` – `100` |
| `REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS` | `300000` | `1000` – `3600000` |
| `REPLIT_GATEWAY_CLIENT_TIMEOUT_MS` | `310000` | `1000` – `3600000` (must be ≥ upstream timeout) |
| `PORT` | `8080` | `1` – `65535` |

Model allowlists use **exact id** matching. A request for a model not listed in the corresponding
env var returns `model_not_allowed` without calling upstream.

### 6. Generate and rotate the gateway key

Store a newly generated key as the `REPLIT_GATEWAY_KEY` secret in Replit. To rotate:

1. Generate a new key and update the Replit secret.
2. Redeploy or restart the gateway so the process reads the new value.
3. Re-run opencodex pairing with the new key (`ocx provider install-replit` with `--replace`, or
   the dashboard wizard replace flow).

Never pass the gateway key on the CLI argv; opencodex reads it from `REPLIT_GATEWAY_KEY`,
`--stdin`, or `--gateway-key-file` only.

### 7. Verify health and models

From any machine that can reach your deployment:

```bash
# Liveness (no auth)
curl -sS "https://my-app.replit.app/healthz"

# Model list (bearer gateway key)
curl -sS -H "Authorization: Bearer $REPLIT_GATEWAY_KEY" \
  "https://my-app.replit.app/v1/models"
```

Expected health body:

```json
{"status":"ok","contractVersion":"1"}
```

`/v1/models` lists ids from `REPLIT_GATEWAY_OPENAI_MODELS` only (OpenAI wire). Anthropic models
are not duplicated on this route.

### 8. Pair opencodex

With the proxy running locally:

```bash
export REPLIT_GATEWAY_KEY='your-gateway-key'
ocx provider install-replit --origin https://my-app.replit.app
```

Or open the dashboard **Providers** page → **Replit gateway…** wizard. See the
[Replit gateway companion guide](https://opencodex.me/guides/replit-gateway/) for custom-domain
opt-in, replace semantics, and limits.

## Public contract

Machine-readable contract: [`docs/superpowers/specs/replit-gateway-contract-v1.json`](../../docs/superpowers/specs/replit-gateway-contract-v1.json)
(publication status: **`experimental-pending-canary`**).

| Route | Auth | Billable |
| --- | --- | --- |
| `GET /healthz` | no | no |
| `GET /v1/models` | bearer | no |
| `POST /v1/chat/completions` | bearer | yes |
| `POST /v1/messages` | bearer | yes |

## Streaming and SSE heartbeats

Billable relays forward upstream response bodies. For `text/event-stream` responses, the gateway
may inject idle SSE comment lines (`: heartbeat\n\n` every 15 seconds by default) **only on
completed line boundaries** so event payload bytes are not split mid-line.

**Delayed-LF policy:** When a CRLF line ending is split across chunks and `\r` arrives without an
immediate `\n`, the implementation may treat the trailing `\r` as a completed line boundary for
heartbeat timing if the `\n` is delayed beyond the heartbeat interval. **Payload bytes are not
modified**; rare split-CRLF cases can differ in line-ending **timing** from a native provider. This
is not a guarantee of byte-identical or timing-identical SSE behavior on every edge case.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Process exits on startup | Missing/invalid env | Read stderr; confirm observed `AI_INTEGRATIONS_*` **names** exist; fix gateway key format and HTTPS `REPLIT_GATEWAY_PUBLIC_ORIGIN` |
| Missing `AI_INTEGRATIONS_*` | Unverified Replit contract | Inspect env **names** without printing values; map into required names or wait for canary confirmation |
| `401` / `auth_failed` | Wrong or missing gateway key | Match `Authorization: Bearer` to `REPLIT_GATEWAY_KEY`; re-pair opencodex after rotation |
| Pairing rejects gateway key | Format mismatch | Use 32–512 printable ASCII; regenerate if needed |
| `400` / `model_not_allowed` | Model not on allowlist | Add exact id to allowlist env var and restart |
| `429` / `concurrency_limited` | Concurrency cap | Wait or raise `REPLIT_GATEWAY_MAX_CONCURRENT` (max `100`) |
| `415` / `unsupported_content_encoding` | Client sent `Content-Encoding: gzip` | Send identity-encoded bodies only (v1) |
| `502` / `upstream_error` after cold start | Replit deployment waking | Retry; expect first request after idle to be slower |
| `504` / `upstream_timeout` | Long generation | Increase timeouts within documented bounds or reduce request size |
| Install probe fails `healthz` | Deployment down or wrong origin | Confirm HTTPS URL, Repl is running, and `/healthz` returns 200 |
| Install probe fails `models` | Key mismatch or allowlist empty | Verify bearer key and non-empty `REPLIT_GATEWAY_OPENAI_MODELS` |
| High Replit credit usage | Billable relays | Usage is billed by Replit at public API rates; opencodex does not cap spend |

Logs are **metadata only** (request id, method, path, status, duration, error category). Bodies,
`Authorization`, and `AI_INTEGRATIONS_*` values are never logged.

## Development

```bash
bun install
bun test tests/
bun run typecheck
```

## Responsibility

You own the Replit deployment, integration approvals, credit spend, gateway key secrecy, model
allowlists, DNS/TLS for any custom domain, and compliance with the **applicable Replit terms** for
your plan. Consumer plans reference the
[Replit Terms of Service](https://replit.com/terms-of-service) (**Replit, Inc.**). Replit's ToS
states that **Pro and Enterprise** service is governed by the
[Replit Commercial Agreement](https://replit.com/commercial-agreement) instead.

opencodex provides pairing tooling only; it is not a Replit partner integration and does not
claim written authorization to route your Replit AI Integrations traffic off-platform.
