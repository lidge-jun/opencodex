# Realtime voice parity with Codex 5505daf388

Single implementation cycle. Source: Codex af91f6ef → 5505daf388 (read-only archive), OpenCodex origin/dev c0f59e4542.
Official references read 2026-11-26: developers.openai.com/api/docs/guides/transcription.md,
.../speech-to-text, .../reference/resources/audio/subresources/transcriptions/methods/create.md,
.../models/gpt-transcribe.md, .../models/gpt-live-1.1.md, .../guides/text-to-speech, .../deprecations.md.

## Why

Codex moved its default GPT-Live model to `gpt-live-1.1-codex` (b05266d61b,
codex-rs/core/src/realtime_conversation.rs:120) and now leaves the voice unset until the call
destination is known: ChatGPT backend calls get `cove` (codex-api/src/endpoint/realtime_call.rs:143),
API calls get `marin` for Frameless sessions (realtime_websocket/protocol.rs:52). Its backend
transcription client names the upload from the MIME type (backend-client/src/client.rs:514).
OpenAI's file transcription now recommends `gpt-transcribe` with `keywords[]` and `languages[]`
and returns detected `languages`; `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `whisper-1`
shut down on 2027-02-26.

The native Codex relay in src/server/live.ts already forwards every Codex realtime header
(including `voice-session-id`), the client's model and close codes, so it does not change.
Through OpenCodex, Codex sees an API base and serializes an unset voice as `marin`; an explicit
`marin` looks identical, so the proxy cannot restore `cove` there. That stays documented only.

## Changes

| File | Change |
| --- | --- |
| src/server/audio-upstream.ts | `LIVE_AUDIO_MODEL = "gpt-live-1.1-codex"`; `resolveLiveAudioModel(model?)` maps `gpt-live-1` → `gpt-live-1-codex`, `gpt-live-1.1` → `gpt-live-1.1-codex`, omitted → default |
| src/server/audio-live.ts | call-create and standalone socket use `resolveLiveAudioModel`; the session the proxy synthesizes gets `audio.output.voice` after the upstream is resolved: keyed API relay `marin`, ChatGPT `cove`. A client-supplied session is never given a voice |
| src/server/audio-transcriptions.ts | keyed relay accepts `gpt-transcribe`; repeated `keywords[]`/`languages[]` only with `gpt-transcribe` on the keyed relay (bounded count, language code check, keyword without `<`, `>`, CR, LF); `language` and `languages[]` together refused; subscription refuses both list fields; JSON result adds well-formed `languages: [{code}]` when upstream returns it; an upload without an extension is named from its MIME (wav, mp3, m4a, webm, ogg) with the old `.webm` fallback |
| tests/server/audio-transcriptions.test.ts | red→green cases for the above |
| tests/server/audio-dictation.test.ts | default/alias handshake URLs; synthesized call-create voice per destination; client session untouched |
| tests/server/api-access-endpoints.test.ts | advertised `liveModel` follows the constant |
| structure/data-planes/inbound-compat.md, docs-site reference/proxy-formats.md (+ es) | default model, aliases, fields, result shape |

## Checks

`bun test tests/server/audio-transcriptions.test.ts tests/server/audio-dictation.test.ts tests/server/api-access-endpoints.test.ts tests/server/api-key-scope-audio.test.ts tests/server/api-key-scope-live.test.ts`,
`bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, docs-*.test.ts, test-layout and file-size ratchet tests.
Tests use fake fetch and local WebSocket fixtures only.

## Risks

A key scoped to `gpt-live-1-codex` that relied on the omitted-model default is now judged against
`gpt-live-1.1-codex`; naming `gpt-live-1` or `gpt-live-1-codex` keeps the old model.
NOT RUN: any live GPT-Live or transcription call, including whether the API-key `/v1/live` upstream accepts `gpt-live-1.1-codex`.


## Amendment after plan audit round 1 (Terra FAIL, 3 blockers)

1. `gpt-transcribe` refuses the singular `language` field (400) whether or not `languages[]` is present; other models keep `language` and refuse `languages[]`/`keywords[]`. Tests assert the upstream multipart body.
2. A client call-create session that names no `model` is forwarded with the resolved default model inserted, so the model judged by the key scope and recorded on the binding is the model the upstream runs. Only `model` is inserted; a client session never gains a voice. The admission predicate is unchanged.
3. Alias rewriting applies only to Frameless (`/v1/live` call-create and Frameless standalone sockets). Realtime standalone sockets keep their query model untouched, and bound joins keep the recorded model. Scoped tests prove the authorized model equals the forwarded model for `gpt-live-1`, `gpt-live-1.1`, an omitted model, a client session without a model, and a rejoin.

Notes adopted: the voice fixture captures call-create bodies; transcription tests cover repeated arrays versus duplicate scalars, array bounds, invalid keywords and codes, malformed `languages` responses, text output, MIME fallback, and Pool versus keyed. `ocx access audio` keeps its own model allowlist (src/cli/access-audio.ts:14) and is unchanged; the docs say `gpt-transcribe` is a keyed HTTP option.


## Amendment after plan audit round 2 (Terra FAIL, same class repeated)

The repeated finding is one class: on the external live paths, a destination that names no model is judged against the default. It covers a Frameless call-create session without `model`, `/v1/realtime/calls` without a session, and a Realtime standalone socket without a query model. The coordinator placed changes to key-scope admission in a separate report-only pull request. That pull request now owns the whole class under one rule: the external path judges the model it forwards, and when nothing names one, a model-scoped key is refused, as on the native path. This unit therefore drops round 1 amendment 2 (inserting a model into a client session). Here, an unnamed destination is judged against the new default exactly as it was judged against the old one, so this unit neither adds nor widens an unnamed case. Every case that names a model, whether directly or through a Frameless alias or the default the proxy itself synthesizes, is forwarded with the model it is judged on.


## Implementation notes (B)

- Call-create aliasing keeps its existing reach: the `gpt-live-1` rewrite already applied to both `/v1/live` and `/v1/realtime/calls` sessions, and `gpt-live-1.1` joins it there. Standalone rewriting stays Frameless-only.
- Bun's multipart parser drops a part's `Content-Type` (observed: a `File` sent as `audio/wav` arrives with `type === ""`), so the upload is identified from its leading bytes (RIFF/WAVE, ID3 or MPEG frame sync, `ftyp`, `OggS`, EBML, `fLaC`) and sent with that name and type. Unknown bytes keep the `.webm` name, as before.
- Red evidence: with the three `origin/dev` sources and the new tests, 12 tests fail; with the change, all pass.

