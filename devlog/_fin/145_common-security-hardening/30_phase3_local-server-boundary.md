# 30 — Phase 3: Local HTTP/WS boundary

Purpose: verify and harden local server exposure for `/api/*`, `/v1/models`,
`/v1/responses`, and WebSocket upgrades.

Planned surfaces:

- `src/server.ts`
- `src/ws-bridge.ts` only if server tests reveal a WebSocket boundary gap.
- `tests/server-auth.test.ts`
- `tests/ws-endpoint.test.ts` if needed.

Checks:

- Non-loopback binding requires configured API auth for API/model/response
  surfaces.
- Non-local `Origin` is rejected for management and WebSocket paths.
- CORS does not use wildcard credentials behavior.
- WebSocket upgrade inherits the same local-origin and auth boundary.

Verification:

- Focused server-auth tests.
- Typecheck.

## Diff-level plan

MODIFY `tests/server-auth.test.ts`

- Add an `OPTIONS` preflight regression test:
  - loopback/default config rejects non-loopback `Origin` with 403.
  - loopback/default config accepts matching loopback `Origin` with 204.
- Add a WebSocket upgrade regression test for non-loopback bindings:
  - valid `X-OpenCodex-API-Key` is not enough when `Origin` is hostile.
  - response is 403 with `origin_rejected` / cross-origin rejection shape.
- Reuse existing `startServer`, `saveConfig`, and `config()` test helpers.

MODIFY `src/server.ts` only if the new tests expose an actual boundary gap.

MODIFY `devlog/_plan/145_common-security-hardening/30_phase3_local-server-boundary.md`

- Record whether this phase was test-only or required a server patch.
- Record verification commands and commit.

Out of scope:

- Do not change Kiro adapter parity files.
- Do not broaden CORS to support arbitrary browser apps.
- Do not introduce a new auth scheme; use the existing local API auth behavior.

## Build record

Files changed:

- MODIFY `tests/server-auth.test.ts`: added `OPTIONS` hostile-origin regression
  coverage and WebSocket hostile-origin coverage with a valid local API token.
- MODIFY `src/errors.ts`: preserve explicit `origin_rejected` error code before
  generic 401/403 authentication mapping.
- MODIFY `tests/error-fidelity.test.ts`: locked `origin_rejected` classification.
- MODIFY `devlog/_plan/145_common-security-hardening/30_phase3_local-server-boundary.md`:
  this build/verification record.

Implementation note:

- The planned test-only slice exposed one real bug: WebSocket hostile-Origin
  responses had the right status/message but were classified as `invalid_api_key`.
  The fix keeps the boundary behavior and only corrects the machine-readable
  error code.

Verification:

- `bun test tests/server-auth.test.ts tests/error-fidelity.test.ts` -> 38 pass,
  0 fail.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
