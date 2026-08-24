---
title: Replit gateway companion
description: Pair opencodex with your own Replit deployment that relays OpenAI Chat and Anthropic Messages through Replit AI Integrations — an opt-in custom workflow, not a canonical provider preset.
---

The **Replit gateway companion** is a user-owned Bun service in
[`integrations/replit-gateway`](https://github.com/lidge-jun/opencodex/tree/dev/integrations/replit-gateway)
that runs **inside your Replit deployment**. It reads Replit-managed AI Integration credentials from
the Repl environment and exposes two native wire endpoints to opencodex:

```text
opencodex (local)
  -> HTTPS + your gateway key
  -> your Replit deployment (integrations/replit-gateway)
  -> Replit AI Integrations upstream (OpenAI Chat / Anthropic Messages)
```

opencodex never receives `AI_INTEGRATIONS_*` secrets. You supply a separate **gateway key**
(`REPLIT_GATEWAY_KEY`) that opencodex stores locally and sends as `Authorization: Bearer …` on
every gateway request.

> **Custom workflow only.** `replit` and `replit-anthropic` are **not** canonical registry presets.
> opencodex does not claim an official Replit provider, and registry promotion remains blocked
> until written Replit authorization exists (see [Evidence gate](#evidence-gate) below).

> **Experimental — deployment not verified.** Gateway code and the v1 contract are implemented
> (`experimental-pending-canary`), but **live Replit deployment is not verified** against Replit's
> actual injected environment contract. Treat this as experimental until a disposable Repl canary
> and official or runtime confirmation exist.

## What you need

- A **paid Replit plan** with [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations)
  available to your account or organization.
- **Manual approval** when Replit Agent asks to attach OpenAI and Anthropic managed integrations to
  your Repl. opencodex does not automate Replit sign-in, billing, or integration dialogs.
- The gateway package deployed and reachable at a public **HTTPS** origin (typically
  `https://<repl>.replit.app`).
- A running opencodex proxy (`ocx start`) for dashboard pairing or CLI install.

Deploy and configure the gateway using
[`integrations/replit-gateway/README.md`](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md).

## Deploy the gateway (summary)

1. Copy `integrations/replit-gateway/` into a Bun Repl (or run it from a checkout).
2. Add `server.ts` that calls `loadGatewayConfigFromEnv()` and `createGatewayServer()`, then
   `Bun.serve({ fetch: gateway.fetch, port, hostname: "0.0.0.0" })`.
3. Approve **OpenAI** and **Anthropic** Replit AI Integrations in the Replit UI.
4. **Confirm observed `AI_INTEGRATIONS_*` names** Replit injected (see below) — do not assume the
   names match until you inspect them without printing values.
5. Set secrets: `REPLIT_GATEWAY_KEY` (**32–512** printable ASCII), `REPLIT_GATEWAY_PUBLIC_ORIGIN`,
   model allowlists, and the four observed-convention integration variables.
6. Confirm `GET /healthz` and authenticated `GET /v1/models` succeed.

### Replit environment names (unverified convention)

The gateway hard-requires these exact variable **names**:

- `AI_INTEGRATIONS_OPENAI_BASE_URL`
- `AI_INTEGRATIONS_OPENAI_API_KEY`
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY`

They are an **observed convention** from Replit-generated apps, **not** a published off-platform
contract in [Replit AI Integrations docs](https://docs.replit.com/features/integrations/replit-ai-integrations).
**Live Replit support is pending canary verification.**

Inspect names without exposing values:

```bash
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u
```

If names differ, map values into the required names via Replit Secrets or wait for documented
updates after canary confirmation.

Generate a gateway key with **32–512** printable ASCII characters (no spaces or control characters):

```bash
openssl rand -base64 48 | tr -d '\n'
```

Store it only in Replit Secrets and in your local opencodex pairing step — never in git.

## Pair with opencodex

Installation writes **two** custom providers derived from your deployment origin:

| Provider id | Adapter | Base URL | Notes |
| --- | --- | --- | --- |
| `replit` | `openai-chat` | `<origin>/v1` | Live model discovery via `GET /v1/models` |
| `replit-anthropic` | `anthropic` | `<origin>` | Bearer transport; `liveModels: false` (no Anthropic-shaped discovery route) |

Both share the same gateway key. Non-derived fields you already set on an existing pair (selected
models, pacing, custom headers except credential headers) are preserved when you replace the pair.

### CLI — `ocx provider install-replit`

```bash
export REPLIT_GATEWAY_KEY='your-gateway-key'
ocx provider install-replit --origin https://my-app.replit.app
```

Gateway key sources (choose one):

- `REPLIT_GATEWAY_KEY` environment variable
- `--stdin` (one line)
- `--gateway-key-file <path>` (regular file, bounded size, POSIX-safe permissions)

The gateway key **must not** appear on the command line. opencodex rejects keys outside **32–512**
printable ASCII; use the same format in `REPLIT_GATEWAY_KEY` on the gateway.

Useful flags:

| Flag | Effect |
| --- | --- |
| `--allow-custom-domain` | Allow origins whose hostname does not end with `.replit.app` |
| `--replace` | Overwrite an existing `replit` / `replit-anthropic` pair |
| `--set-default` | Set `replit` as `defaultProvider` after install |
| `--json` | Machine-readable output including probe timings |

Before writing config, opencodex probes **non-billable** endpoints only:

- `GET <origin>/healthz` (no auth)
- `GET <origin>/v1/models` (bearer gateway key)

Billable relays are not called during install.

### Dashboard wizard

On **Providers**, click **Replit gateway…** to open the wizard:

1. Enter the deployment **HTTPS origin** and **gateway key**.
2. Optionally enable **Allow custom domain** when the gateway is not on `.replit.app`.
3. Optionally set **replit** as the default provider after install.
4. On success, the wizard shows health and model-discovery probe timings.

If the pair already exists, the wizard asks for explicit confirmation before **Replace pair**.
The companion note in the wizard states this is **not** a canonical registry preset.

## Custom-domain opt-in

By default, opencodex accepts only HTTPS origins whose hostname ends with `.replit.app`. If you
front the Repl with your own domain, pass `--allow-custom-domain` on the CLI or enable the wizard
checkbox.

Custom-domain opt-in is an explicit trust decision. It **does not** prove hostname ownership or
eliminate **DNS rebinding** or **TLS operational responsibility** after install — you must keep DNS
and certificates pointed at your gateway.

opencodex **does** enforce HTTPS URL syntax, runs a destination/DNS assessment before install, and
performs HTTPS probes through pinned outbound transport. Those checks are **point-in-time** and do
not guarantee ongoing control if DNS or TLS changes later.

## Cold starts and availability

Replit deployments may sleep when idle. The first request after a cold start can be slow or return
`upstream_error` / `upstream_timeout` while the Repl wakes. Install-time probes use an 8-second
timeout; retry pairing after the deployment is warm.

The gateway does not retry billable upstream calls automatically.

## Gateway limits (v1 contract)

Default limits from [`replit-gateway-contract-v1.json`](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/replit-gateway-contract-v1.json)
(status **`experimental-pending-canary`**):

| Limit | Default |
| --- | --- |
| Max request body | 32 MiB |
| Max header bytes | 32 KiB |
| Max concurrent requests | 10 |
| Upstream timeout | 300 s |
| Client timeout | 310 s |

Optional env overrides and **allowed ranges** are in the package README (`REPLIT_GATEWAY_MAX_*`,
`PORT`). Upstream HTTP redirects are rejected (`redirect_rejected`).

## Error categories

The gateway returns stable JSON error categories (never echoing secrets or bodies):

`auth_failed`, `config_invalid`, `request_too_large`, `headers_too_large`,
`unsupported_content_encoding`, `model_not_allowed`, `concurrency_limited`, `upstream_timeout`,
`client_timeout`, `client_aborted`, `redirect_rejected`, `upstream_error`, `internal`.

Common HTTP mappings: `401` auth, `400` disallowed model, `413` body too large, `415` encoded
body, `429` concurrency, `408` client timeout, `504` upstream timeout, `502` upstream/redirect
failure.

## Native capabilities (v1)

**Supported** — byte-streaming native relays for:

- OpenAI Chat: `POST /v1/chat/completions`
- Anthropic Messages: `POST /v1/messages`

For `text/event-stream` responses, idle SSE comment lines (`: heartbeat\n\n`, 15 s default) may be
injected on **completed line boundaries** only.

**Delayed-LF heartbeat policy:** When CRLF is split across chunks and `\r` arrives without an
immediate `\n`, the gateway may treat the trailing `\r` as a line boundary for heartbeat timing if
`\n` is delayed beyond the interval. **Payload bytes are not modified**; rare split-CRLF cases may
differ in line-ending **timing** from a native provider. Do not assume timing-identical SSE on
every edge case.

**Non-billable discovery**

- `GET /healthz` → `{ "status": "ok", "contractVersion": "1" }`
- `GET /v1/models` → OpenAI list shape from your OpenAI allowlist

## Unsupported in v1

- Canonical registry preset or provider picker tile for Replit
- Verified official Replit off-platform deployment contract (pending canary)
- Google Gemini, OpenRouter, or other Replit AI Integration providers through this gateway
- OpenAI Responses, image, audio, or transcription routes
- Protocol translation between OpenAI and Anthropic
- Automatic upstream retries, response caching, or normalization
- Browser CORS for direct dashboard-to-gateway calls (opencodex uses server-side HTTP)
- `Content-Encoding` other than identity on client requests
- opencodex live model discovery on `replit-anthropic` (configure Anthropic ids in the gateway
  allowlist and reference them explicitly in routing)
- Any automation of Replit account actions, integration approval, or deployment provisioning

## Privacy, credits, and terms

- **Credential boundary:** Only your gateway key is stored in `~/.opencodex/config.json`. Replit
  integration secrets never leave the Repl.
- **Billing:** Replit AI Integrations usage is billed to your Replit credits at public API prices
  ([Replit docs](https://docs.replit.com/features/integrations/replit-ai-integrations)). opencodex
  does not meter or cap that spend.
- **Terms:** Your use is governed by the **applicable Replit terms** for your plan.
  [Replit Terms of Service](https://replit.com/terms-of-service) (**Replit, Inc.**) applies to
  consumer plans; Replit's ToS states that **Pro and Enterprise** service is governed by the
  [Replit Commercial Agreement](https://replit.com/commercial-agreement) instead. You are
  responsible for compliant use, including whether exposing your own deployment to your own
  off-platform client is permitted — **written off-platform routing authorization was not
  established.**
- **Logging:** Gateway logs are metadata-only. opencodex pairing does not log gateway keys in
  management responses.

## Evidence gate

opencodex maintains provider presets only with primary-source evidence
([Contributing — Evidence required for a canonical preset](/contributing/#evidence-required-for-a-canonical-preset)).
The Replit companion **does not** meet that bar today.

| Evidence item | Status (verified 2026-08-22) |
| --- | --- |
| Documented OpenAI Chat + Anthropic Messages endpoints for **off-platform** clients | **Not established.** [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations) documents in-Repl managed credentials, not a public inference API for external proxies. |
| Replit `AI_INTEGRATIONS_*` env names and base URLs | **Unverified observed convention.** Not published as an official off-platform contract; live Repl canary pending. |
| Terms of service and operating legal entity | **Primary source:** [Replit Terms of Service](https://replit.com/terms-of-service) — **Replit, Inc.**; Pro/Enterprise may be under [Commercial Agreement](https://replit.com/commercial-agreement). |
| Resale / off-platform routing authorization | **Not obtained.** No written Replit authorization that users may expose their own AI Integrations deployment to an off-platform opencodex client. |
| Named maintenance owner | **opencodex:** [@lidge-jun](https://github.com/lidge-jun) (project owner) and [@Ingwannu](https://github.com/Ingwannu) per [`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md). **Replit:** not engaged as a partner for this workflow. |
| Citable verification date | **2026-08-22** — Replit AI Integrations docs and applicable Replit terms reviewed; no off-platform routing policy or official env contract found. |

**Registry promotion blocked.** `replit` / `replit-anthropic` remain absent from
`src/providers/registry.ts` until written Replit authorization, verified env contract, and complete
provider evidence exist. Users may still pair via the experimental custom workflow above.

## See also

- Package README: [`integrations/replit-gateway/README.md`](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)
- Design spec: [`docs/superpowers/specs/2026-08-22-replit-gateway-design.md`](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/2026-08-22-replit-gateway-design.md)
- [Providers](/guides/providers/) — auth modes and custom OpenAI-compatible providers
- [Web dashboard](/guides/web-dashboard/) — Providers page
