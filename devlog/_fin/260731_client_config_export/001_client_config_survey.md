# 001 — External client config survey

Research only. No diffs here; implementation designs live in the decade docs.

Scope of the survey: where a user (or an agent) drops a custom OpenAI-compatible
provider so that Pi and OpenCode can call the opencodex proxy, what JSON those
files require, and whether any cross-vendor standard governs the shape.

## 1. Is there a standard?

No. There is no formal specification body governing agent-client provider
configuration. What exists instead is a stack of de-facto layers:

| Layer | What it standardizes | Who honors it |
|-------|----------------------|---------------|
| OpenAI `/v1` wire (`/chat/completions`, `/responses`, `/models`) | request/response bytes | effectively everyone |
| Anthropic `/v1/messages` wire | request/response bytes | Claude clients, our Messages surface |
| `@ai-sdk/openai-compatible` (Vercel AI SDK) | adapter package name + option names | OpenCode, several TS agents |
| models.dev | model metadata registry (context, cost, modality) | OpenCode, Pi metadata seeds |
| per-client JSON Schema (`https://opencode.ai/config.json`) | one client's config file only | that client |

The consequence for this unit: the transport half is already solved — the proxy
speaks `/v1` and clients speak `/v1`. Everything left is **metadata translation**
into per-client dialects, and each dialect is a moving target owned by one vendor.

Critically, **models.dev does not populate custom providers.** A user-defined
provider block gets no inherited context window, no pricing, no modality flags.
Whatever we do not emit ourselves, the client simply does not know.

## 2. Where custom providers are injected

### OpenCode

Three layers, highest priority first:

| Layer | Location | Notes |
|-------|----------|-------|
| Inline runtime | `OPENCODE_CONFIG_CONTENT` env var | outranks every file; what `ocx opencode` uses today |
| Project | `<git root>/opencode.json` or `.jsonc` | committed per repo |
| Global | `~/.config/opencode/opencode.json`, XDG-aware via `XDG_CONFIG_HOME` | the file most users hand-edit |

JSONC is accepted for the file layers (comments must survive a round trip, which
is why we never rewrite a user's file — see `002`).

V1 schema (current, what we generate):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencodex": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "opencodex",
      "options": { "baseURL": "http://127.0.0.1:10100/v1", "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}" },
      "models": {
        "anthropic/claude-opus-5": { "name": "Claude Opus 5", "limit": { "context": 200000, "output": 32000 } }
      }
    }
  }
}
```

V2 schema (documented at `opencode.ai/v2/docs/models`) renames nearly every key:

| Concept | V1 | V2 |
|---------|----|----|
| container | `provider` | `providers` |
| adapter | `npm: "@ai-sdk/openai-compatible"` | `package: "aisdk:@ai-sdk/openai-compatible"` |
| endpoint | `options.baseURL` | `settings.baseURL` |
| upstream id | `models.<k>.id` | `models.<k>.modelID` |
| credentials | `options.apiKey` / auth store | `env[]` |
| new in V2 | — | `capabilities`, `variants`, `disabled` |

**Decision: stay on V1.** The shipped launcher already emits V1 and that path is
exercised by tests; switching would break it in exchange for `capabilities` and
`variants` fields we have no authoritative data to fill. V2 is recorded here so a
later migration starts from a written diff rather than a re-survey.

### Pi

Single global file: `~/.pi/agent/models.json`.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "$OPENCODEX_API_KEY",
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

Shape differences that matter for the serializer:

- `models` is an **array**, not a keyed object. Model identity lives in `id`.
- `cost` demands all four fields when present.
- `apiKey` supports `$ENV_VAR` interpolation (bare `$NAME`, not `{env:NAME}`).
- `api` selects the wire dialect; `openai-completions` is ours.

**Verification status: UNVERIFIED against a real installation.** The shape above
comes from Pi's published `models.md` and `pi.dev/docs/latest/custom-provider`.
No `~/.pi/agent/models.json` was read on this machine. The first implementation
cycle touching Pi must diff this against a real file before shipping.

### Cross-client field map

| Concept | Pi | OpenCode V1 |
|---------|----|-------------|
| container | `providers` | `provider` |
| adapter | `api: "openai-completions"` | `npm: "@ai-sdk/openai-compatible"` |
| endpoint | `baseUrl` | `options.baseURL` |
| model container | array | keyed object |
| context | `contextWindow` | `limit.context` |
| max output | `maxTokens` | `limit.output` |
| price | `cost{4}` | absent |
| modality | `input[]` | absent |
| key reference | `$VAR` | `{env:VAR}` |

Only four concepts are universal: endpoint, adapter kind, model id, and the
context/output pair. Everything else is one client's luxury.

## 3. Credential handling

All three injection paths support an environment reference, so no exporter needs
to serialize a live `ocx_...` key. Pi takes `$VAR`, OpenCode takes `{env:VAR}`,
and OpenCode additionally has an auth store. AGENTS.md treats token serialization
as a release blocker, so emitting a reference is not merely polite — writing the
plaintext key into an exported file would be a security-review failure.

The exported artifact therefore carries a variable name, and every surface that
hands the file over must also tell the user which variable to export.

## 4. Sources

- Pi: `github.com/earendil-works/pi` `packages/coding-agent/docs/models.md`; `pi.dev/docs/latest/custom-provider`
- OpenCode V1: `opencode.ai/docs/providers`, `opencode.ai/config.json`
- OpenCode V2: `opencode.ai/v2/docs/models`
- AI SDK adapter: `@ai-sdk/openai-compatible`
- Metadata registry: `models.dev`

All external claims were read during the 2026-07-31 P phase. Client schemas drift;
re-verify before any cycle that changes serializer output.
