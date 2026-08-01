# 132.10 — Verification: WebSocket Correctness

## Scope

Phase 132 hardens the Codex-facing Responses WebSocket path and changes WebSocket advertisement
from default-on to explicit opt-in.

## Implementation Evidence

Commits:

- `334f7c2 fix: gate websocket transport by explicit opt-in`
- `e27f44c fix: harden responses websocket protocol`
- `2e4733d fix: preserve websocket turn cancellation hooks`
- `df8c047 fix: abort websocket turns before upstream headers`
- `91b3671 fix: propagate websocket aborts to sidecars`
- `78ca706 fix: abort web-search loop provider fetches`

Modified:

- `/Users/jun/Developer/new/700_projects/opencodex/.gitignore`
- `/Users/jun/Developer/new/700_projects/opencodex/src/config.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/types.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/codex-inject.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/ws-bridge.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-inject.test.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/ws-endpoint.test.ts`

## Closed Findings

- Routed continuation safety: routed bridged WS responses now emit empty response ids, so Codex
  falls back to a full next request instead of sending an unresolved incremental suffix.
- Body type handling: successful WS bodies are classified as SSE, mislabelled SSE, JSON, or
  protocol error.
- Terminal enforcement: the WS pump stops at the first terminal, cancels the reader, and reports EOF
  before terminal as standalone `type:error`.
- Header/error fidelity: non-2xx responses use standalone `type:error` with HTTP status and safe
  headers, including Codex rate-limit header families; inbound WS data stores only forwarded
  allowlist headers.
- Cancellation: socket close still cancels upstream, and same-socket replacement turns cancel the
  previous in-flight reader/fetch before upstream headers arrive, including vision/web-search
  sidecar fetches, and suppress stale frames.
- Framing/backpressure: CRLF, multiline data, split chunks, unterminated final event, dropped send,
  `-1` backpressure, and bounded sniff replay are covered by tests.
- Advertisement: absent `websockets` is now false; only explicit `websockets: true` advertises
  provider/catalog `supports_websockets`.

## Automated Verification

- `bun test tests/codex-inject.test.ts tests/codex-catalog.test.ts`
  - 16 pass, 0 fail, 104 assertions.
- `bun test tests/ws-endpoint.test.ts`
  - 19 pass, 0 fail, 39 assertions.
- `bun test tests/passthrough-abort.test.ts`
  - 4 pass, 0 fail, 8 assertions.
- `bun test tests/sidecar-abort.test.ts`
  - 3 pass, 0 fail, 10 assertions.
- `bun test tests/sidecar-abort.test.ts tests/ws-endpoint.test.ts tests/passthrough-abort.test.ts`
  - 26 pass, 0 fail, 57 assertions.
- `bun test tests`
  - 84 pass, 0 fail, 274 assertions.
- `bun x tsc --noEmit`
  - passed with exit 0.

## Live `ocx` Smoke

Initial state:

- `ocx status` returned `Proxy not running`.
- `~/.opencodex/config.json` had `websockets` absent, with providers `openai`, `opencode-go`,
  `anthropic`.

Default advertisement smoke:

- `ocx start` started the proxy on `http://localhost:10100`.
- `GET /healthz` returned HTTP 200.
- `GET /v1/models?client_version=0.141.0` returned catalog rows with `supports_websockets` absent
  for:
  - `gpt-5.5`
  - `opencode-go/kimi-k2.7-code`
  - `opencode-go/minimax-m3`

Direct WebSocket smoke:

- `ws://localhost:10100/v1/responses` with `generate:false` returned
  `response.created -> response.completed` and empty response id `""`.
- Direct routed WebSocket one-shot with `opencode-go/kimi-k2.6` returned:
  - `result completed`
  - 8 frames
  - first frame `response.created`
  - last frame `response.completed`
  - text `OK`

Shutdown:

- `ocx stop` stopped PID 23557.
- Final `ocx status` must remain `Proxy not running` before release.

## Residual Note

Codex RS exposes no standalone `response.cancel` client frame in the checked source. Phase 132
therefore implements the server-side safe behavior available to opencodex: socket close cancellation
and same-socket replacement-turn cancellation. A human-visible TUI Ctrl-C transcript remains useful
release evidence if automation can drive it reliably, but it is no longer the only proof of stale
frame isolation.

## Independent Review Follow-up

The first read-only Phase 132 release review failed on two remaining release-blocking points:

- Cancellation was installed only after an upstream `Response` existed. Fix: a turn-level
  `AbortController` is now installed immediately on `response.create`, plumbed into
  `handleResponses`, and linked to both passthrough and bridged upstream fetches.
- The safe WebSocket error header allowlist did not retain Codex rate-limit headers. Fix:
  `safeResponseHeaders()` now preserves the `x-codex-<limit>-primary/secondary-*` and
  `x-codex-<limit>-limit-name` families parsed by Codex RS.

Regression coverage:

- `tests/passthrough-abort.test.ts` asserts that a turn-level abort signal aborts the upstream
  controller before response headers arrive.
- `tests/ws-endpoint.test.ts` asserts stale successful response bodies are cancelled before pumping
  and Codex rate-limit headers survive WebSocket error sanitization.

The second read-only Phase 132 release review found a remaining sidecar cancellation gap. Fix:

- `options.abortSignal` now threads through `describeImagesInPlace`, `describeImage`,
  `runWithWebSearch`, and `runWebSearch`.
- `src/abort.ts` composes the per-turn abort signal with each sidecar timeout signal.
- `tests/sidecar-abort.test.ts` asserts both web-search and vision sidecar fetches observe the
  WebSocket turn abort signal.

The third read-only Phase 132 release review found one last web-search loop gap. Fix:

- The routed-provider fetch inside `runWithWebSearch` now receives the WebSocket turn abort signal.
- `tests/sidecar-abort.test.ts` asserts the loop's routed-provider fetch receives and observes the
  same abort signal.
