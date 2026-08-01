# 140.00 — Overview: Remaining jawcode Provider Ports into opencodex

## What this phase is

After prior opencodex port cycles, jawcode still ships **five live providers** that opencodex
does not route today. This phase surveys jawcode's wire/auth/streaming implementations, maps
each provider onto opencodex's **five-adapter** architecture, and produces a sequenced port
plan. It is a **foundation cycle** (research + decision) — three docs (00–02) only.

**No production code changes in this cycle.** Implementation is a later, approval-gated step
(mirror phases `110/00_overview.md:13-14` and `120/00_overview.md:10-11`).

## TL;DR

1. opencodex resolves upstream calls through **exactly five adapters** today
   (`server.ts:72-86`: `openai-chat`, `anthropic`, `openai-responses`, `google`, `azure-openai`).
   Every remaining port either **extends** one of those adapters (auth/URL/body variants) or
   requires a **new adapter id** plus `resolveAdapter()` wiring — there is no sixth slot yet.
2. Of the five un-ported providers, **two are Gemini-family with reuse paths**:
   `google-vertex` (Vertex `streamGenerateContent` + GCP ADC) and `google-antigravity` (Cloud
   Code Assist OAuth envelope over Gemini-shaped SSE). Both are **MEDIUM** effort if the
   existing `google` adapter gains pluggable auth/URL/body hooks (`adapters/google.ts:89-117`).
3. **Three are structurally non-OpenAI-compatible**: `cursor` (HTTP/2 Connect+protobuf agent
   protocol), `amazon-bedrock` (SigV4 + `bedrock-converse-stream` eventstream), `kiro`
   (CodeWhisperer streaming + Bearer + eventstream). Each needs a **new adapter** — **HARD**.
4. Recommended sequencing: **vertex → antigravity → bedrock → kiro → cursor** (easiest auth/wire
   reuse first; cursor last because of bidirectional exec/MCP and conversation state).
5. Model surface (jawcode `models.json` + static lists): **119** bedrock, **145** cursor,
   **15** antigravity, **13** vertex; **kiro** has **8** static models in
   `special.ts:82-91` (none in `models.json`).

## The five-adapter constraint

| Adapter | jawcode APIs it can cover (partially) | Auth modes opencodex supports today |
|---------|--------------------------------------|-------------------------------------|
| `openai-chat` | OpenAI-compatible chat/completions | `key`, `oauth` (`oauth/index.ts:19-64`) |
| `anthropic` | Anthropic Messages | `key`, `oauth` |
| `openai-responses` | Codex/Responses passthrough | `forward`, `key` |
| `google` | `google-generative-ai` (AI Studio) | `key` (`x-goog-api-key`, `google.ts:113`) |
| `azure-openai` | Azure Responses passthrough | `key` |

The `ProviderAdapter` contract (`adapters/base.ts:8-20`) is small: `buildRequest`,
`parseStream`, optional `parseResponse`. Ports must implement that surface (then the existing
bridge in `server.ts` re-encodes to Responses SSE).

## The five un-ported providers (scope of 140)

| Provider | jawcode `Api` | Alive? | Port axis |
|----------|---------------|--------|-----------|
| `google-antigravity` | `google-gemini-cli` (shared wire) | **Yes** — active product | Extend `google` + OAuth |
| `google-vertex` | `google-vertex` | Yes | Extend `google` + GCP auth |
| `cursor` | `cursor-agent` | Yes | **New adapter** + Cursor OAuth |
| `amazon-bedrock` | `bedrock-converse-stream` | Yes | **New adapter** + AWS SigV4 |
| `kiro` | `kiro-streaming` | Yes | **New adapter** + Kiro token import |

**Explicitly out of this list:** `openai-codex` — already covered by opencodex native `openai`
forward + `openai-apikey` options. **`google-gemini-cli`** — excluded as dead per product
direction (Antigravity supersedes it for Cloud Code Assist OAuth).

## Why some ports are hard

| Factor | vertex / antigravity | bedrock / kiro | cursor |
|--------|---------------------|----------------|--------|
| Wire shape | Gemini SSE (`alt=sse`) | Amazon eventstream JSON | Connect+proto over HTTP/2 |
| OpenAI-compat | No (Gemini body) | No | No — agent RPC, not chat |
| Auth | GCP OAuth / ADC | AWS keys / Bearer | Cursor OAuth poll |
| Streaming quirks | CCA wrapper vs Vertex URL | Block-indexed converse events | Bidirectional exec + KV blobs |
| Tool loop | functionCall in SSE | toolUse blocks | Server-driven exec messages |

Cursor is the outlier: jawcode's `cursor.ts` is ~2.6k lines because the upstream is an **agent
runtime** (`AgentService/Run` at `cursor.ts:357-368`), not a completion endpoint. opencodex
would need either a minimal exec stub or a deliberate "text-only, no server tools" subset.

## Relationship to prior phases

| Phase | Axis | Relevance to 140 |
|-------|------|------------------|
| 100 | catalog/policy/error parity (HTTP) | Routed catalog entries need provider config + models |
| 110 | SSE lifecycle reliability | New adapters inherit bridge RC1–RC3 obligations |
| 120 | WebSocket transport parity | Independent; new providers start HTTP/SSE only |
| **140** | **Last jawcode provider ports** | this phase — planning only |

## Scope & baseline

- **In scope:** per-provider survey (`01_`), port design + sequencing + risk table (`02_`).
- **Out of scope (this cycle):** adapter implementation, OAuth CLI/GUI flows, catalog sync
  changes, tests, or config defaults. Those ship only after explicit approval.
- **Evidence baseline:** jawcode at `packages/ai/src/providers/*.ts`, `types.ts:35-61`,
  `descriptors.ts:287-304`; opencodex at `src/adapters/`, `src/oauth/`, `src/server.ts:72-86`.

## Documents

- `01_provider-survey.md` — wire/auth/streaming/quirks per provider with jawcode file:line evidence
- `02_port-plan.md` — adapter reuse vs new, auth plan, difficulty table, sequencing, risks
