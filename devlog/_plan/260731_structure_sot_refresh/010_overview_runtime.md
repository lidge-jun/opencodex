# 010 — WP1: `00_overview.md` + `01_runtime.md`

선행: WP0 (`001_drift_inventory.md`, `002_coverage_gaps.md`, `003_audit_synthesis.md`).
독립 트랙이다 — A 감사 블로커 14에 따라 WP2/WP3/WP5와의 선행 관계 주장을 철회했다.
실제로 이 phase의 산출물을 소비하는 것은 WP6(Reading order 동기화)뿐이다.

## 편집 대상

- MODIFY `structure/00_overview.md`
- MODIFY `structure/01_runtime.md`

## D1. `00_overview.md` Product boundary (I1 + S11)

두 가지를 동시에 고친다. 현재 문장은 (a) Codex 전용 Responses 프록시로만 읽히고,
(b) 기본 동작이 프로바이더 표를 쓴다고 말한다. (b)는 S3와 같은 원인의 STALE이다:
`src/codex/inject.ts:559-565`의 기본 loopback 경로는 루트 키만 쓰고 표를 쓰지 않는다.

BEFORE
```
opencodex is a local Responses-compatible proxy for Codex. It does not patch Codex binaries. It
changes local Codex state by writing a provider table and model catalog, then serves:
```
AFTER
```
opencodex is a local proxy for Codex. It does not patch Codex binaries. It changes local Codex
state by writing root routing keys and a model catalog — a provider table only in the
API-auth-header form described in [`02_config-and-codex-home.md`](02_config-and-codex-home.md) —
then serves the Responses data plane:
```

같은 절 끝(코드 블록 다음 문단 앞)에 한 문단 추가. Live를 어댑터 파이프라인에 넣지 않는다:
`src/server/live.ts:465`는 `resolveLiveRelay`로 OpenAI 릴레이를 잡아 직접 fetch한다.
```
Responses is the primary surface. The same listener also answers Anthropic-shaped `/v1/messages`
and OpenAI-shaped `/v1/chat/completions`. On the routed path those are inbound translations onto the
same routing and adapter bridge rather than separate products; `/v1/messages` additionally has a
native Anthropic passthrough branch that forwards without translation. The Live/Realtime surface is
different in kind — it resolves an OpenAI/ChatGPT relay and forwards to it directly, without the
adapter bridge.
```

근거: `src/server/claude-messages.ts:569` (`wantsNativePassthrough` → `anthropicNativePassthrough`),
`src/server/live.ts:465` (`resolveLiveRelay`). 서술 계약 1항: "inbound translations"를 무조건으로
쓰면 passthrough 분기가 반례가 된다.

## D2. `00_overview.md` Local state 표 (I2, §4 MISSING)

현재 표는 opencodex 파일 5개 + `$CODEX_HOME` 4개. 코드는 20개 이상을 쓴다.
표를 파일 단위 나열에서 소유 계층 나열로 바꾼다. 이유: 파일별 행을 20개로 늘리면 표가
변경 이력처럼 낡는다. Writing rule은 불변 조건을 요구하므로 "무엇이 그 디렉터리를 소유하는가"로 쓴다.

표 앞에 한 문단 추가. 소유의 SOT를 지목하되, 셋 크기 주장과 복구 보장을 넣지 않는다
(A 감사 R1 블로커 2, R2 블로커 1·2):
```
`~/.opencodex/` is the default state root and `OPENCODEX_HOME` overrides it; the GUI and the
installed service resolve it the same way (`src/config.ts`). Ownership inside that root is tracked
by the uninstall manifest in `src/lib/config-ownership.ts`, which starts from a declared path list
and grows as opencodex claims further paths at runtime — so the manifest, not this table, is what
bounds uninstall. This table groups the state by purpose; it is not an exhaustive file list, and
derived files such as `auth.json.pre-multiauth` are covered by the group they belong to.

`$CODEX_HOME` is a separate root with a separate owner, and opencodex writes there too: removing the
opencodex state root does not undo those writes. Putting native Codex back is the job of
`ocx restore`/`eject` and the injection journal, not of deleting a directory.
```

근거: `src/lib/config-ownership.ts:243` (`[...ownership.manifest.paths, rel]` — 매니페스트가 자란다),
`src/oauth/store.ts:175` (선언 목록에 없는 파생 백업), `src/codex/inject.ts:595`
(`CODEX_CONFIG_PATH`/`CODEX_PROFILE_PATH` 쓰기), `src/codex/journal.ts:8`.

표를 다음으로 교체. `$CODEX_HOME` 행은 실제로 그 루트에 있는 것만 담는다
(`opencodex-owner.json`/`opencodex-uninstall.json`은 OpenCodex 루트에 점 접두사로 있다):
```
| Path | Owner | Notes |
| --- | --- | --- |
| `~/.opencodex/config.json` | opencodex | Main config written by `ocx init` and the dashboard. Atomic temp-then-rename. |
| `~/.opencodex/auth.json` | opencodex | OAuth tokens; not committed. Multiauth shape: `provider -> { activeAccountId, accounts[] }` (legacy single-credential values normalize on load; a one-time `auth.json.pre-multiauth` backup guards downgrades). ChatGPT scratch OAuth stays separate from the Codex account store; identity-less providers (kimi/kiro/cursor) replace their active slot. |
| `~/.opencodex/codex-accounts.json` | opencodex | Hardened main-plus-added credential store used by `openai` in Pool mode. |
| `~/.opencodex/catalog-backup.json` | opencodex | One-time pristine Codex catalog backup for restore; per-catalog variants are suffixed. |
| `~/.opencodex/usage.jsonl` | opencodex | Append-only request usage log (0o600); request metadata + token counts only, never prompts or auth. |
| `~/.opencodex/ocx.pid`, `runtime-port.json`, `system-env-port` | opencodex runtime | Live process identity and the port a client should reach; rewritten on start. |
| `~/.opencodex/codex-runtime.json`, `codex-runtime-clamp.json` | opencodex Codex runtime | Selected Codex executable/version state and effort-clamp diagnostics. Not process identity: these persist a resolved choice and a diagnostic, so losing them changes behavior until re-resolved. |
| `~/.opencodex/service-state.json`, `service.log`, `service-api-token`, `opencodex-service-launcher.vbs`, `opencodex-service-task.xml`, `opencodex-service.cmd`, `winsw`, `tray-state.json`, `tray-heartbeat.json`, `opencodex-tray.ps1`, `opencodex-tray-*.ico`, `update-job.json` | opencodex operators | Installed-service, Windows tray, and self-update artifacts and bookkeeping. The update record carries its worker PID so a dead worker recovers instead of blocking later runs. |
| `~/.opencodex/responses-state.json`, `usage-debug.jsonl`, `crash.log`, `artifacts/` | opencodex diagnostics and artifacts | Bounded caches, diagnostics, and generated image/video artifacts served locally. |
| `~/.opencodex/codex-shim.json`, `*.lock`, `kimi-device-id`, `mimo-client-id`, `.star-prompted` | opencodex bookkeeping | Shim restore obligations, cross-process locks, per-install client identifiers, one-shot UI flags. |
| `~/.opencodex/.opencodex-owner.json`, `.opencodex-uninstall.json` | opencodex | Ownership marker and the manifest that bounds what uninstall may remove. Both live in the OpenCodex state root, not in `$CODEX_HOME`. |
| `$CODEX_HOME/config.toml` | Codex, edited by opencodex | Active provider and provider table. |
| `$CODEX_HOME/opencodex.config.toml` | opencodex | Optional profile for explicit Codex opt-in. |
| `$CODEX_HOME/opencodex-catalog.json` | opencodex | Shared native+routed model catalog. |
| `$CODEX_HOME/opencodex-journal.json` | opencodex | Injection journal used by restore to strip only marker-owned values while preserving later user edits. |
| `$CODEX_HOME/models_cache.json` | Codex, invalidated by opencodex | Cache invalidated after model/catalog changes. |
| `dist/`, `gui/dist/`, `node_modules/` | generated | Build output/dependencies. |
```

## D3. `00_overview.md` 불변 조건 보강

Non-negotiable invariants 목록에 한 줄 추가(기존 항목 유지):
```
- The management plane (`/api/*`) and the data plane (`/v1/*`) never share an admission credential.
```

근거: `src/server/management-auth.ts:115-119` — 데이터 플레인 토큰과 관리 토큰이 겹치면 실패한다.

"absent state reports unknown, not zero" 형태의 불변 조건은 넣지 않는다. A 감사 블로커 10이
반례를 찾았다: `/api/usage`는 `usage.jsonl` 부재 시 0 요약을 반환한다
(`tests/api-usage.test.ts:218-227`). 실제 규칙은 표면별로 다르므로 전역 불변 조건으로 쓸 수 없고,
usage 표면의 정확한 서술은 WP4에서 다룬다(S10).

## D4. `01_runtime.md` CLI 행 (I3)

`:9` 행의 명령 열거가 초기 부분집합이다. `src/cli/help.ts`에는 provider/account/models/combo/
agent/observe/access/integrations/doctor/debug/tray/v2가 더 있다.

BEFORE (표 셀 일부)
```
`ocx` / `opencodex` CLI: init, start, stop, restore/eject, sync, status, login/logout, gui, service, update.
```
AFTER
```
`ocx` / `opencodex` CLI. Lifecycle: init, start, stop, restart, status, sync, restore/eject, gui, service, update. Configuration: provider, account, models, combo/route, access, integrations, v2. Diagnostics: doctor, debug, observe, health. Windows adds tray. The full command surface is `src/cli/help.ts`; this table names the groups, not every verb.
```

마지막 문장을 넣는 이유: 명령을 전부 열거하면 다음 명령 추가 시 즉시 낡는다.
그룹과 SOT 파일을 지목하는 편이 오래 산다.

## D5. `01_runtime.md` 서버 엔트리 행 (I4)

BEFORE
```
Bun server entrypoint: `startServer`, `/v1/responses` HTTP + WebSocket routing, exact `POST /v1/images/generations` and `POST /v1/images/edits` routing, `/v1/models`, `/v1/*` JSON 404 guard, GUI fallback, and facade re-exports for split server modules.
```
AFTER
```
Bun server entrypoint: `startServer`, `/v1/responses` HTTP + WebSocket routing (compact handled before generic Responses), exact `POST /v1/images/generations` and `POST /v1/images/edits` routing, `/v1/models`, the Anthropic-shaped `/v1/messages` and OpenAI-shaped `/v1/chat/completions` compatibility surfaces, the Live/Realtime surface, the hosted-search relay, artifact serving, `/healthz`, the `/api/*` auth gate, the `/v1/*` JSON 404 guard, GUI fallback, and facade re-exports for split server modules.
```

## D6. `01_runtime.md` 루트 디렉터리 문단 (§5 MISSING, A)

BEFORE
```
The `src/` root stays thin: process entry, shared config/types, router, bridge, service manager, and
reasoning effort definitions live there. Feature code is grouped under `src/adapters/`, `src/codex/`,
`src/cli/`, `src/oauth/`, `src/providers/`, `src/responses/`, `src/server/`, `src/update/`,
`src/usage/`, `src/vision/`, `src/web-search/`, and `src/lib/`.
```
AFTER
```
The `src/` root stays thin: process entry (`cli.ts`, `index.ts`), shared config/types, router,
bridge, service manager, reasoning-effort definitions, and the stall-timeout budget live there.
Feature code is grouped by responsibility:

| Group | Directories |
| --- | --- |
| Data plane | `src/adapters/`, `src/responses/`, `src/chat/`, `src/claude/`, `src/grok/`, `src/images/`, `src/vision/`, `src/web-search/` |
| Codex integration | `src/codex/`, `src/combos/`, `src/providers/`, `src/oauth/` |
| Surfaces | `src/server/`, `src/cli/`, `src/tray/`, `src/github/` |
| Support | `src/lib/`, `src/storage/`, `src/usage/`, `src/update/`, `src/generated/` |

`generated/` is build output committed for the runtime; it is not edited by hand.
```

## D7. `01_runtime.md` 어댑터 표 (§5 MISSING, B 일부)

표에 행 추가(기존 5행 유지):
```
| `src/adapters/cursor.ts`, `src/adapters/cursor/` | Cursor protobuf transport: discovery, request builder, event decoding, MCP, thread continuity, native-exec policy. |
| `src/adapters/kiro.ts` and its `src/adapters/kiro-*.ts` helpers | Kiro event/tool/thinking/truncation/retry handling. |
| `src/adapters/mimo-free.ts` | Mimo Free transport (client identity + JWT). |
| `src/adapters/image.ts`, `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts` | Image conversion for adapter ingress and Anthropic-specific normalization/limits. |
| `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/upstream-http-error.ts` | Shared adapter execution support: turn queueing, tool-catalog nudging, client identity, upstream error normalization. |
```

어댑터 상세 동작은 `04`가 소유한다. 여기서는 파일이 무엇을 담당하는지만 적는다.

## D8. `01_runtime.md` stall 문장 (I5)

`:53` 부근의 "five-minute / 150-tick" 서술에 기본값임을 명시:
```
The bridge stall deadline defaults to 300 seconds sampled on a 2-second tick
(`src/stall-timeout.ts`); it is configurable, so treat the number as a default rather than an
invariant. Sidecars keep their own clocks.
```

## D9. `00_overview.md` historical 자료 위치 (I10)

`:4`는 historical investigations가 `docs/`에 있다고 말한다. 이 서술은 **틀린 것이 아니다** —
`docs/README.md:1-8`이 스스로 "investigations and diagnostic notes"를 담는다고 선언한다.
부정확한 것은 범위다: `AGENTS.md:33`은 계획·조사 유닛을 추적되는 `devlog/`에 둔다. 두 위치가
공존하므로 역할을 구분해야 한다. `docs/`가 옛 자료만 담는다는 주장은 하지 않는다(A 감사 R3).

BEFORE
```
This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs-site/`; historical investigations belong in `docs/`.
```
AFTER
```
This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs-site/`. Development work is recorded in `devlog/` units — `_plan/` while open,
`_fin/` once closed — while `docs/` keeps investigations and diagnostic notes worth retaining for
archaeology, debugging, or source research.
```

```bash
# 새로 언급한 경로가 모두 존재하는지
bash devlog/_plan/260731_structure_sot_refresh/004_measure.sh /tmp/ocx_wp1
# dead_paths / brace_paths 가 0, undocumented_dirs 가 9 -> 0 으로 떨어져야 한다
rg -n "wantsNativePassthrough" src/server/claude-messages.ts
rg -n "resolveLiveRelay" src/server/live.ts
rg -n "ownership.manifest.paths" src/lib/config-ownership.ts
rg -n "pre-multiauth" src/oauth/store.ts
rg -n "CODEX_PROFILE_PATH" src/codex/inject.ts
bun x tsc --noEmit
bun test tests/repo-hygiene.test.ts
bun run privacy:scan
git diff --check
```

## 검증

## 수용 기준

- 상태 파일 표가 소유 계층으로 서술되고, 셋 크기 주장 없이 매니페스트를 SOT로 지목한다.
- 상태 루트 삭제가 네이티브 복구와 같다는 주장이 없다.
- 디렉터리 표에 `src/` 실제 하위 디렉터리가 빠짐없이 든다.
- CLI/서버 행이 "그룹 + SOT 파일 지목" 형태로 바뀌어 명령 추가에 덜 취약해진다.
- 게이트 4개 통과, 커밋 1개.

## 서술 계약 자기점검

- 절대어: 유지한 것은 `never share an admission credential`(근거 `src/server/management-auth.ts:115-119`)과
  usage 로그의 `never prompts or auth`(근거 `src/usage/log.ts:98,337` + `privacy:scan`). 나머지는 제거했다.
- 셋 크기 주장: 없음. 상태 표는 매니페스트를 SOT로 지목하고 "총 N개"를 쓰지 않는다.
- 경로: 모든 인용이 저장소 루트 기준 완전 경로(`004_measure.sh`의 `dead_paths`/`brace_paths`로 확인).
- 라벨: CLI 명령 그룹은 `src/cli/help.ts`, 디렉터리는 `ls src/`에서 그대로 옮겼다.
