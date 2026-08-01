# 140.02 — Port Plan (adapter design, auth, sequencing)

**Planning only.** No implementation in cycle 140. Approval gates each sub-phase before code
lands (same contract as `110/00_overview.md:83-84`, `120/00_overview.md:64-66`).

## Design principle: five adapters → extend or add

`resolveAdapter()` (`server.ts:72-86`) is a closed switch. Options per provider:

1. **Extend `google`** — new `OcxProviderConfig` fields (e.g. `googleMode: "ai-studio" | "vertex" | "cloud-code-assist"`) interpreted inside `createGoogleAdapter`.
2. **Add adapter ids** — e.g. `bedrock`, `kiro`, `cursor` with new files under `src/adapters/` and new `case` arms in `resolveAdapter()`.

Adding adapters does not break the "five adapter" *concept* if we treat Google variants as one
adapter with modes; the table below shows both views.

---

## Per-provider port design

### A. `google-vertex` — extend `google` adapter (MEDIUM)

| Aspect | Plan |
|--------|------|
| Adapter | Reuse `google` (`adapters/google.ts`) |
| URL | Branch on config: Vertex path template from `google-vertex.ts:38-51` vs AI Studio `:109-110` |
| Auth | `authMode: "gcp-adc"` (new) or env-driven: refresh Bearer via ported `google-auth.ts` logic; optional `x-goog-api-key` path unchanged |
| Body | Same `messagesToGeminiFormat` — already matches `google-shared` output |
| Config | `project`, `location`, `GOOGLE_CLOUD_*` env aliases |
| Models | Static seed **13** from jawcode bundle + optional future discovery |
| OAuth | **None** — ADC / service account / API key only |

**Effort drivers:** ADC token cache + refresh in opencodex (port ~250 lines from
`google-auth.ts`), config schema, tests with mocked token endpoint.

**Risk:** LOW–MEDIUM — wire matches existing `parseStream` SSE parser (`google.ts:119-184`).

---

### B. `google-antigravity` — extend `google` adapter + OAuth (MEDIUM)

| Aspect | Plan |
|--------|------|
| Adapter | Reuse `google` with `googleMode: "cloud-code-assist-antigravity"` |
| URL | Configurable base + `/v1internal:streamGenerateContent?alt=sse` (`google-gemini-cli.ts:338`) |
| Auth | New `OAUTH_PROVIDERS` entry `google-antigravity` mirroring jawcode `utils/oauth/google-antigravity.ts:160-172` (login + refresh + project id in stored JSON) |
| Body | Wrap flat Gemini body in CCA envelope `{ project, model, request, requestType, userAgent, requestId }` — port `buildRequest` antigravity branches (`681-796`) |
| Headers | Antigravity User-Agent, optional `anthropic-beta` for Claude (`317-324`) |
| Credential shape | Store `{ token, projectId, refreshToken, expiresAt }` as serialized JSON in oauth store (jawcode `parseGeminiCliCredentials` pattern, `143-179`) |
| Models | Dynamic discovery port from `fetchAntigravityDiscoveryModels` — **15** bundled + live fetch |

**Effort drivers:** OAuth onboarding (`loadCodeAssist` / `onboardUser`, `116-172`), antigravity
quirks table in `01_provider-survey.md`, endpoint fallback list.

**Risk:** MEDIUM — Google OAuth client id/secret must ship as env/config
(`GOOGLE_ANTIGRAVITY_CLIENT_ID`, `google-antigravity.ts:10-11`); quota/tier provisioning
failures are user-visible.

---

### C. `amazon-bedrock` — new `bedrock` adapter (HARD)

| Aspect | Plan |
|--------|------|
| Adapter | **New** `src/adapters/bedrock.ts` |
| Wire | Port `ConverseStreamRequest` builder + event handlers from `amazon-bedrock.ts:204-511` |
| Auth | Port `resolveAwsCredentials` + `signRequest` (`aws-credentials.ts`, `aws-sigv4.ts`) — keep zero `@aws-sdk/*` |
| Streaming | Port `decodeEventStream` (`aws-eventstream.ts`) to `src/adapters/` or `src/lib/` |
| Config | `region`, `profile`, optional `AWS_*` env; model ids as Bedrock ARNs/cross-region ids |
| Bridge | Map eventstream → `AdapterEvent` (text/thinking/tool_call_start/delta/end/done) |
| Models | Seed from jawcode filter logic (`openai-compat.ts:2177-2203`) — **119** rows |

**Effort drivers:** SigV4 correctness, thinking/cache/tool edge cases, large model matrix.

**Risk:** HIGH — auth misconfiguration silent failures; thinking signature errors already
diagnosed in jawcode (`amazon-bedrock.ts:355-374`).

---

### D. `kiro` — new `kiro` adapter (HARD)

| Aspect | Plan |
|--------|------|
| Adapter | **New** `src/adapters/kiro.ts` |
| Wire | Port `buildPayload` + `parseKiroPayload` (`kiro.ts:145-305`) |
| Auth | **Import-first**, not full browser OAuth: read kiro-cli SQLite + refresh (`kiro.ts:392-487`, `utils/oauth/kiro.ts:1-50`); optional `ocx login kiro` = import path |
| Headers | Port fingerprint User-Agent builder (`85-98`) — required for upstream acceptance |
| Streaming | Reuse eventstream decoder shared with Bedrock port |
| Models | Static **8** from `special.ts:82-91` |
| Config | `region`, `profileArn`, `KIRO_ACCESS_TOKEN` |

**Effort drivers:** Anti-detection headers, token refresh, conversation id stability.

**Risk:** HIGH — upstream may rate-limit non-IDE clients; ToS/impersonation policy decision
needed before shipping.

---

### E. `cursor` — new `cursor` adapter (HARDEST)

| Aspect | Plan |
|--------|------|
| Adapter | **New** `src/adapters/cursor.ts` (+ protobuf codegen or shared buf module) |
| Transport | HTTP/2 client (`cursor.ts:355-368`) — Bun `http2.connect` |
| Auth | Port `oauth/cursor.ts` poll + refresh into `OAUTH_PROVIDERS.cursor` |
| MVP scope | **Text + thinking only**, exec handlers stubbed (reject server tools with structured error) OR map Codex tool calls to MCP exec if feasible later |
| State | Port minimal `conversationState` + `rootPromptMessagesJson` (`2316-2599`) for multi-turn |
| Models | Dynamic `fetchCursorUsableModels` when logged in — **145** catalog rows |

**Effort drivers:** Protobuf schema maintenance, bidirectional stream, exec loop (optional phase).

**Risk:** VERY HIGH — without exec bridge, Cursor models that invoke native tools may stall;
with exec bridge, opencodex becomes a partial Cursor CLI host.

**Recommended sub-phases:** (1) login + single-turn text, (2) multi-turn state, (3) tool/exec
parity (optional / separate approval).

---

## Difficulty table

| Provider | Adapter strategy | Auth work | Wire complexity | Est. effort | Est. risk |
|----------|------------------|-----------|-----------------|-------------|-----------|
| `google-vertex` | Extend `google` | ADC / API key | Low (Gemini SSE) | **MEDIUM** | Low–Med |
| `google-antigravity` | Extend `google` | OAuth + project onboard | Med (CCA envelope) | **MEDIUM** | Med |
| `amazon-bedrock` | **New `bedrock`** | SigV4 + AWS chain | High (eventstream) | **HARD** | High |
| `kiro` | **New `kiro`** | Token import + refresh | High (eventstream) | **HARD** | High |
| `cursor` | **New `cursor`** | OAuth poll | Very high (Connect/proto/exec) | **HARD+** | Very high |

MLB-style rough grades (20–80): vertex **60**, antigravity **58**, bedrock **45**, kiro **42**,
cursor **35** on "port readiness."

---

## Recommended sequencing

```
140.1 google-vertex     ──► extend google + GCP auth (validates adapter hooks)
140.2 google-antigravity ──► extend google + OAuth (reuses 140.1 hook work)
140.3 amazon-bedrock    ──► new adapter + shared eventstream lib
140.4 kiro              ──► new adapter (reuses eventstream from 140.3)
140.5 cursor            ──► new adapter (isolated; largest unknown)
```

**Rationale:**

1. **Vertex before Antigravity** — both Gemini SSE parsers; vertex avoids OAuth/onboarding
   before CCA envelope work.
2. **Bedrock before Kiro** — establishes `decodeEventStream` once (`kiro.ts:31`, `amazon-bedrock.ts:37`).
3. **Cursor last** — no shared code with prior ports; exec/MCP scope can ship independently.

Parallelization: 140.1 + 140.3 can run in parallel after plan approval (disjoint files).

---

## Shared infrastructure (cross-cutting)

| Component | Consumers | jawcode source |
|-----------|-----------|----------------|
| Eventstream decoder | bedrock, kiro | `aws-eventstream.ts` |
| SigV4 signer | bedrock | `aws-sigv4.ts`, `aws-credentials.ts` |
| GCP ADC | vertex | `google-auth.ts` |
| OAuth registry entry | antigravity, cursor | pattern: `oauth/index.ts:19-64`, `oauth/xai.ts` |
| `google` adapter hooks | vertex, antigravity | refactor `google.ts:93-116` |

---

## opencodex config sketch (non-binding)

Illustrative only — not implemented this cycle:

```json
{
  "google-vertex": {
    "adapter": "google",
    "googleMode": "vertex",
    "authMode": "gcp-adc",
    "project": "${GOOGLE_CLOUD_PROJECT}",
    "location": "${GOOGLE_CLOUD_LOCATION}",
    "models": ["gemini-3-pro-preview"]
  },
  "google-antigravity": {
    "adapter": "google",
    "googleMode": "cloud-code-assist",
    "authMode": "oauth",
    "baseUrl": "https://daily-cloudcode-pa.googleapis.com",
    "defaultModel": "gemini-3-pro-high"
  },
  "amazon-bedrock": {
    "adapter": "bedrock",
    "authMode": "aws",
    "region": "us-east-1",
    "defaultModel": "us.anthropic.claude-opus-4-6-v1"
  }
}
```

---

## Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Bridge RC1/RC3 (phase 110) on new adapters | Codex stream errors | Reuse `done` terminal + heartbeat patterns from existing adapters |
| OAuth secret distribution (Antigravity) | Login blocked | Document env vars; no secrets in repo |
| AWS/Kiro credential exposure in logs | Security | Follow opencodex redaction conventions from existing oauth store |
| Cursor tool deadlock without exec | Hung streams | MVP: cap models to non-agent/composer-only; document limitation |
| Bedrock model id drift | Wrong ARN | Live sync from models.dev or periodic jawcode bundle import |
| Sixth adapter proliferation | Maintenance | Keep Google as one adapter with modes; share eventstream module |

---

## Verification plan (for implementation phases)

| Provider | Minimal proof |
|----------|---------------|
| vertex | `ocx` stream with ADC; compare SSE parts to jawcode golden |
| antigravity | `ocx login google-antigravity`; one tool call + thinking model |
| bedrock | Converse stream against `us.anthropic.claude-*`; SigV4 unit test |
| kiro | Import kiro-cli token; `kiro-auto` single turn |
| cursor | OAuth login; single-turn text on `composer-*`; multi-turn regression |

Run `bun test` + `bun x tsc --noEmit` after each sub-phase (baseline per `110/00_overview.md:85-86`).

---

## Out of scope (implementation cycles)

- `google-gemini-cli` provider (dead; Antigravity replaces)
- Full Cursor exec parity (shell/MCP/computer-use)
- Bedrock non-Converse APIs (InvokeModel legacy)
- Kiro browser OAuth from scratch (import-only v1)
- WebSocket upstream for any of these (phase 120 scope)
- Catalog `supports_websockets` changes

---

## Approval checklist (before coding)

- [ ] User approves adapter extension vs new-id layout for Google modes
- [ ] User approves Antigravity OAuth env var requirement
- [ ] User approves Cursor MVP scope (text-only vs exec)
- [ ] User approves Kiro IDE-impersonation headers ethically / ToS
- [ ] Sequencing 140.1–140.5 accepted or reordered
