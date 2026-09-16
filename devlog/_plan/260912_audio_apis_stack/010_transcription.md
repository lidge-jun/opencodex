# File transcription

Depends on wp0. This layer owns the unary audio transport and the shared upstream boundary used by wp2.

## File changes

| Operation | Path | Contract change |
| --- | --- | --- |
| NEW | src/server/audio-upstream.ts | audio model constants, proxy-owned upstream resolution reusing existing OpenAI sidecar auth; no provider registry mutation |
| NEW | src/server/audio-transcriptions.ts | parse bounded multipart, select transcription model, relay to subscription or keyed upstream, map response/errors and cancel |
| MODIFY | src/server/live.ts | retain public live exports; share only reusable upstream resolution as needed, preserving native call-create behavior |
| MODIFY | src/server/index.ts | register exact POST /v1/audio/transcriptions before unknown-v1 guard; perform admission/origin/drain checks before body consumption; record request outcome |
| MODIFY | src/server/auth-cors.ts | append matching transcription row to AUTH_MATRIX; preserve existing header precedence |
| MODIFY | tests/server/api-key-attribution.test.ts | send valid multipart for transcription matrix rows, retaining per-header denial and attribution assertions |
| NEW | tests/server/audio-transcriptions.test.ts | isolated home and synthetic file fixtures, mock canonical upstream fetch, actual ingress requests |
| MODIFY | scripts/test-layout/layout.json | register the new server-domain test |
| MODIFY | tests/fixtures/test-layout-expected.json | add matching expected test path |
| MODIFY | structure/data-planes/inbound-compat.md | describe the audio data-plane contract and owned source/test paths |
| MODIFY | docs-site/src/content/docs/reference/proxy-formats.md | document multipart audio usage and supported response fields |

## Before / after contracts

Before: unknown POST /v1/audio/transcriptions falls through to JSON 404. After: authentication and origin rejection run first; an admitted request reaches handleAudioTranscriptions(req, config, logCtx, lease).

New handler accepts exactly one nonempty file, required model, optional prompt/language/response_format. gpt-4o-transcribe is the subscription compatibility model. Only explicitly supported JSON/text output is accepted; unsupported streaming/timestamp/temperature extensions fail clearly rather than being silently claimed. File limit 25,000,000 bytes; whole multipart limit 32 MiB; text field limits and duplicate checks bound parsing. No file is written to disk. The entire body is capped while reading before Web-platform multipart parsing; multipart overhead therefore remains bounded.

Subscription destination is canonical https://chatgpt.com/backend-api/transcribe (remove only the known /codex suffix). Rebuild FormData so the boundary matches; send file and supported context fields, omit compatibility model and response_format. Keyed OpenAI destination is /v1/audio/transcriptions and receives the validated model/options. Use registered OpenAI account helpers; never forward the client OpenCodex secret. Existing native explicit credential flow remains available only under its existing admission contract. No generic caller-controlled destination.

The resolver takes the already-resolved DataPlaneAdmission and uses resolveFirstUsableOpenAiSidecar directly, rather than invoking the complete Live handler. Retain account context/provider identity/outcome callback for wp2. For a proxy-owned Authorization value, remove only that admission credential before constructing upstream headers and use admitted stored-account resolution. Direct-mode behavior is explicitly tested; no automatic paid-provider fallback after a selected ChatGPT account error. Missing stored Direct credentials report unavailable rather than silently reclassifying an API key as a native token.

New audio ingress resolves explicitly supplied credentials with resolveDataPlaneAdmissionSecret even on loopback; precedence is dedicated header, Bearer, x-api-key. Invalid explicit credentials cannot fall through to loopback admission. File transcription and dictation streaming require a valid proxy key on either listener. This rule is audio-owned and does not modify global resolveApiAuth behavior.

For Direct with a valid proxy key, call resolveCodexAuthContext with mode=direct, substituteMainCredentialForDirect=true and beginCodexAccountSelection=codexAccountSelectionForTurn(lease); then materializeCodexUpstreamAuth with substituteMainCredential=true. This path claims stored-main ownership before reading it. A missing lease, draining main, missing/expired stored credential fails before I/O. Test successful stored-main substitution with isolated fake home, missing credentials and draining state. Native explicit caller auth keeps the existing sidecar path.

Response is bounded before JSON parsing. JSON requires a string text field. text format returns text/plain. Forward sanitized machine-readable upstream status/errors, not arbitrary exception bodies. Client abort, upstream timeout and redirect rejection follow existing relay conventions; outcome callback and admission/sidecar cleanup must settle once.

New transport types are internal: creation in audio-transcriptions, in-memory consumers only, no persistence or reviver. Public multipart is parsed once at ingress. AUTH_MATRIX is serialized by existing management response and validated by GUI isApiAuthMatrix; its consumer remains ApiKeysEndpointsPanel.

## Acceptance and checks

1. POST synthetic WAV with a configured proxy Bearer key: upstream receives the selected stored account/API credential and correct multipart bytes; client gets text.
2. Missing/wrong key and hostile Origin: 401/403 before upload read or upstream call. Main and optional companion listener policies are tested separately.
3. Missing/duplicate file/model, unsupported model or format, malformed multipart: explicit 400; no upstream call.
4. Declared and streamed body oversize, file oversize, text oversize: 413 at configured boundary; body cancellation observed.
5. JSON and text response modes, upstream malformed JSON and excessive response, redirect, timeout and abort: exact response and cleanup assertions.
6. Existing live and auth matrix tests retain their behavior.

Commands: bun test tests/server/audio-transcriptions.test.ts tests/server/server-live.test.ts tests/server/api-keys-routes.test.ts; bun run typecheck; bun run structure:check; bun run privacy:scan. Before new test exists, its execution is NOT RUN; existing commands are declared in package.json and focused file arguments directly observe this layer. Full repository suite runs before review-ready publication, not as a documentation check.

Security control activation cases and residual assumptions are recorded in ignored scratch, reviewed independently, and never copied into the public planning record.

Implementation review amendment: readBodyCapped gains an optional AbortSignal to cancel its locked reader; the transcription operation registers a controller with its turn lease and has an overall deadline plus upload deadline. src/providers/openai-sidecar.ts releases probe ownership if header materialization or post-resolution validation fails before returning a context. Explicit validated native Direct caller auth uses the existing sidecar path; stored-main substitution applies only to proxy-key-only Direct. These narrow changes are prerequisites for safe reuse and preserve existing callers by default.
