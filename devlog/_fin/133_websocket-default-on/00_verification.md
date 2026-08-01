# 133.00 — WebSocket Default-On Release

> **Superseded by e804ba5 (v1.9.2)**: WebSocket default was reverted to **off** (`config.websockets === true` required). Fresh config writes `"websockets": false`. The decision below was the original v1.9.1 intent but was reversed before v2.0.0.

## Decision (original, now reversed)

After Phase 132 hardened the Responses WebSocket bridge and the user verified local Codex behavior,
WebSocket advertisement is restored to default-on for `1.9.1`.

## Behavior

- Missing `websockets` now means enabled.
- Fresh `~/.opencodex/config.json` writes `"websockets": true`.
- Explicit `"websockets": false` still suppresses provider/catalog `supports_websockets`.

## Changed

- `/Users/jun/Developer/new/700_projects/opencodex/src/config.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/types.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-inject.test.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts`

## Verification Plan

- `bun test tests/codex-inject.test.ts tests/codex-catalog.test.ts`
- `bun test tests`
- `bun x tsc --noEmit`
- `ocx start` smoke:
  - `/healthz` returns HTTP 200.
  - `/v1/models?client_version=0.141.0` advertises `supports_websockets` by default.
  - `ocx stop` leaves the proxy stopped before release.

## Verification Results

- `bun test tests/codex-inject.test.ts tests/codex-catalog.test.ts`
  - 17 pass, 0 fail, 107 assertions.
- `bun test tests`
  - 85 pass, 0 fail, 277 assertions.
- `bun x tsc --noEmit`
  - passed with exit 0.
- Local source smoke via `bun src/cli.ts start`
  - `/healthz` returned HTTP 200.
  - `/v1/models?client_version=0.141.0` returned `supports_websockets: true` for:
    - `gpt-5.5`
    - `opencode-go/kimi-k2.7-code`
    - `opencode-go/minimax-m3`
  - Context values stayed correct for the checked routed models:
    - `opencode-go/kimi-k2.7-code`: `262144`, auto compact `235929`
    - `opencode-go/minimax-m3`: `512000`, auto compact `460800`
  - `ocx stop` stopped the proxy and final `ocx status` returned `Proxy not running`.
