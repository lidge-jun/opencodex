## Summary

- **Fix `empty string` validation error in OpenAI Responses API**: Strip empty `name: ""` properties from `input` items in `src/adapters/openai-responses.ts` to prevent upstream 400 rejection (`Invalid 'input[N].name': empty string`).
- **Add `AgentRouter` provider**: Registered AgentRouter gateway (`https://agentrouter.org/v1`) with seed models in `src/providers/registry.ts` and added parity test assertions.
- **Enhanced 429 Rate-Limit Resiliency**: Updated `src/server/responses/core.ts` handling loop with transient retry backoffs (honoring `Retry-After`) alongside multi-key pool failover rotation.
- **Model Favorites & Custom Ordering**: Added `favorites?: string[]` to `OcxConfig`, prioritized favorite models ahead of `subagentModels` in catalog sync & `/v1/models` discovery, and added `/api/favorites` management API with dashboard UI (`gui/src/pages/Favorites.tsx`). Added unit tests in `tests/selected-models.test.ts`.
- **Model Orchestration API & Dashboard**: Added `/api/orchestration` management endpoints (dynamic configuration of `~/.codex/config.toml` via `os.homedir()`) and an Orchestrator GUI tab (`gui/src/pages/Orchestrator.tsx`).
- **Maintenance & Repository Hygiene**: Expanded `.gitignore` (`.serena/`, `.codex/`, `package-lock.json`, `.vscode/`, `.idea/`, `coverage/`, `.env*.local`) and improved discovery error logs in `provider-fetch.ts`.

## Verification

- `bun run typecheck` — 0 errors (strict TypeScript check passed)
- `bun run test` — full test suite passed (including new `selected-models.test.ts` and updated `provider-registry-parity.test.ts`)
- `git status` — verified ignored local files (`devlog/`, `.codex/`, `.serena/`, `package-lock.json`)

## Checklist

- [x] Scope stays focused and avoids unrelated cleanup.
- [x] Docs or release notes were updated when needed.
- [x] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.
