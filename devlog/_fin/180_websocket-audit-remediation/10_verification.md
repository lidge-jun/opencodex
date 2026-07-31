# 180 — Verification

## Local

- `bun x tsc --noEmit` — pass
- `bun test tests` — 94 pass, 0 fail, 324 expect()
- `bun run src/cli.ts help` — verified (prior session)

## Patches applied

### #3 Heartbeat stall (bridge.ts)
Added `stallTicks` counter (max 150 = 5 min at 2s). On timeout: `closed = true`, clear interval, call `onCancel()`. Upstream iterator then exits via normal error path.

### #4 EOF misclassification (bridge.ts)
Synthesized terminal status changed `"completed"` → `"incomplete"`. Codex can distinguish explicit adapter completion from implicit iterator exit.

### #5 JSON status overwrite (ws-bridge.ts)
`sendResponsesJsonAsEvents()` now preserves `failed`/`incomplete` status from the upstream JSON response. Event type switches to `response.failed` for failed responses.

### #10 Windows service restart (service.ts)
Batch script now has `:loop` + `goto loop` on non-zero exit. Clean exit (exit code 0 from `ocx stop`) ends the loop. Parity with macOS `KeepAlive` and Linux `Restart=on-failure`.

### #11 atomicWriteFile race (config.ts)
Temp filename now includes `process.pid` and a per-process sequence counter: `${path}.ocx.${pid}.${seq}.tmp`. Eliminates concurrent-writer collision.

## Invalid findings documented

- **#1**: OpenCode Go gateway provides unified OpenAI Chat Completions interface — adapter split unnecessary
- **#6**: `safeResponseHeaders()` explicitly forwards `x-codex-turn-state`, `openai-model`, `x-reasoning-included`
- **#2**: Sidecar continuation concern is real but cited `forceEmptyResponseId` parameter doesn't exist in code
- **#7**: HTTP routed error path loses upstream headers (partial valid); WS path preserves them
