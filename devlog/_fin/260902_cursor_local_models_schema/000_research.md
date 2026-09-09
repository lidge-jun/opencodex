# 000 — Research: Cursor Private Inference model-capability schema

Unit: `260902_cursor_local_models_schema`. Base: `origin/dev` at `85f7ef92a` (re-anchored after
audit; the worktree HEAD `5fc7d073e` is an ancestor of it). Class C3 (public inbound contract change on
`GET /v1/models`, docs guide, stacked PRs). Research only; no diffs in this document.

## Problem

OpenCodex-routed models appear in the model picker of the Cursor **Private Inference**
build (release track `cursor-local`, `buildFlags.localMode = true`), but the picker shows
no reasoning-effort control. Verified live 2026-09-02 on Cursor Private Inference 3.18.25
(darwin-arm64) against the local proxy at `http://127.0.0.1:10100/v1`: agent turns complete
(`ocx observe logs --json` rows with `inboundProtocol: "chat"`, `admissionKind: "loopback"`,
`provider: openai-p3fa38a`, model `gpt-5.6-sol`), so transport is fine — only the
effort ladder is missing.

## Where the gate is (Cursor side, read from the shipped bundle)

File: `Cursor Private Inference.app/Contents/Resources/app/extensions/cursor-agent-exec/dist/main.js`.

1. Model discovery calls `GET {baseUrl}/models` (`tpe(baseUrl, "/models")`) with
   `authorization: Bearer <apiKey>` and a 2 s timeout, expects `{ data: [...] }`.
2. `extendedCapabilitiesDetected = dme(data)` is true only if **some** row passes the
   zod-style schema `fme`:
   - `api_types`: non-empty string array containing at least one of
     `chat_completions | responses | openai_chat | openai_responses | anthropic_messages`
     (set `lme`);
   - `capabilities` (optional object): `context_length`, `max_output_tokens`
     (finite positive numbers), `output_modalities`, `input_modalities` (string[]),
     `supports_tool_use`, `supports_streaming`, `supports_reasoning`, `supports_vision`
     (booleans), `reasoning_effort` (string[]), `cost` (optional);
   - `cost` (optional).
3. The picker builder `J(model, tier)` attaches the "Reasoning" control only when
   `I(model.id)` (a hard-coded regex table) yields an effort ladder **and**
   `model.extendedCapabilitiesDetected === true`. For entries with
   `effortRequiresReasoningCapability` (Gemini) it also needs
   `capabilities.supports_reasoning !== false`.
4. The ladder shown is Cursor's table, not the gateway's list:
   - `gpt-5.6-(luna|sol|terra)` → `reasoning_effort` in `low|medium|high|xhigh`, default medium
   - `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.7/4.8` → `output_config.effort` low..max
   - `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-4.6` → low..max (no xhigh)
   - `grok-4.3/4.5/4.6`, `grok-build-latest` → `reasoning_effort` minimal..xhigh, default high
   - `gemini-*` → minimal..high, requires `supports_reasoning`
   - bare `gpt-5`, `gpt-5.x` → low..xhigh
   - anything else (e.g. `claude-fable-5-1`, `kimi-k3`) → no control
   The id is normalised first: lower-case, strip everything before the last `/`, strip `@...`.
   So `anthropic/claude-opus-5` matches `claude-opus-5`.
5. On send, the chosen value is written as `reasoning_effort` (chat completions),
   `reasoning.effort` (responses) or `thinking + output_config.effort` (messages).

## What OpenCodex emits today

`src/server/index.ts`, raw OpenAI-list branch of `GET /v1/models` (around line 1481):

```json
{ "id": "gpt-5.6-sol", "object": "model", "created": 0, "owned_by": "openai",
  "supports_reasoning_effort": true, "reasoning_effort": "low",
  "reasoning_efforts": [{ "value": "low", "label": "Low Effort", "default": true }, ...] }
```

No `api_types`, no `capabilities`. `dme` returns false → no effort control. Confirmed by
the live picker (only model names, "Add Models").

## Data available server-side for the new fields

- Effort ladder: `m.reasoningEfforts` / `nativeReasoningEfforts(slug)` (already used).
- Context: `m.contextWindow` / `m.contextCap` for routed rows; `nativeOpenAiContextWindow(slug,
  nativeContextLimits(config))` for native rows (`src/codex/catalog/metadata.ts:266`).
- Vision: `m.inputModalities` includes `"image"` (routed rows; `provider-fetch.ts:675-708`).
- Max output tokens: not tracked for routed rows → omit (optional in Cursor's schema).
- Tool use / streaming: every OpenCodex route supports both → constant `true`.
- Anthropic messages: `/v1/messages` is served for every routed model, but Cursor picks
  `anthropic_messages` only when the base URL path ends in `/messages`; advertising it is
  harmless and true. Keep `api_types: ["chat_completions","responses","anthropic_messages"]`.

## Existing consumers of the raw list that must keep passing

- `tests/grok-models-effort-list.test.ts` (Grok Build ladder shape) — additive fields OK.
- `tests/claude-models-discovery.test.ts` (Claude gateway branch, separate code path).
- `tests/server-combo-failover-e2e.test.ts:824-846` asserts **exact** row literals with `toEqual`
  on six combo/vendor rows (audit blocker 1). Those literals must move to `toMatchObject` while
  keeping the explicit `is_combo` absence check at :846.
- `tests/server-auth.test.ts`, `tests/ollama-native.test.ts`, `tests/provider-outbound.test.ts`,
  `tests/codex-catalog.test.ts`, `tests/gui-management-session.test.ts` read the list without
  key-set equality; all of them run at C as the focused set.

## Platform matrix (release track `cursor-local`)

The update endpoint answers 200 for `darwin-arm64`, `darwin-x64`, `darwin-universal`,
`win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64` (3.18.25, 2026-09-02). Windows ships
a system-setup installer, Linux an AppImage. Product identity is shared with regular Cursor
(`applicationName: cursor`, `dataFolderName: .cursor`, same bundle id), so the two builds
share `~/Library/Application Support/Cursor` / `%APPDATA%\Cursor` / `~/.config/Cursor`
unless launched with `--user-data-dir`.

Configuration surfaces (same on all platforms): Settings → Models → Gateway
(Base URL, API Key), or env `CURSOR_LOCAL_AGENT_BASE_URL`, `CURSOR_LOCAL_AGENT_API_KEY`,
`CURSOR_LOCAL_AGENT_HEADERS`. Env is read via the shell-environment service, so a
GUI-launched app needs the variable in the login environment, not just an interactive rc file.

Cursor sign-in is still required (login wall before the gateway modal). Cursor's own catalog,
Tab completion and cloud agents are unavailable in local mode.

## Distribution stance

Cursor does not document this build (docs, changelog, staff forum answers through 2026-08 all
say inference is cloud-side). The guide must describe how to use the build if the user
already has it and must not host, link or script its download.

## Verifiers (PLAN-VERIFIER-REAL-01, run 2026-09-02)

| Command | Exit | Reads the change target? |
|---|---|---|
| `bun run typecheck` | 0 (baseline) | yes — tsc over `src/**` incl. `src/server/index.ts` |
| `bun test tests/grok-models-effort-list.test.ts` | 0 (baseline) | yes — starts the server and fetches `/v1/models` |
| `bun test tests/cursor-local-models-schema.test.ts` | n/a (new in 010) | yes — asserts the new fields |
| `bun run privacy:scan` | 0 (baseline) | reads docs-site + devlog |
| docs guide | — | human review + `rg downloads.cursor.com docs-site` must return 0 hits |

Full `bun run test` is forbidden by the user for this unit; exact-head CI is the gate.
