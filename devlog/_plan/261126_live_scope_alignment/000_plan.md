# Align live scope checks between the native and external paths

## Why

The native voice path (src/server/live.ts) judges a request that names no model as an unnamed destination: a key with a model list is refused, and a provider-only scope or an unscoped key is unchanged. The external path (src/server/audio-live.ts) judged the same requests against the default live model instead. The two paths disagreed for three request shapes: a call-create session without `model`, `/v1/realtime/calls` without a session, and a Realtime standalone socket without a `model=` query.

## Change

| File | Change |
| --- | --- |
| src/server/audio-upstream.ts | `AudioUpstreamOptions.model` may be undefined; scope is judged on it unchanged (`admissionScopeDenial` already handles unnamed destinations); account selection keeps the default model id; the request log keeps its route label when nothing is named |
| src/server/audio-live.ts | call-create judges only a named model; a socket judges its binding's model or its own query model, never an assumed default |
| tests/server/api-key-scope-audio.test.ts | refusal for each unnamed shape with a model-scoped key; an unscoped key still reaches an unnamed Realtime socket |
| structure/data-planes/inbound-compat.md, docs-site reference/proxy-formats.md (+ es) | one rule for both paths |

Named requests are unchanged: an explicit model, a Frameless alias, the Frameless standalone default and a session the proxy writes itself still name their model.

## Checks

Red first: the four new refusal cases fail on the previous source and pass here. Focused audio/live scope, binding and dictation suites, typecheck, structure:check, privacy:scan and the docs/test-layout/file-size guards pass. NOT RUN: live voice sessions.

