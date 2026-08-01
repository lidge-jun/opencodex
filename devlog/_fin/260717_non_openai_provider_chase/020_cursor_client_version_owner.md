# WP2 — Cursor shared client-version owner

## Goal and dependency

Make discovery and Run import one client-version owner, but choose the value only after the same candidate succeeds on both authenticated endpoints.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| NEW | `src/adapters/cursor/client-version.ts` | two private constants drift | export one default version and a resolver usable by discovery and Run |
| MODIFY | `src/adapters/cursor/live-models.ts` | discovery owns `cli-2026.02.13-41ac335` | import the shared resolver while preserving the explicit test override |
| MODIFY | `src/adapters/cursor/live-transport.ts` | Run owns `cli-2026.07.08-0c04a8a` | import the same shared resolver/header value |
| MODIFY | `tests/cursor-hardening.test.ts` | discovery header tested in isolation | assert shared default and override behavior |
| MODIFY | `tests/cursor-live-transport.test.ts` | no shared-version assertion | capture Run request headers and assert parity |
| MODIFY | `tests/cursor-live-smoke-gate.test.ts` | smoke does not gate version parity | require authenticated discovery and Run success with the selected value |

## Decision gate

Probe both currently observed values, newest safe installed Cursor CLI value if discoverable, and any server-advertised value. Do not select the jawcode value merely because jawcode centralized it. If no single value succeeds on both endpoints, end `NOOP` for centralization and preserve the split with a written compatibility reason.

## Activation scenarios

- Default discovery and Run requests emit byte-identical `x-cursor-client-version` headers.
- Passing `clientVersion` to `fetchCursorUsableModels` affects only the explicit probe and does not mutate the process-wide default.
- A rejected candidate produces a recorded status/body class without token or private payload leakage.

## Verification

```bash
bun test tests/cursor-hardening.test.ts tests/cursor-live-transport.test.ts tests/cursor-live-smoke-gate.test.ts
bun run typecheck
OPENCODEX_CURSOR_TEST_TOKEN=... OPENCODEX_CURSOR_LIVE=1 bun test tests/cursor-live-smoke-gate.test.ts
```

## Terminal outcomes

- `DONE`: one value passes both live calls and all focused tests import one owner.
- `NOOP`: server contracts genuinely require different versions; document and test the split.
- `NEEDS_HUMAN`: no Cursor credential is available for the value decision.
- `UNSAFE`: a probe would expose credentials or require disabling TLS validation.
