# 002 — Live Cloud Code Assist evidence

Probes run 2026-09-03 from this worktree against `daily-cloudcode-pa.googleapis.com` using the
already-stored local Antigravity OAuth credential and the repository's own
`ANTIGRAVITY_REQUEST_UA`. No token, refresh token, or project id was printed or persisted; the
probe scripts were removed after the run.

## `v1internal:fetchAvailableModels` — the 3.8 rows

| Wire id | displayName | maxTokens | maxOutputTokens | supportsThinking | thinkingBudget | minThinkingBudget | supportsImages | supportsVideo |
|---|---|---:|---:|---|---:|---:|---|---|
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) | 1048576 | 65536 | true | 1000 | 32 | true | true |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | 1048576 | 65536 | true | 4000 | 32 | true | true |
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | 1048576 | 65536 | true | -1 | 32 | true | true |

**There is no `gemini-3.8-flash-tiered` row.** The payload does contain
`gemini-3.7-flash-tiered` and `gemini-3.6-flash-tiered`, so its absence for 3.8 is a fact about
this generation, not a gap in the probe.

## `agentModelSorts` Recommended order (verbatim)

```
gemini-3.8-flash-high, gemini-3.8-flash-medium, gemini-3.8-flash-low,
gemini-3.7-flash-high, gemini-3.7-flash-medium, gemini-3.7-flash-low,
gemini-3.6-flash-high, gemini-3.6-flash-medium, gemini-3.6-flash-low,
gemini-pro-agent, gemini-3.1-pro-low, claude-sonnet-4-6,
claude-opus-4-6-thinking, gpt-oss-120b-medium
```

Two things follow. 3.8 outranks every other Flash generation, so it is the natural default. And
**3.7 and 3.6 are both still being served** — the "previous Flash is pulled immediately"
premise behind the 3.6 deprecation does not apply here.

## `v1internal:generateContent` — all three tiers accept inference

Minimal one-line prompts with `generationConfig.thinkingConfig.thinkingLevel` set to the
matching tier:

| Wire model | HTTP | Output marker |
|---|---:|---|
| `gemini-3.8-flash-low` | 200 | `OK-LOW` |
| `gemini-3.8-flash-medium` | 200 | `OK-MEDIUM` |
| `gemini-3.8-flash-high` | 200 | `OK-HIGH` |

This is the same pre-exposure proof the 3.6 rollout recorded: all three ids accept inference
before any catalog change ships, so the ladder in `010` cannot advertise a rung the backend
would reject.

## What the running proxy does with them today

`ocx models live --provider google-antigravity` currently publishes the three 3.8 ids as
**separate uncollapsed rows with `reasoningEfforts: []`** — the same broken shape #1897
described. Discovery finds them, and no static rule knows they are one model, so they arrive as
three effortless picker entries. That is the defect wp1 closes.

## Security boundary for these probes

- Assets: local Antigravity OAuth access token and discovered project id.
- Trust boundary: local read of the existing credential store, then HTTPS to the fixed
  registry-owned base URL. Model text cannot choose the destination, headers, or credential.
- Controls: nothing credential-bearing printed or written; probe files deleted after the run.
- Blast radius: three minimal quota-consuming inference calls. No configuration mutated.
