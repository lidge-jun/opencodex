# 001_drift_inventory — `structure/` claim 검증 결과

측정 2026-07-31, `dev` 작업 트리. 카운트는 `004_measure.sh`가 보고한 스냅샷(HEAD `286d24cbf`)이며,
개별 claim은 문서의 사실 주장을 뽑아 `rg`/`ls`로 코드에서 확인했다. 판정은 STALE(코드가 반박) /
IMPRECISE(범위·조건 불일치) / MISSING(코드에 있으나 문서에 없음) / OK.

## §0 측정 정본과 경로 해석 검사

모든 카운트는 `004_measure.sh` 한 곳에서 나온다(A 감사 블로커 1: 형태가 다른 임시 `rg`는
숫자가 재현되지 않는다). 카운트 정의는 **경로 리터럴 기준**이며 메서드/경로 쌍이 아니다.
접두 매칭 라우트(`/api/codex-auth/`)는 한 개로 센다.

```
$ bash devlog/_plan/260731_structure_sot_refresh/004_measure.sh     # HEAD 286d24cbf
registered_route_literals  90
documented_route_literals  25
doc_only_routes             0 (must be 0)
dead_paths                  0 (must be 0)
brace_paths                 0 (must be 0)
undocumented_dirs           9
initial_owned_paths        36 (NOT the total state-file count)
```

`dead_paths 0`: `structure/`가 지목한 소스 경로는 전부 현존한다. 따라서 이 유닛의 작업은
링크 수복이 아니라 서술 정정과 커버리지 확장이다.
`undocumented_dirs 9`: `src/chat`, `src/claude`, `src/combos`, `src/generated`, `src/github`,
`src/grok`, `src/images`, `src/storage`, `src/tray`.

## §1 STALE — 코드가 문서를 반박하는 서술

| # | 문서 | 문서가 말하는 것 | 코드 | 정정 방향 |
|---|------|-----------------|------|----------|
| S1 | `04_transports-and-sidecars.md:115-129` | `Claude-3p`는 폐기된 하드코딩 경로이고 Desktop은 `Claude/configLibrary`를 읽는다 | `src/claude/desktop-3p-paths.ts:5-27,65,78` — Desktop이 런타임에 `"Claude" + "-3p"`를 조립한다. `Claude-3p/configLibrary`가 Desktop의 정상 기본값이며 #539는 win32/`CLAUDE_USER_DATA_DIR` 분기 누락이었다 | 절을 역전. 기본값은 `Claude-3p/configLibrary`, 재정의는 `CLAUDE_USER_DATA_DIR`/`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` |
| S2 | `04_transports-and-sidecars.md:426-439` | 사이드카는 `openai` ChatGPT forward 권한이 있을 때만 동작하며 백엔드는 OpenAI 단일 | `src/web-search/index.ts:12-14`(`claude-sonnet-5` Anthropic 기본), `src/vision/index.ts:14-16` — vision은 쓸 수 있는 Anthropic OAuth 프로바이더가 있으면 그쪽을 고르고 없으면 `gpt-5.4-mini` | 백엔드 2종을 표에 명시. OpenAI 기본 모델 값 자체는 정확하므로 유지 |
| S3 | `02_config-and-codex-home.md:58-69` | 주입은 항상 `model_provider = "opencodex"` + `[model_providers.opencodex]` 표를 쓴다 | `src/codex/inject.ts:119-134,550-565` — loopback은 marker 소유 루트 `openai_base_url`을 쓰고, 프로바이더 표 형태는 non-loopback/API auth-header 모드에 한정 | 두 형태를 분기해서 서술 |
| S4 | `08_openai-provider-tiers.md:58-60` | 기존 v2 백업이 다르면 마이그레이션이 차단된다 | `src/config.ts:274-282`(v2는 `stale`로 분류), `:307-322` — 다른 v2 스냅샷은 경고 후 교체하고, 차단되는 것은 v1 rollback 스냅샷 | 차단 주체를 v1 rollback 백업으로 정정 |
| S5 | `06_docs-and-release.md:5-6` | 로케일은 영어·한국어·중국어 간체 | `docs-site/astro.config.mjs:61-68` — `ru`, `ja` 포함 5종 | 5종으로 갱신 |

추가 STALE 2건(정책·CI 서술):

| # | 문서 | 문서 | 코드 | 정정 |
|---|------|------|------|------|
| S6 | `06_docs-and-release.md:42` | CI는 `main`/`dev`/`preview`의 PR·push에서 돈다 | `.github/workflows/ci.yml:4-5`(PR: `main, dev`), `:21-22`(push: `main, preview, dev`) | PR 대상과 push 대상을 분리 서술 |
| S7 | `06_docs-and-release.md:45` | `service-lifecycle.yml`은 Linux systemd 스모크 | `.github/workflows/service-lifecycle.yml:37,159,239` — `linux-systemd`, `macos-launchd`, `windows-schtasks` 3종 | 3플랫폼 스모크로 정정 |
| S8 | `07_design-methodology.md:13-15,34` | 정전 출처는 `pabcd_initiative/skills/dev-pabcd/references/catalog-discovery.yaml` | 해당 경로는 이 체크아웃에 없다(`ls: No such file or directory`) | 저장소에서 해석되는 참조로 교체하거나 경로 주장을 제거 |
| S9 | `05_gui-and-management-api.md:97` | 사이드바가 Startup 페이지를 노출한다 | `gui/src/App.tsx:50-62` `NAV`에 `startup` 없음. 라우팅·렌더는 존재(`gui/src/app-routing.ts:20-34`) | "라우팅으로 접근 가능하나 사이드바 항목은 아님"으로 정정 |
| S10 | `05_gui-and-management-api.md:153` | "Missing usage is never treated as zero" | `tests/api-usage.test.ts:218-227` — `usage.jsonl` 부재 시 `/api/usage`는 200과 0 요약(`requests: 0`, `coverageRatio: 0`)을 반환한다 | 0 요약을 반환한다는 사실을 적고, 구분해야 하는 것은 "측정된 0"과 "근거 없는 0"임을 명시. A 감사에서 발견(내 인벤토리가 놓쳤다) |
| S11 | `00_overview.md:23` | 기본 동작이 프로바이더 표를 쓴다 | `src/codex/inject.ts:559-565` — loopback 기본 경로는 루트 키만 쓴다 | S3와 같은 원인. `00`에서도 정정. A 감사에서 발견 |
| S12 | `03_catalog-and-subagents.md:17` | 원본 카탈로그 백업은 `catalog-backup.json` 한 개 | `src/codex/catalog/parsing.ts:40` — 백업 경로는 카탈로그 경로의 sha256 앞 16자를 붙인 `catalog-backup-<id>.json`이고(`:427` `ensureCatalogBackup`), 기본 카탈로그에는 레거시 무접미 파일도 함께 유지된다(`:36`) | 카탈로그별 백업임을 명시. A 감사 R2에서 발견 |

## §2 IMPRECISE — 조건·범위가 실제와 다른 서술

| # | 문서 | 정정 방향 | 근거 |
|---|------|----------|------|
| I1 | `00_overview.md:22` | Codex 전용 Responses 프록시로 읽히지만 Claude Messages / Chat Completions / Live 표면도 서비스한다 | `src/server/index.ts:627,650,671` |
| I2 | `00_overview.md:52` | `~/.opencodex/`는 기본값이고 `OPENCODEX_HOME`이 재정의한다 | `src/config.ts:412-414` |
| I3 | `01_runtime.md:9` | CLI 목록이 초기 부분집합. tray/doctor/debug/provider/account/models/combo/agent/observe/access/integrations/v2 등 누락 | `src/cli/help.ts:14,85,104,156,222` |
| I4 | `01_runtime.md:10` | 서버 라우트 목록에 compact/search/claude-messages/chat-completions/live/artifacts 누락 | `src/server/index.ts:469,549,627,650,671` |
| I5 | `01_runtime.md:53` | 300초 stall은 기본값이며 설정 가능. 불변 조건이 아니다 | `src/stall-timeout.ts:8-19` |
| I6 | `02_config-and-codex-home.md:5-16` | `CODEX_HOME` 미설정은 폴백(WSL 탐색 포함)이지만, 명시된 읽기 불가/비디렉터리 경로는 throw | `src/codex/paths.ts:7-23`, `src/codex/home.ts:135-146` |
| I7 | `03_catalog-and-subagents.md:30-36` | 네이티브 passthrough는 무조건이 아니다. 단, 조건은 두 갈래다: `src/codex/catalog/sync.ts:507-512` — `includeNativeOpenAi = enabledProviders.length === 0 || hasCanonicalOpenai`. 즉 활성 프로바이더가 하나라도 있으면 canonical OpenAI가 필요하고, 활성 프로바이더가 0이면 부트스트랩용으로 남는다(#636) | 두 갈래를 그대로 서술 |
| I8 | `04_transports-and-sidecars.md:62` | 이미지 경로에 Google Antigravity 폴백 존재(`generations` 한정, OpenAI 자격증명 불가 시) | `src/server/images.ts:95-159,405-423` |
| I9 | `06_docs-and-release.md:140-161` | CI 게이트에 GUI 테스트(`cd gui && bun test tests`) 누락 | `.github/workflows/ci.yml:88` |
| I10 | `00_overview.md:4` | historical investigations가 `docs/`에 있다고만 말한다 | `docs/README.md:1-8`은 이 폴더가 조사·진단 노트를 담는다고 스스로 선언하므로 이 서술은 **틀리지 않았다**. 다만 `AGENTS.md:33`은 계획·조사 유닛을 추적되는 `devlog/`에 둔다 | 두 위치의 역할을 구분해서 서술한다. `docs/`가 옛 자료만 담는다는 주장은 하지 않는다. A 감사 R3 정정 |

## §3 MISSING — 관리 API 라우트 커버리지

등록된 고유 `/api` 경로 리터럴 90개 중 `structure/` 전체가 언급하는 것은 25개(§0 측정).
등록되었으나 미기재인 계열:

| 계열 | 대표 라우트 | 등록 위치 |
|------|------------|----------|
| 진단/동기화 | `GET /api/diagnostics/project-config`, `POST /api/sync` | `src/server/management/config-routes.ts:224,230` |
| 사이드카/섀도콜 설정 | `GET,PUT /api/sidecar-settings`, `/api/shadow-call-settings` | `config-routes.ts:276,289,355,360` |
| 로그 | `GET /api/logs`, `/api/claude/inbound-debug`, `/api/debug/injection-logs` | `logs-usage-routes.ts:126,145,151` |
| 스토리지 | `/api/storage`, `/cleanup`, `/cleanup/preview`, `/trash`, `/trash/restore`, `/cleanup-policy*` | `logs-usage-routes.ts:235-468` |
| 프로바이더 | `/api/provider-quotas`, `/api/providers/test`, `/api/provider-context-caps`, `/api/provider-presets` | `provider-routes.ts:74,322,441,445,499` |
| OAuth/키 | `/api/oauth/providers`, `/login*`, `/logout`, `/status`, `/accounts/pool`, `/accounts/clear-cooldown`, `/api/keys` | `oauth-account-routes.ts:75-464` |
| 모델 | `/api/models`, `/api/disabled-models`, `/api/model-visibility`, `/api/selected-models`, `/api/custom-models` | `model-routes.ts:67-339` |
| 에이전트 설정 | `/api/effort-caps`, `/api/subagent-models`, `/api/subagent-model-fallback` | `agent-settings-routes.ts:293-370` |
| Grok/Claude 통합 | `/api/grok*`, `/api/claude-desktop*`, `/api/claude-code` | `agent-settings-routes.ts:422-691` |
| 콤보 | `GET,PUT,DELETE /api/combos` | `combo-routes.ts:69,81,200` |
| 시스템/사이드바 | `POST /api/system/restart`, `/api/github/star`, `/api/update/badge` | `system-routes.ts:90`, `sidebar-routes.ts:17,22,32` |
| Codex 계정 | `/api/codex-auth/accounts*`, `/active`, `/auto-switch`, `/pool-strategy`, `/failover`, `/quota`, `/reset-credits*`, `/login*`, `/login-status` | `src/codex/auth-api.ts:641-1225` |

반대 방향(문서에만 있고 등록 안 된 라우트)은 0건 — `004_measure.sh`의 `doc_only_routes`가 이를 지킨다.
메서드/형태 일치는 이 인벤토리가 주장하지 않는다: `004_measure.sh`는 경로 리터럴만 비교하고
메서드·요청 형태는 증명하지 않는다(서술 계약 5항). 개별 확인한 것은 하나뿐이다 —
`PUT /api/config`가 405를 반환한다는 서술은 코드와 일치한다(`src/server/management/config-routes.ts:73`).

## §4 MISSING — 로컬 상태 파일

`00_overview.md:50-61` 표는 opencodex 파일 5개를 나열한다. 근거는 추측이 아니라
소유 매니페스트다: `src/lib/config-ownership.ts:37-73`의 `INITIAL_OWNED_PATHS`가 36개 항목을
선언한다(`004_measure.sh`의 `initial_owned_paths`). 이 목록은 **초기값**이다 — 매니페스트는
`src/lib/config-ownership.ts:243`에서 `[...ownership.manifest.paths, rel]`로 자라고,
`src/oauth/store.ts:175`의 `auth.json.pre-multiauth`처럼 선언 목록에 없는 파생 파일도 생긴다.
따라서 "상태 파일은 총 N개"라고 쓰지 않는다.

```
.star-prompted  artifacts  auth.json  auth.store.lock  catalog-backup.json  claude-env.sh
codex-accounts.json  codex-runtime-clamp.json  codex-runtime.json  codex-shim.autorestore.lock
codex-shim.json  config.json  crash.log  kimi-device-id  mimo-client-id  ocx.pid
opencodex-service-launcher.vbs  opencodex-service-task.xml  opencodex-service.cmd
opencodex-tray-*.ico  opencodex-tray.ps1  responses-state.json  runtime-port.json
service-api-token  service-state.json  service.log  system-env-port  tray-heartbeat.json
tray-state.json  update-job.json  usage-debug.jsonl  usage.jsonl  version.json  winsw
```

소유 루트 구분(A 감사 R1 블로커 2, R2 블로커 1): `.opencodex-owner.json`과
`.opencodex-uninstall.json`은 **OpenCodex 설정 루트** 소유이며 점 접두사를 갖는다
(`src/lib/config-ownership.ts:16-17`). `$CODEX_HOME` 쪽 경로는 `src/codex/paths.ts:26-30`이
정의한다: `config.toml`, `opencodex.config.toml`, `opencodex-catalog.json`, `models_cache.json`,
그리고 `src/codex/journal.ts:8`의 `opencodex-journal.json`. 문서 표는 두 루트를 섞어서는 안 되고,
opencodex가 `$CODEX_HOME`에도 쓰기 때문에 상태 루트 삭제가 네이티브 복구와 같지 않다.

## §5 MISSING — 서브시스템·GUI 표면

`002_coverage_gaps.md`에 정리. 요약: `src/` 루트 서브시스템 9개(`src/chat/`, `src/claude/`,
`src/combos/`, `src/generated/`, `src/github/`, `src/grok/`, `src/images/`, `src/storage/`,
`src/tray/` — `004_measure.sh`의 `undocumented_dirs`와 동일)가 `01_runtime.md` 디렉터리 문단에 없고,
어댑터·트랜스포트 14계열이 `04`에 절이 없고, GUI 워크스페이스 7개가 `05`에 없다.

## §6 집계

| 문서 | 검사 | STALE | IMPRECISE | MISSING |
|------|------|-------|-----------|---------|
| `00_overview.md` | 13 | 1 | 3 | 2 |
| `01_runtime.md` | 12 | 0 | 3 | 3 |
| `02_config-and-codex-home.md` | 12 | 1 | 1 | 2 |
| `03_catalog-and-subagents.md` | 10 | 1 | 1 | 11 |
| `04_transports-and-sidecars.md` | 20 | 2 | 1 | 14 |
| `05_gui-and-management-api.md` | 108 | 2 | 0 | 72 |
| `06_docs-and-release.md` | 9 | 3 | 1 | 2 |
| `07_design-methodology.md` | 4 | 1 | 0 | 1 |
| `08_openai-provider-tiers.md` | 6 | 1 | 0 | 2 |

STALE 총계는 12다: S1–S9(1라운드 실측) + S10·S11(A 감사 R1) + S12(A 감사 R2).
IMPRECISE 총계는 10이다(I1–I9 + I10). R2가 S13으로 올렸던 `00:4`는 R3에서 IMPRECISE로 강등했다:
`docs/README.md`가 스스로 조사·진단 노트를 담는다고 선언하므로 기존 서술은 반박되지 않는다.
죽은 경로 0. 반박된 서술 12. 조건 불일치 10. 커버리지 공백이 압도적으로 큰 몫이다.
담당 phase: S12 → WP2(`020` D7), I10 → WP1(`010` D9).
