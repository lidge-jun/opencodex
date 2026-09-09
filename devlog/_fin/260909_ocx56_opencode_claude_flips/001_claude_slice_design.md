# claude slice design (issue #56): flip `ocx claude` launcher to Go

Unit: `devlog/_plan/260909_ocx56_opencode_claude_flips/`. Sibling of
`000_opencode_slice_design.md` (opencode, landed `cd97aadc9`).

## Confirmed decisions (grill 2026-09-09, owner sign-off)

1. **Slice boundary — one flip of the entire cmdClaude launch engine.** local
   (standalone/disconnected) and connected routes are config-file driven, not
   argv separable, so v2a/v2b-style argv slicing is not expressible; gateway
   cache pre-write and agents-inject interleave with the launch flow. Single
   slice = single commit: auth-detect/mode, buildClaudeEnv full env assembly,
   both routes, context windows (management API fetch + connected catalog
   decode), gateway model cache write, agent roster sync, spawn/hints,
   exit-code passthrough.
2. **`ocx claude desktop …` and `ocx claude config …` stay TypeScript.** New
   OwnershipFor gate returns TypeScriptOwned for those argv[1] values →
   runDelegated; deferral ledger records two SubcommandSeam rows. Issue #56's
   claude entry covers the launcher engine only (desktop-3p and integrations
   families need their own oracles per ADR-0009).
3. **Env provenance: Go treats its env as trusted.** Go has no Bun dotenv
   layer and no launch-proof channel, so an ambient `ANTHROPIC_*` export is a
   genuine parent export — same UX as the real npm launcher (which captures
   parent env pre-Bun). The TS *untrusted* strip (direct `bun
   src/cli/index.ts`) never fires in Go. Parity rows neutralize ambient
   `ANTHROPIC_*` on both sides so the provenance strip never fires; the
   exported-env (S5) subscription row is Go-unit-only, recorded as a residual.
4. **Oracle shape — shim dump + fetchedAt normalization.** Fake `claude` shim
   on PATH dumps sorted env + `gateway-models.json` + `~/.claude/agents`
   contents to stdout; `fetchedAt` ms normalized before compare (PID
   normalization precedent in the parity file). Fixture proxy serves
   `/healthz`, `/api/claude-code`, and `/v1/models?ids=cli`.

## TS reference surface (src/cli/claude.ts + src/claude/*)

| Piece | File | Notes |
| --- | --- | --- |
| cmdClaude | claude.ts | flow: enabled gate → client-state → route → context windows → buildClaudeEnv → root-skip notice → gateway cache → agents-inject (local only) → spawn |
| buildClaudeEnv | claude.ts | pure env assembly (~202 lines), IO injected |
| auth-detect | claude/auth-detect.ts | S1 .claude.json oauthAccount, S2 .credentials.json exists, S3 macOS keychain (absent off-darwin; exit 44 = absent), S5 exported env post-strip; ownTokens exclusion |
| auth-mode | claude/auth-mode.ts | config.claudeCode.authMode manual proxy/subscription; auto-unknown → subscription (historical); ownTokens never in subscription markerMode |
| context-windows | claude/context-windows.ts | resolveAutoContext (env override + maxContextTokens inert pair), [1m] marking, buildClaudeContextWindows, effectiveModelEnv slots |
| gateway-cache | claude/gateway-cache.ts | writeGatewayModelCache {baseUrl, fetchedAt: Date.now(), models} 0600; /^(claude\|anthropic)/i usable filter; refresh via /v1/models?limit=1000&ids=cli, anthropic-version + x-opencodex-api-key, 3s abort |
| agents-inject | claude/agents-inject.ts | ocx-*.md roster, generated-by marker, settings.json picker model, sync writes/deletes owned only |
| alias | claude/alias.ts | claude-ocx-/claude-ocx2- prefixes, aliasForRoute/aliasForNative/resolveAlias; desktop3pAlias fallback (desktop-3p.ts) |
| client/state | src/client/state.ts | readClientConnectionState kinds; tokenFingerprint sha256 hex (service-secrets) |
| service-secrets | src/lib/service-secrets.ts | readServiceApiTokenState; loadServiceTokenFromFile already ported (opencode) |
| launcher-context | src/cli/launcher-context.ts | trusted-context strip logic; Go has no proof channel → not ported (decision 3) |
| dispatch | src/cli/dispatch.ts | claude desktop/config sub-channels stay TS (decision 2) |

Byte-critical lanes (console.error / messages):

- "Claude inbound is disabled (config.claudeCode.enabled=false — flip the Claude ON toggle in the GUI or edit config)."
- `Client state is ${kind}: ${reason}` (invalid/mismatched)
- "Claude is not selected for this remote hub connection."
- "Connected service token is missing." / "Connected service token ownership changed."
- "❌ Proxy did not become healthy after starting."
- "⚠ Claude 인증을 확인하지 못했습니다 — 구독 방식으로 진행합니다. GUI에서 인증 모드를 직접 지정하면 이 판단을 덮어쓸 수 있습니다."
- "⚠ 모델 컨텍스트 정보를 불러오지 못했습니다 — 1M 자동 표시는 이번 실행에서 생략됩니다." (fetch catch)
- "⚠ Gateway model cache could not be refreshed; the model picker may be stale." / `…: ${message}`
- "⚠ Claude agent definitions could not be synced; check ~/.claude/agents permissions." / `…: ${message}`
- CLAUDE_INSTALL_HINT "❌ `claude` CLI not found. Install it first: npm install -g @anthropic-ai/claude-code"
- "❌ Failed to launch claude: ${err.message}" (ENOENT error lane)
- root-skip notices (real-OS gate; unexercised in non-root parity)
- auto-unknown warning emitted once per launch

## Oracle rows (tests/go-cli-parity.test.ts `describe("ocx claude slice (issue #56)")`)

Fixture `startClaudeFixture(...)`: one Bun.serve per row family serving
attested /healthz, /api/claude-code {contextWindows}, /v1/models?ids=cli
anthropic-flavored rows (claude/anthropic prefixed so the usable filter
passes). HOME + CLAUDE_CONFIG_DIR redirected to scratch; planted .claude.json,
.credentials.json, settings.json, agents dir, codex catalog file
(connected), service-api-token file. Env neutralized of ANTHROPIC_* per
decision 3. Both sides run sequentially against the same fixture; shim rows
skipped win32.

- local + proxy mode (clean home, config apiKeys admission → ownTokens)
- local + subscription (oauthAccount in .claude.json)
- manual proxy / manual subscription (config.claudeCode.authMode)
- auto-unknown Korean warning row (unreadable/missing-but-marker env)
- disabled gate row; invalid/mismatched client-state rows
- connected rows: catalog decode aliases + remote /v1/models + token
  fingerprint present/missing/mismatched
- gateway cache shim dump (fetchedAt normalized)
- agents roster shim dump (settings.json model pin, roster defs)
- context window [1m] marking slot row (fixture window >= 1M for a slot target)
- ENOENT row, exit-code passthrough row
- maxContextTokens + DISABLE_COMPACT pair row; alwaysEnableEffort row

Parity-excluded (Go unit tests with injected deps, per opencode precedent):
ensureProxy detached self-start lane; darwin keychain probe (absent branch
only on non-darwin; darwin branch mirrors TS security-call semantics);
root --dangerously-skip-permissions notice (getuid 0); win32 9009 hint
(win-shim rows skipped, hint logic unit-tested); S5 exported-env row
(decision 3 residual).

## Go file set (go/internal/ocxcli/)

- claude_command.go — runClaude(args, deps): gates, client-state, route,
  context windows, spawn wiring, exit passthrough
- claude_engine.go — buildClaudeEnv port + auth detection + markerMode
- claude_context.go — context-windows port (resolveAutoContext, [1m],
  effectiveModelEnv slots, catalog decode + aliases)
- claude_cache.go — gateway cache write + /v1/models ids=cli refresh
- claude_agents.go — roster build + sync (ocx-*.md owned-file contract)
- claude_alias.go — claudeCodeAlias/claudeCodeNativeAlias + resolveAlias +
  desktop3p fallback
- claude_*_test.go + golden_test.go (engine goldens frozen from TS)
- cli.go: row GoOwned + dispatch case + OwnershipFor desktop/config seam
- deferral.go: delete WholeCommand claude, add 2 SubcommandSeam
- deferral_test.go bijection rows update

## Residuals (recorded, post-#56 candidates)

- S5 exported-env subscription row: parity-unexpressible (decision 3); Go
  unit-tested only.
- fetchedAt ms: parity normalizes; Go cache engine tests use injected clock.
- CLI parity harness restores: `ocx claude desktop|config` rows still exercise
  the TS seam (delegate) — byte-identical by construction.
