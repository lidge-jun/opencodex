# 200.200 — Dev Branch Final Merge

## Merged into dev

### From main (v2.1.2 security patches)
- `5c3fa9a` fix: strip trailing /v1 from baseUrl (Blocker 1)
- `24d6615` fix: Azure OpenAI baseUrl (Blocker 2)
- `e5c795e` fix: WebSocket Origin validation (Blocker 3)
- `bb3f9ad` fix: openUrl shell injection → spawn
- `579ac0f` fix: config/auth 0o600 permissions
- `fd8604e` fix: parallel_tool_calls=false default
- `c525f71` fix: force parallel_tool_calls=false in catalog
- `727c16c` fix: atomicWriteFile for config.json
- `fdf4ba4` fix: rundll32 on Windows + URL scheme guard
- `064911d` fix: Azure v1 api-version skip
- `8107f2d` fix: CSRF block on management API
- `945f4b2` fix: WS JSON incomplete event type
- `ef389f6` fix: anthropic baseUrl /v1/v1/messages
- `a66a6c0` feat: configurable stall timeout (90s default)
- `63cac58` fix: Windows shim repair after update
- `a490882` test: v2.1.2 patch tests (URL, WS, bridge)
- `9cd85c1` docs: UAYOR disclaimer

### From PR #7 (codex/history-provider-sync)
- `codex-history-provider.ts`: Sync Codex resume history model_provider on inject/restore
- Fixes Issue #6: 오픈코덱스 경유시 채팅세션 로드 불가
- `sync-cache` CLI command + shim integration

## Verification
- `bun x tsc --noEmit`: pass
- `bun test tests`: 118 pass, 0 fail, 389 expect()
- No merge conflicts
