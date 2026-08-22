# Replit Gateway Companion — Design

Date: 2026-08-22
Status: Phases 1–5 implemented locally; contract **`experimental-pending-canary`**; live Repl canary and written off-platform authorization still open
Scope: user-deployed Replit gateway companion and paired opencodex setup flow

## Goal

Provide a clean-room, user-owned Replit deployment that exposes native OpenAI Chat and
Anthropic Messages wire contracts to an off-platform opencodex client. The companion runs
only inside the user's Replit deployment, reads Replit-managed AI Integration credentials
from environment variables, and never exposes those credentials to the client.

opencodex installs two paired provider entries derived from the deployment origin and a
separate gateway key:

- `replit` — `openai-chat` adapter at `<origin>/v1`
- `replit-anthropic` — `anthropic` adapter at `<origin>` with bearer transport

## Non-goals

- Translating between OpenAI and Anthropic protocols.
- Shipping Replit AI Integrations credentials to opencodex or logging them.
- Importing community proxy code or placing gateway code on the opencodex core request path.
- Automating Replit account actions or integration approval.
- Promoting `replit` / `replit-anthropic` into the canonical provider registry before the
  evidence gate in Phase 5 is satisfied.
- Billable automatic retries, response caching, or protocol normalization.

## Architecture

```text
opencodex (local)
  -> HTTPS + gateway key
  -> user Replit deployment (integrations/replit-gateway)
  -> Replit AI Integrations upstream (OpenAI Chat / Anthropic Messages)
```

The gateway package lives at `integrations/replit-gateway/` and is **not** imported by
`src/`. Ordinary opencodex startup must load no gateway code or timers.

### Credential boundary

| Secret | Owner | Client-visible |
| --- | --- | --- |
| `REPLIT_GATEWAY_KEY` | operator | yes — bearer credential for gateway auth |
| `AI_INTEGRATIONS_OPENAI_*` | Replit runtime | never |
| `AI_INTEGRATIONS_ANTHROPIC_*` | Replit runtime | never |

The gateway key is operator-supplied, stored as a Replit Secret, and required on every
request. Replit-managed integration credentials are read only inside the gateway process
for upstream relay.

### Implementation phases (completed locally)

**Phase 1 — security foundation:** configuration validation, exact model allowlists,
constant-time gateway-key authentication, HTTPS/public-origin validation, bounded request
and header sizes, local concurrency limits, timeout/error classification, redirect rejection,
cancellation primitives, and metadata-only logging.

**Phase 2 — transports:** `GET /healthz`, `GET /v1/models`, and byte-streaming native
relays for `POST /v1/chat/completions` and `POST /v1/messages` with SSE framing
preservation, heartbeat comments, disconnect cancellation, and safe upstream error
forwarding.

**Phases 3–5 — opencodex pairing, CLI/GUI install, and documentation:** provider
derivation, `ocx provider install-replit`, dashboard wizard, localized guides, package
README, and evidence-gate documentation. Canonical registry promotion remains **conditional**
(see below).

### External gates still open

| Gate | Status |
| --- | --- |
| Live disposable Repl canary confirming `AI_INTEGRATIONS_*` names and deployability | **Pending** |
| Written Replit authorization for off-platform routing | **Not obtained** |
| Canonical registry promotion (`replit`, `replit-anthropic`) | **Blocked** until both rows above and `contributing.md` evidence are satisfied |

## Configuration

Environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `REPLIT_GATEWAY_KEY` | yes | Bearer credential for client authentication (**32–512** printable ASCII) |
| `REPLIT_GATEWAY_PUBLIC_ORIGIN` | yes | Public HTTPS origin of this deployment |
| `REPLIT_GATEWAY_OPENAI_MODELS` | yes | Comma-separated exact OpenAI model allowlist |
| `REPLIT_GATEWAY_ANTHROPIC_MODELS` | yes | Comma-separated exact Anthropic model allowlist |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | yes | Observed-convention Replit OpenAI upstream base URL |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | yes | Observed-convention Replit OpenAI upstream API key |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | yes | Observed-convention Replit Anthropic upstream base URL |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | yes | Observed-convention Replit Anthropic upstream API key |
| `PORT` | no | Listen port (default `8080`) |

### Replit integration env names (unverified observed convention)

The four `AI_INTEGRATIONS_*` variables above are **required by name** in the gateway
implementation. They are an **observed convention** from Replit-generated application code,
**not** a published off-platform contract in
[Replit AI Integrations documentation](https://docs.replit.com/features/integrations/replit-ai-integrations).
**Live Replit support is pending disposable Repl canary verification.** Operators must
inspect injected names without printing values and map secrets into the required names if
Replit differs.

### Default limits and optional overrides

| Limit | Default |
| --- | --- |
| Max request body | 32 MiB (`33554432` bytes) |
| Max header bytes | 32 KiB (`32768` bytes) |
| Max concurrent requests | 10 |
| Upstream timeout | 300 s (`300000` ms) |
| Client timeout | 310 s (`310000` ms) |

Optional limit overrides and **accepted ranges** (enforced at startup):

| Variable | Default | Allowed range |
| --- | --- | --- |
| `REPLIT_GATEWAY_MAX_REQUEST_BYTES` | `33554432` | `1024` – `67108864` |
| `REPLIT_GATEWAY_MAX_HEADER_BYTES` | `32768` | `1024` – `262144` |
| `REPLIT_GATEWAY_MAX_CONCURRENT` | `10` | `1` – `100` |
| `REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS` | `300000` | `1000` – `3600000` |
| `REPLIT_GATEWAY_CLIENT_TIMEOUT_MS` | `310000` | `1000` – `3600000` (must be ≥ upstream) |
| `PORT` | `8080` | `1` – `65535` |

Authoritative values: [`replit-gateway-contract-v1.json`](./replit-gateway-contract-v1.json)
(`limits`, `configOverrideBounds`) and `integrations/replit-gateway/README.md`.

Startup fails closed when validation fails. Invalid configuration is never served.

## Registry promotion evidence gate (Phase 5)

Canonical registry promotion for `replit` and `replit-anthropic` remains **conditional**
on written Replit authorization that users may expose their own AI Integrations deployment
to their own off-platform client, plus the provider-evidence requirements in
`docs-site/src/content/docs/contributing.md`:

- documented OpenAI-compatible and Anthropic Messages endpoints
- terms of service and operating legal entity
- resale/routing authorization where applicable
- named maintenance owner
- citable verification date

Until that gate is satisfied, the companion is an opt-in custom-provider workflow only.

## Public contract

The machine-readable gateway contract is versioned at
[`replit-gateway-contract-v1.json`](./replit-gateway-contract-v1.json).

Publication status: **`experimental-pending-canary`** — v1 relays are implemented in code;
live Replit `AI_INTEGRATIONS_*` injection names and deployability remain pending
disposable Repl canary plus official or runtime confirmation.

## Failure behavior

Errors are classified into stable categories (`auth_failed`, `config_invalid`,
`request_too_large`, `headers_too_large`, `unsupported_content_encoding`,
`model_not_allowed`, `concurrency_limited`, `upstream_timeout`, `client_timeout`,
`client_aborted`, `redirect_rejected`, `upstream_error`, `internal`)
and returned without echoing secrets or request bodies.

Common HTTP mappings include `401` auth, `400` disallowed model, `413` body too large,
`415` encoded body (`unsupported_content_encoding`), `429` concurrency, `408` client
timeout, `504` upstream timeout, and `502` upstream/redirect failure.

Logging records metadata only: request id, method, path, status, duration, and error
category. Bodies, authorization headers, and `AI_INTEGRATIONS_*` values are never logged.

## Verification

### Completed local verification

Gateway tests under `integrations/replit-gateway/tests/` cover startup validation, auth,
secret redaction, request bounds, concurrency, redirect policy, relay handoff, SSE
line boundaries, content-encoding rejection, cancellation, contract metadata, and safe
error categories.

opencodex tests under `tests/` and `gui/tests/` cover provider derivation, CLI install
(`ocx provider install-replit`), gateway key input policy, management pairing routes, and
wizard behavior.

Contract fields in `replit-gateway-contract-v1.json` are validated by
`integrations/replit-gateway/tests/contract.test.ts`.

### Still open

- **Live disposable Repl canary** — confirm Replit injects the documented `AI_INTEGRATIONS_*`
  names and that the gateway deploys and relays against real managed integrations.
- **Written off-platform routing authorization** from Replit (or published policy permitting
  user-owned off-platform relay).
- **End-to-end install** against a live warm deployment (install probes are implemented;
  production Repl cold-start behavior is documented but not canaried here).
