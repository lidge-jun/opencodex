# 007 — Magpie 클라이언트와 배포

L7 · 2026-11-23 KST · Magpie `3377e77eb6` (`v0.1.4721`) ↔ OpenCodex `origin/dev@9e0e298ef9`.
`mgp:`와 `ocx:`는 `.tmp/chase/` 아래의 핀 고정 소스를 가리킨다. 상태는 행에 적힌 기능 단위의 판정이다.

## 1. 요약

1. Codex는 두 프로젝트 모두 선택한 홈의 TOML과 모델 카탈로그를 관리하고 복원을 지원한다. Magpie의 차이는 기존 ChatGPT 로그인 옆에 모델을 합치는 모드와 앱 쿼터 차단 시 provider 전환을 같은 클라이언트 흐름에 둔 점이다.
2. Claude Code는 Magpie가 일반 실행에도 효력이 있는 `settings.json`을 편집한다. OpenCodex는 `ocx claude`의 프로세스 환경과 별도 first-party 설정 경로가 있어, 기본 실행까지 연결하고 싶은 사용자에게 소유권과 복원 조건을 명확히 보여줄 가치가 있다.
3. 이주 비용은 공급자 설정과 계정 자격 증명에서 갈린다. OpenCodex는 CC Switch keyless preview/apply/restore를 이미 제공한다. Magpie의 차이는 앱 간 발견 화면과 Codex·Claude 계정 묶음 import다.
4. 소규모 팀은 LAN 키, 원격 모델 목록, 접속 안내를 함께 쓰는 Magpie 흐름과 OpenCodex의 Hub 초대 및 Home/Child enrollment를 비교해야 한다. 기존 키·승인 계약을 살린 접속 동선 개선이 먼저다.
5. relay 링크의 검토 화면은 반복 입력을 줄인다. endpoint와 키 취급, 충돌 표시, 사용자 확인이 설계 조건이다.
6. Raycast YAML 연결은 양쪽에 있고 OpenCodex는 preview 및 journal restore가 있다. 새 agent 추가는 Zed처럼 구체적인 수요와 config 계약이 있는 경우가 유력하다.
7. MCP·skills Library, 암호화된 설정 동기화, 대화형 TUI는 확인된 표면 차이다. 이 작업의 개인 Codex/Claude 사용자와 소규모 프록시 팀 기준으로는 앞선 이주·연결 작업이 우선이다.
8. GUI·tray·Docker·업데이트 확인·현지화는 이미 겹친다. 10월 비교 기록에서 본 distroless·약 30 MB·단일 importer 주장은 이 핀과 공개 릴리스 자산으로 대체한다.

## 2. 표면 맵

### 실행 및 등록

| 표면 | Magpie 등록과 분기 | OpenCodex 대응 |
|---|---|---|
| 실행 진입 | `main.go:25` → `internal/cli/main.go:221,362,604`. `app/gui/tray/panel/-Embedding`, `tui`, `web`, `serve`. `internal/cli/gui_on.go`와 `gui_off.go`, `Makefile:17,57,60,120,148`에서 native GUI와 `nogui` 빌드를 구분한다. | `ocx:src/cli/dispatch.ts:328,418,423,596,603,657,762,879,921`에서 status/sync/connect/service/tray/update/provider/integration/claude 분기. Desktop은 Tauri가 창과 runtime lifecycle을 올린다. `ocx:desktop/src-tauri/src/lib.rs:309,422,430` |
| Agent 조작 | `ls/list`는 감지된 항목, `agents`는 전체 등록 목록, `<agent> [field] [value/default]`는 `Find/Apply/Disconnect`, agent launch는 `Starter`. TUI는 Bubble Tea에서 감지된 항목과 picker 사용. `mgp:internal/cli/main.go:637,719,757,791,885`, `internal/agent/agents.go:301`, `internal/tui/tui.go:162,192,489` | `ocx integration` CLI와 Connect 화면 API, native `PUT /api/native-integrations/{claude,grok,codex,claude-desktop}`, managed `GET/PUT /api/client-integrations/{id}` 및 export. `ocx:src/server/management-api.ts:396`, `src/server/management/native-integration-routes.ts:1005,1016,1098`, `src/server/management/integration-routes.ts:748,1162` |
| Agent 관리 GUI | `GET /api/state`, `POST /api/set` → `Find/Pick`, `GET /api/drift`, `POST /api/agents/{rescan,stage/{id},cli/{id},telemetry/{id},restart/{id},arrange,here}`, `GET /api/agents/{cli,install,preview/{id}}` 및 `POST /api/agents/{connect,disconnect,disconnect-offline,keep,reapply}/{id}`. Desktop 격리, 프로필 save/use/rename/remove 및 sync도 연결한다. `mgp:internal/gui/api.go:1224,1384,1404,1438,1452,1518,1574,1601,1635,1671,1714,2741` | Client state/preview/restore/restore preview/journal, Aside profile, Pi sync, 별도 `/api/gateway-clients`. `ocx:src/server/management/integration-routes.ts:298,574,748,802,830,915,966,1016` |
| 설정·계정 이주 | `GET /api/importapps/discovery`, `GET/POST /api/importapps`, `POST /api/login/{action}`, `/api/settings/account-discovery`. `accounts/account`와 provider CLI. `mgp:internal/gui/importapps.go:27`, `internal/gui/providers.go:1754,3459,3729`, `internal/gui/api.go:1914`, `internal/cli/main.go:654,656,678` | `ocx provider import-cc-switch`와 `ocx account import`. `ocx:src/cli/provider.ts:659`, `src/cli/account.ts:510`, `src/server/management/oauth-account-routes.ts:1130` |
| 링크 | `magpie://import` OS handler + `GET /api/import/{id}`, `POST /api/import/icon`, CLI `import`. `ccswitch://`는 별도 호환 등록이다. `mgp:build/darwin/Info.plist:21`, `internal/gui/scheme_windows.go:16`, `site/public/install.sh:508`, `internal/gui/app.go:789,833`, `internal/gui/importlink.go:57`, `internal/ccswitchlink/link.go:1` | GUI 내부 hash navigation, Link join 및 Hub invite. `ocx:gui/src/app-routing.ts:100,120`, `src/server/management/link-routes.ts:725`, `src/cli/hub.ts:239` |
| 원격 | `POST /api/settings/{lan,join}`, `GET /join`와 `GET/POST /v1/magpie/join`, `Remote magpie` provider preset, desktop의 `GET/POST /api/remote` 및 `POST /api/remote/forget`. `mgp:internal/gui/api.go:1746,2853`, `internal/gui/join.go:16`, `internal/gateway/gateway.go:1179`, `internal/provider/presets.go:814`, `internal/gui/remote.go:270` | `ocx connect`, `ocx link`, `ocx hub` 및 `src/remote/` 자료 계약. Link Home/Child와 Hub/client는 별도 동선. `ocx:src/cli/dispatch.ts:423`, `src/cli/link.ts:512`, `src/cli/hub.ts:239,381`, `src/remote/hub-management-relay.ts:3,59` |
| 백업·동기화 | `/api/backup/{export,import}`, `/api/autobackup[/{action}]`, `/api/davsync[/{action}]`. CLI `backup/restore, webdav/dav, s3, github`. `mgp:internal/gui/backup.go:24,82,122,205`, `internal/cli/main.go:692,703` | `ocx sync`는 Codex catalog 및 연결 runtime 방향의 sync. Desktop profile은 명시적으로 export/import한다. `ocx:src/cli/dispatch.ts:418`, `src/codex/sync.ts:103`, `src/cli/claude-desktop.ts:915,927` |
| Library | `GET /api/library`, `POST /api/library/{what}/{action}`와 auth/check/config 전용 handlers. 서버·도구 토글, env/hooks/plugins, skills, rules, commands, subagents, instructions, project presets, 전체 sync. CLI `library/lib`와 `mcp`, 원격 Library snapshot도 별도. `mgp:internal/gui/library.go:221,654,724,742,759,815,869,898,939,1006,1045`, `internal/cli/main.go:462,690`, `internal/provider/remote_library.go:15` | `ocx claude desktop` profile 및 picker, `ocx agent` surface. `ocx:src/cli/claude-desktop.ts:58,630`, `src/server/management/native-integration-routes.ts:783,1106`, `src/server/management/codex-agent-role-routes.ts:2` |
| 표시·배포 | Wails SystemTray + window/panel, browser UI, TUI, CLI. `/api/update`와 `/api/update/{notes,check,install,using}`, `update` CLI, Docker tag workflow. `mgp:internal/gui/app.go:334,637,663,695`, `internal/cli/web_cli.go:21,29,225`, `internal/gui/update.go:960`, `internal/cli/main.go:688`, `.github/workflows/docker.yml:3` | Tauri tray, 별도 Windows CLI tray, React dashboard와 package/App updater. `ocx:desktop/src-tauri/src/startup.rs:1521`, `src/tray/windows.ts:639,737`, `src/server/index/serve-options.ts:1910`, `src/server/management/config-routes.ts:998,1008,1053` |

### Agent 등록 인덱스

`mgp:internal/agent/agents.go:321–416`의 정적 constructor 호출 93개를 아래에 기록했다. 분류와 줄 번호는 해당 constructor의 진입부를 뜻한다. 쓰기 동작은 이어지는 adapter에서 확인한다. 실제 감지는 `Detected`의 agent별 override 또는 파일/디렉터리, 로그인 신호 및 실행 바이너리 앞단을 거친다. 등록 목록에는 importer와 launcher 등도 있다. `All`은 설치 상태에 상관없이 항목을 만들고, 이동한 adapter를 제외한 다음 plugin·WSL·OMP/QwenPaw/Hermes/Claude 프로필 항목을 더한다. `ClientsIn`는 nested/WSL 항목을 마케팅상의 agent 수와 달리 집계하며, `others`는 사용량/UA 식별용이다. 설치·쓰기 성공률은 미측정이다. `mgp:internal/agent/agents.go:196,241,258,287,318,416`, `internal/agent/agent.go:466,685`, `internal/agent/wsl.go:1187,1338`.

OpenCodex 등록 비교는 24개 export ID와 native 4개를 출발점으로 한다. export 범위와 client-specific managed writer는 `INTEGRATION_CLIENTS`, 경로 resolver, 별도 gateway-client surface로 확인한다. `ocx:src/clients/client-ids.ts:2`, `src/integrations/registry.ts:199,288,532`, `src/server/management/integration-routes.ts:748`, `src/server/management/native-integration-routes.ts:69`.

| `onMachineAll` 등록 | adapter 진입점 |
|---|---|
|
| `claude` | `mgp:internal/agent/claude.go:696` |
| `claudeDesktop` | `mgp:internal/agent/claudedesktop.go:134` |
| `claudeScience` | `mgp:internal/agent/claudescience.go:613` |
| `codex` | `mgp:internal/agent/codex.go:92` |
| `gemini` | `mgp:internal/agent/gemini.go:23` |
| `agy` | `mgp:internal/agent/agy.go:234` |
| `dim` | `mgp:internal/agent/dim.go:127` |
| `antigravity` | `mgp:internal/agent/antigravity.go:261` |
| `opencode` | `mgp:internal/agent/agents.go:1432` |
| `openChamber` | `mgp:internal/agent/openchamber.go:162` |
| `mimocode` | `mgp:internal/agent/agents.go:1472` |
| `deveco` | `mgp:internal/agent/agents.go:1492` |
| `pi` | `mgp:internal/agent/agents.go:1507` |
| `stepcode` | `mgp:internal/agent/stepcode.go:27` |
| `mothx` | `mgp:internal/agent/mothx.go:47` |
| `penguin` | `mgp:internal/agent/penguin.go:118` |
| `aside` | `mgp:internal/agent/aside.go:12` |
| `omo` | `mgp:internal/agent/omo.go:20` |
| `primeAgent` | `mgp:internal/agent/primeagent.go:25` |
| `mu` | `mgp:internal/agent/mu.go:28` |
| `goose` | `mgp:internal/agent/agents.go:1813` |
| `cursor` | `mgp:internal/agent/agents.go:1909` |
| `cursorLocal` | `mgp:internal/agent/cursorlocal.go:282` |
| `zed` | `mgp:internal/agent/zed.go:25` |
| `vscode` | `mgp:internal/agent/vscode.go:128` |
| `vscodeInsidersAgent` | `mgp:internal/agent/vscode.go:130` |
| `vscodium` | `mgp:internal/agent/vscode.go:132` |
| `zooCode` | `mgp:internal/agent/zoocode.go:60` |
| `copilotJetBrains` | `mgp:internal/agent/copilotjetbrains.go:69` |
| `air` | `mgp:internal/agent/air.go:139` |
| `airIDE` | `mgp:internal/agent/air.go:170` |
| `copilot` | `mgp:internal/agent/agents.go:1947` |
| `crush` | `mgp:internal/agent/agents.go:2110` |
| `dsh` | `mgp:internal/agent/dsh.go:97` |
| `dsbot` | `mgp:internal/agent/dsbot.go:95` |
| `reasonix` | `mgp:internal/agent/reasonix.go:80` |
| `commandCode` | `mgp:internal/agent/commandcode.go:24` |
| `fx` | `mgp:internal/agent/fx.go:95` |
| `omp` | `mgp:internal/agent/omp.go:143` |
| `devin` | `mgp:internal/agent/devin.go:24` |
| `hermes` | `mgp:internal/agent/hermes.go:53` |
| `morph` | `mgp:internal/agent/morph.go:34` |
| `kimi` | `mgp:internal/agent/kimi.go:236` |
| `qwen` | `mgp:internal/agent/qwen.go:150` |
| `muse` | `mgp:internal/agent/muse.go:33` |
| `empryo` | `mgp:internal/agent/empryo.go:33` |
| `nanobot` | `mgp:internal/agent/nanobot.go:53` |
| `miniq` | `mgp:internal/agent/miniq.go:73` |
| `paimon` | `mgp:internal/agent/paimon.go:55` |
| `ante` | `mgp:internal/agent/ante.go:87` |
| `astrbot` | `mgp:internal/agent/astrbot.go:111` |
| `qwenpaw` | `mgp:internal/agent/qwenpaw.go:211` |
| `openClaw` | `mgp:internal/agent/openclaw.go:241` |
| `jcode` | `mgp:internal/agent/jcode.go:179` |
| `vibe` | `mgp:internal/agent/vibe.go:224` |
| `miniMax` | `mgp:internal/agent/minimax.go:81` |
| `droid` | `mgp:internal/agent/droid.go:378` |
| `cline` | `mgp:internal/agent/cline.go:55` |
| `qoder` | `mgp:internal/agent/qoder.go:41` |
| `qoderCN` | `mgp:internal/agent/qoder.go:45` |
| `grok` | `mgp:internal/agent/grok.go:225` |
| `kigi` | `mgp:internal/agent/kigi.go:25` |
| `grokApp` | `mgp:internal/agent/grokapp.go:170` |
| `zcode` | `mgp:internal/agent/zcode.go:67` |
| `workbuddy` | `mgp:internal/agent/workbuddy.go:50` |
| `workbuddyAI` | `mgp:internal/agent/workbuddy.go:61` |
| `codebuddy` | `mgp:internal/agent/codebuddy.go:39` |
| `pencil` | `mgp:internal/agent/pencil.go:34` |
| `paseo` | `mgp:internal/agent/paseo.go:110` |
| `openPencil` | `mgp:internal/agent/openpencil.go:81` |
| `openBot` | `mgp:internal/agent/openbot.go:83` |
| `craftAgents` | `mgp:internal/agent/craftagents.go:106` |
| `obsidian` | `mgp:internal/agent/obsidian.go:94` |
| `tuanjieCowork` | `mgp:internal/agent/tuanjiecowork.go:55` |
| `newMax` | `mgp:internal/agent/newmax.go:85` |
| `liveAgent` | `mgp:internal/agent/liveagent.go:96` |
| `raycast` | `mgp:internal/agent/raycast.go:52` |
| `kiroCrew` | `mgp:internal/agent/kirocrew.go:370` |
| `t3code` | `mgp:internal/agent/t3code.go:123` |
| `openMausBot` | `mgp:internal/agent/openmausbot.go:136` |
| `avibe` | `mgp:internal/agent/avibe.go:63` |
| `kun` | `mgp:internal/agent/kun.go:196` |
| `nowledgeMem` | `mgp:internal/agent/nowledgemem.go:155` |
| `hanako` | `mgp:internal/agent/hanako.go:75` |
| `atomcode` | `mgp:internal/agent/atomcode.go:52` |
| `ocr` | `mgp:internal/agent/ocr.go:39` |
| `snow` | `mgp:internal/agent/snow.go:56` |
| `alma` | `mgp:internal/agent/alma.go:836` |
| `shelley` | `mgp:internal/agent/shelley.go:442` |
| `cindy` | `mgp:internal/agent/cindy.go:128` |
| `aionui` | `mgp:internal/agent/aionui.go:107` |
| `cherryStudio` | `mgp:internal/agent/cherrystudio.go:169` |
| `lody` | `mgp:internal/agent/lody.go:106` |

WSL 후보 registry `wslKinds`는 Claude Science, Codex, Pi, OmO, Prime Agent, mu, StepCode, Claude Code, OpenCode, MiMo Code, Kimi, Qwen, omp, Crush, Hermes, Morph, Grok, Kigi, Droid, fx, Command Code, MiniMax Code, dsh, Empryo, nanobot, Paimon, miniQ, Ante, Muse, Qoder/Qoder CN, CodeBuddy, Cline, AtomCode, Open Code Review, Snow, Gemini CLI, Antigravity CLI, Goose, MothX, PenguinHarness, Reasonix를 포함한다. distro probe에서 발견된 kind와 이름이 있는 omp 프로필만 instance가 생긴다. Plugin 정의는 `pluggedAgents`에서 설치된 plugin set과 합쳐진다. `mgp:internal/agent/wsl.go:472,1194,1208`, `internal/agent/plugged.go:93`.

### 설정 형식과 연결·복원 계약

| 구현 묶음 | 어디를 어떻게 쓰는가 |
|---|---|
| Codex | `CODEX_HOME/config.toml`의 top-level 및 provider table과 `magpie-models.json`. ChatGPT 로그인 유지와 provider 전환을 분기한다. `mgp:internal/agent/wsl.go:113`, `internal/agent/codex.go:265,672,1854,1926,2057` |
| Claude Code | `CLAUDE_CONFIG_DIR/settings.json`에서 env와 모델, tier, subagent를 부분 수정한다. 별도 프로필은 감지 후 각 디렉터리로 분리한다. `mgp:internal/agent/wsl.go:123`, `internal/agent/claude.go:710,2024`, `internal/agent/claude_dirs.go:59` |
| OpenCode 및 파생 구현 | `openCodeLike`가 JSON provider와 모델 선택 쌍을 담당한다. v2 전환 및 OpenCode 계열 차이는 별도 adapter다. Pi 계열은 `piLikeKeyed`, Goose는 YAML config writer를 쓴다. `mgp:internal/agent/agents.go:1257,1432,1472,1492,1632,1819`, `internal/agent/opencode_v2.go` |
| Raycast, Zed | Raycast는 YAML `providers` sequence 항목, Zed는 JSON 모델 및 provider 블록과 플랫폼 credential helper. `mgp:internal/agent/raycast.go:52,183,232`, `internal/agent/zed.go:51,86` |
| 다른 쓰기 유형 | Qwen `settings.json` JSON, Kimi·Grok·Vibe·Jcode TOML, Hermes·MiniMax YAML, Cline provider/state JSON, NewMax·AionUI SQLite, Lody 앱 import handoff. 인덱스의 진입부 기준이며 앱 버전별 전체 schema는 보류했다. `mgp:internal/agent/qwen.go:150`, `internal/agent/kimi.go:236`, `internal/agent/grok.go:225`, `internal/agent/vibe.go:224`, `internal/agent/jcode.go:179`, `internal/agent/hermes.go:53`, `internal/agent/minimax.go:81`, `internal/agent/cline.go:55`, `internal/agent/newmax.go:85`, `internal/agent/aionui.go:107`, `internal/cli/main.go:735` |
| 공통 계약 | 연결은 명시적 `ConnectHow`/picker 또는 agent CLI 조작에서 시작한다. 이미 연결된 상태는 유지하고, 재연결 → agent Join → remote → model/provider pick 순서로 선택한다. `Apply`는 adapter setter를 실행하고 적용값을 기록한다. `Disconnect`는 adapter Unwire 또는 공유 기본 경로를 사용하고 user disconnect를 기억한다. `mgp:internal/agent/applied.go:109,710,749,895,923` |
| 충돌·롤백 | `Drift`는 외부 변경, 연결 끊김, 우회 및 도달 실패를 구분한다. 의도적인 agent picker 변경이나 손으로 만든 provider의 예외가 있다. GET drift와 Keep/Reapply를 연결한다. 일부 adapter는 config·stash 등 지정 파일을 `edit.Atomically`로 되돌린다. `peek/forgetValues`는 성공 후 같은 stash 값만 소비하고 `unstash`는 별도 방식이다. GUI Disconnect preview는 native plan 또는 격리 diff이며 offline native 경로는 plan revision을 검사한다. `mgp:internal/agent/applied.go:144,194,225,254,499`, `internal/agent/agent.go:837`, `internal/edit/file.go:332`, `internal/agent/stash.go:113,128,144`, `internal/gui/api.go:1438,1574,1601,1643` |

### 세 클라이언트 E2E 소스 경로

1. **Codex** (`CAP-client-config-codex`)

   - Magpie의 등록은 `agents.go:326` → `codexIn`이다. Agents의 Connect 또는 CLI model pick으로 시작한다. `Join`은 native 로그인과 catalog를 함께 쓰는 경로이며, 별도 provider 경로는 `model_provider`, `model_catalog_json`, `model`과 소유한 `openai_base_url`을 설정한다. 쿼터가 막혀 앱이 요청을 보내지 못하는 상황의 provider 전환 조건과, 쿼터 회복 시 복귀 조건이 구현돼 있다. 이전 provider/모델/카탈로그/effort를 보관하고 복원 시 사용자 변경과 catalog 파일 존재를 확인한다. `mgp:internal/gui/api.go:1635`, `internal/cli/main.go:760,791`, `internal/agent/codex.go:265,672,1761,1859,1926,1986,2037,2259,2282,2962`.
   - OpenCodex의 Native toggle은 desired state 기록 → `syncModelsToCodex` → catalog preflight 및 `injectCodexConfig`, OFF는 `restoreNativeCodexAsync`로 간다. absent desired state는 ON이고 hub/sibling 및 외부 소유 설정에 대한 gate가 있다. restore는 자체 journal, desired-state 재확인, catalog/history 처리로 이어진다. `ocx:src/server/management/native-integration-routes.ts:404,423,447,488,1102`, `src/codex/desired-state.ts:63,80,139`, `src/codex/sync.ts:103,115,235,308`, `src/codex/inject/restore.ts:269,583,616,747`.

2. **Claude Code** (`CAP-client-config-claude`)

   - Magpie의 `claudeIn`이 Claude 홈을 해석한다. Connect/model pick은 base URL, auth token, top-level model, tier·subagent를 JSON leaf 단위로 쓴다. 기존 sign-in 유지 설정에서 token 처리가 달라진다. 첫 실행 mark는 연결에서 실제로 추가한 경우에 한해 복원한다. 로컬 managed settings의 우선순위 충돌은 `Check`에서 보고하고, Unwire는 stashed endpoint/token/model/tier와 소유한 statusline·effort를 처리한다. `mgp:internal/agent/agents.go:323`, `internal/agent/claude.go:710,762,788,1784,1856,2024,2081,2547,2556,2713`.
   - OpenCodex `ocx claude` → `withClaudeContextSettings` → `spawnClaude`는 launch env에 proxy 주소, auth 및 model 정보를 전달한다. `PUT /api/native-integrations/claude`는 기본 ON인 inbound를 토글하며 OFF에서 marker-owned subagent 파일을 정리한다. 별도 first-party 설정 reconcile 및 intercept는 local management, role과 intercept enablement gate를 거친다. 이 차이가 vendor env 설정의 상시 연결 UX에 해당한다. `ocx:src/cli/dispatch.ts:921`, `src/cli/claude.ts:248,296,340,926,952`, `src/server/management/native-integration-routes.ts:197,1016,1074`, `src/server/management/claude-intercept-routes.ts:5,11,29`, `src/server/management/agent-settings-routes.ts:1660,1683,1762`, `src/claude/first-party-settings.ts:46`, `src/claude/intercept/settings.ts:224,277`.

3. **Raycast** (`CAP-client-config-raycast`)

   - Magpie의 등록은 `agents.go:399` → `raycast`다. 앱 bundle 또는 사용자 디렉터리를 감지하고 명시적 provider connect에서 `~/.config/raycast/ai/providers.yaml`에 `magpie` provider와 모델 목록, `/v1` 주소를 연결한다. 지원되지 않는 YAML shape의 오류를 반환하고, 재동기화 때 이미 붙은 항목과 추가 필드를 병합한다. Disconnect는 그 항목과 비게 된 sequence를 제거한다. 개별 모델 고르기는 Raycast 쪽에서 이루어진다. `mgp:internal/agent/raycast.go:52,70,86,128,183,232,262`.
   - OpenCodex는 Raycast가 만든 `ai` 디렉터리로 감지 범위를 좁히고, `PUT /api/client-integrations/raycast`의 명시적 `enabled`/overwrite/plan binding에 따라 mutate한다. builder는 `providers[id=opencodex]`를 대상으로 모델 목록을 쓴다. YAML을 다시 직렬화하는 경로와 공유 journal/restore preview가 있다. `ocx:src/server/management/integration-routes.ts:915,966,1016,1162,1196,1230`, `src/integrations/registry.ts:460`, `src/clients/config-export/raycast.ts:40,99`, `src/integrations/mutation-plan.ts:169`.

## 3. 기능 인벤토리

Magpie의 provider 설정 탐색과 계정 탐색은 별개다. `NoAccountDiscovery` / `MAGPIE_NO_ACCOUNTS`는 자체 로그인 읽기를 gate하고 Codex auth 및 Claude credentials reader에서 확인한다. Providers 후보 목록은 `DiscoverSources`에 등록된 설정 파일을 읽는다. 명시적 batch 이주에는 CLI 확인이 있으며 Codex refresh 방식과 access-only의 세션 영향을 사용자에게 구분해 알린다. `mgp:internal/settings/accounts.go:14,35`, `internal/provider/discovery.go:36`, `internal/provider/codex_store.go:520`, `internal/provider/claude_dirs.go:67,77`, `internal/provider/importapps.go:79,100`, `internal/cli/accounts_cli.go:635,657,672`.

| CAP | 기능 | Magpie 진입 · 구현 · gate | OpenCodex 진입 · 구현 · gate 또는 부재 확인 | 상태 | 근거 |
|---|---|---|---|---|---|
| CAP-client-config-codex | 영구 config, catalog, native 복귀, 로그인 옆 모델 모드 | Agents Connect/model pick → `codexIn`과 `Join/Unwire`. 로그인/쿼터와 명시적 연결에 따른 분기. `mgp:internal/gui/api.go:1635`, `internal/agent/codex.go:265,1761,1859,1926,1986,2037,2282` | Native PUT → desired state → sync/inject/restore. unset=ON, hub/sibling/외부 소유 gate. 구현 차이는 위 E2E 참조. `ocx:src/server/management/native-integration-routes.ts:404,488,1102`, `src/codex/desired-state.ts:63,80`, `src/codex/sync.ts:115,308` | partial | OBSERVED |
| CAP-client-config-claude | 일반 CLI 실행에 적용되는 설정과 복원 | Agents Connect/CLI pick → `claudeIn`이 JSON env/model을 변경한다. 기존 로그인 유지 옵션과 managed config 충돌 진단. `mgp:internal/gui/api.go:1635`, `internal/agent/claude.go:710,762,2024,2556,2713` | `ocx claude` launch env 및 native inbound 토글, 별도 first-party 설정 경로가 gate를 만족할 때 디스크에 적용된다. `ocx:src/cli/dispatch.ts:921`, `src/cli/claude.ts:926`, `src/server/management/native-integration-routes.ts:197,1016`, `src/server/management/claude-intercept-routes.ts:5`, `src/claude/first-party-settings.ts:46` | partial | OBSERVED |
| CAP-client-config-raycast | YAML provider 항목과 모델 목록 | Agent setter → YAML sequence merge/unwire. 앱 또는 디렉터리 감지, 연결 요청 시 쓰고 연결된 경우만 Sync. `mgp:internal/agent/raycast.go:52,70,86,183,232` | 관리 PUT → id 기반 contribution. `ai` 디렉터리 감지, 명시적 toggle과 충돌/plan gate. 두 구현의 YAML merge 범위에 차이. `ocx:src/integrations/registry.ts:460`, `src/clients/config-export/raycast.ts:99`, `src/server/management/integration-routes.ts:1162,1196,1230` | partial | OBSERVED |
| CAP-client-config-zed | Zed 로컬 설정을 proxy에 연결 | Agents setter → `settings.json`의 모델 선택 및 custom provider, platform credential helper. Magpie model pick에서 쓰고 native pick/Disconnect에서 복원한다. `mgp:internal/agent/agents.go:346`, `internal/agent/zed.go:51,70,86,103` | A7. `ocx:src/providers/registry/entries-core.ts:248`와 `src/providers/zed.ts:4`는 upstream Zed Hosted AI. `ocx:src/clients/client-ids.ts:2` 및 `src/integrations/registry.ts:288`의 client writer에 Zed가 없다. | gap | OBSERVED |
| CAP-client-config-roster | client 등록, 감지, 확장 | `agents` 및 Agents UI → `All/Detected`, app/WSL/profile/plugin 추가. 적용은 명시적 agent action. `mgp:internal/cli/main.go:637,641`, `internal/agent/agents.go:258,287,321`, `internal/agent/agent.go:466` | `integration`, client routes → registry와 resolver. write는 scope와 enabled 입력을 확인한다. `ocx:src/cli/dispatch.ts:879`, `src/clients/client-ids.ts:2`, `src/integrations/registry.ts:199,288`, `src/server/management/integration-routes.ts:1162,1196` | partial | OBSERVED |
| CAP-client-config-drift | 변경 감지, 유지, 재적용, preview/restore | `/api/drift`, `/api/agents/{action}/{id}` → 기록 비교 및 Keep/Reapply; native preview revision, 일부 adapter의 atomic write. `mgp:internal/gui/api.go:1438,1574,1620,1643`, `internal/agent/applied.go:194,225,254,499` | managed `preview/journal/restore`, explicit overwrite 및 plan binding. Native Codex restore도 ownership gate를 갖는다. `ocx:src/server/management/integration-routes.ts:830,915,966,1016,1196,1230`, `src/integrations/ownership.ts`, `src/codex/inject/restore.ts:269,616` | partial | OBSERVED |
| CAP-import-cc-switch | CC Switch provider 설정 이주 | `GET/POST /api/importapps` → read-only DB reader → 선택된 provider/key 조합 import, 재조회/중복 처리. `mgp:internal/gui/importapps.go:48,70`, `internal/provider/importapps.go:87,131,279,589` | `ocx provider import-cc-switch` → byte-level keyless projection, 명시적 source, 기본 preview, apply/restore와 journal. `ocx:src/cli/provider.ts:659`, `src/cli/provider-cc-switch-import.ts:72,86,99`, `src/providers/cc-switch-import.ts:747,855` | partial | OBSERVED |
| CAP-import-local-discovery | Providers 페이지에서 타 앱 설정 후보 발견 | Providers desktop window에서 분당 최대 한 번 조회. Alma, agy, CC Switch, Claude Code, Codex 기본 검색, OpenCode auth는 picker를 열 때만. fingerprint 힌트 → review → 선택. `mgp:internal/gui/assets/app.js:10802,10824,10840,10857`, `internal/gui/importapps.go:30,48,70`, `internal/provider/importapps.go:79,100,131` | A8. `ocx:src/cli/provider-cc-switch-import.ts:81,86`은 CC Switch 파일을 명시하는 CLI. `ocx:src/codex/routing-healer.ts:150,206`은 자체 config repair, `src/server/management/provider-routes.ts:896,1133`은 proxy provider 목록/저장이다. | gap | OBSERVED |
| CAP-import-account-batch | Codex·Claude 파일 기반 계정 이주, CLIProxyAPI·Sub2API·CodexBar | GUI `POST /api/login/{action}` import와 `magpie accounts import` → `ImportLogins`; 요청으로 제공된 파일에서 Sub2API platform/credentials, CodexBar, claude-swap, native/CPA/Cockpit 형식을 해석. Codex access-only 별도 분기, per-entry validation. `mgp:internal/gui/providers.go:3459,3729`, `internal/cli/accounts_cli.go:674`, `internal/provider/login_import.go:101,129,182,264,338,367,652` | A3b. `ocx account import` → `POST /api/oauth/accounts/import` → registry가 Antigravity의 지정 형식만 수락한다. Codex native-main 관리와 CTA는 이 batch format ingestion을 제공하지 않는다. `ocx:src/cli/account.ts:510`, `src/cli/account-extended.ts:638`, `src/server/management/oauth-account-routes.ts:1130,1158`, `src/oauth/account-import/registry.ts:12` | gap | OBSERVED |
| CAP-import-account-antigravity | Antigravity 계정 이주 | `magpie accounts import antigravity`와 GUI import 분기는 관찰했다. exact Cockpit scope의 유효성 및 동등한 복원 계약은 보류. `mgp:internal/cli/main.go:112`, `internal/cli/accounts_cli.go:647,678`, `internal/provider/google_import.go:178` | `POST /api/oauth/accounts/import` → registry/service → Google Antigravity adapter. provider 및 format gate. `ocx:src/server/management/oauth-account-routes.ts:1130`, `src/oauth/account-import/registry.ts:14`, `src/oauth/account-import/service.ts:27` | unknown | OBSERVED-partial |
| CAP-deeplink-import | relay/provider 사전 채우기와 지정 후 저장 | OS scheme/`magpie import` → `ParseImport`(preset 또는 custom endpoints) → one-shot preview/Replace 표시 → explicit Add, CLI `-y` 선택. HTTPS landing의 fragment로 전달한다. `mgp:build/darwin/Info.plist:21`, `site/public/import.html:79,143`, `internal/gui/app.go:789,833`, `internal/gui/importlink.go:30,57`, `internal/gui/assets/app.js:11092,11140`, `internal/provider/importurl.go:54,71`, `internal/cli/providers_cli.go:1820` | A1. `ocx:gui/src/app-routing.ts:100,120`은 앱 내부 navigation이고, `src/server/management/provider-routes.ts:1133`은 이미 열린 management UI/API에서 입력 요소를 저장한다. Link join은 연결 enrollment다. `ocx:src/server/management/link-routes.ts:725` | gap | OBSERVED |
| CAP-remote-proxy-share | 모델 목록·라우팅을 팀/기기간 공유 | LAN 명시 활성화 → `ConfigureLAN`/key → `Remote magpie` preset과 endpoint 채움. 별도 Join password를 설정하면 `/join`으로 caller key를 받는다. `mgp:internal/gui/api.go:2853`, `internal/access/access.go:1015`, `internal/gui/join.go:16`, `internal/gateway/gateway.go:1179`, `internal/provider/presets.go:814`, `internal/provider/provider.go:1943`, `internal/provider/remote_magpie.go:77` | Hub 초대는 `runtimeRole=hub`, origin, live attestation을 확인 후 발행. Home/Child Link는 join/probe/confirm-host/apply, CLI connect와 별도 enrollment. 기본 role standalone. `ocx:src/cli/hub.ts:239,251,284,309,332`, `src/cli/dispatch.ts:423`, `src/server/management/link-routes.ts:725,809,814,819`, `src/config/proxy-env.ts:32` | partial | OBSERVED |
| CAP-remote-admin-window | 타 호스트 관리 Web UI를 앱에서 열기 | native GUI에서만 `/api/remote` 등록 → URL/key 검증, probe 성공 후 별도 창. data-plane preset과 권한이 별도다. `mgp:internal/gui/api.go:1746`, `internal/gui/remote.go:270,279,309,319,324` | Hub Relay read/credential 및 Link management route가 있다. 타 원격 UI의 직접 개창과 전체 scope는 보류. `ocx:src/remote/hub-management-relay.ts:3,59`, `src/server/hub-relay-auth.ts:32,54`, `src/link/management-routes.ts` | unknown | OBSERVED-partial |
| CAP-config-sync-encrypted | WebDAV/S3/GitHub passphrase 동기화 | `/api/davsync/{action}`와 CLI `webdav/s3/github` → Configure/Preview/Sync/Undo. 저장된 setup이 있고 manual이 아닐 때 기본 3분, follow-server 가능. backend 선택 후 PBKDF2-SHA256 기반 AES-256-GCM bundle을 읽고 쓴다. `mgp:internal/gui/backup.go:205,215,245,273`, `internal/cli/main.go:703`, `internal/davsync/dav.go:138`, `internal/davsync/davsync.go:64,147,874,1466,1519,1813`, `internal/backup/backup.go:388,411,469` | A4. `ocx:src/cli/dispatch.ts:418` → `src/codex/sync.ts:103`은 catalog/config reconcile. `src/cli/claude-desktop.ts:915,927`의 versioned profile 파일과 `src/server/management/link-routes.ts:830`의 Child ops는 범용 암호화 저장소 sync를 수행하지 않는다. | gap | OBSERVED |
| CAP-library-mcp | MCP 서버·tool 정책을 여러 agent에 관리 배포 | GUI Library server assignments → `ServerAgents`/`syncMCP`. 명시적 선택, target 지원 여부, owned manifest, 외부 항목 충돌 및 optional MCP router를 확인한다. `mgp:internal/gui/library.go:759,815,853`, `internal/library/sync.go:230,251,283,353,376,973` | A5. `ocx:src/server/management/codex-agent-role-routes.ts:2`의 role model 및 `src/cli/claude-desktop.ts:68,73`의 picker는 client별 MCP catalog/assignment를 제공하지 않는다. | gap | OBSERVED |
| CAP-library-skills | Library skill 배포와 Claude Desktop manifest reconcile | Library skill install/assign → `InstallSkills`/`syncSteps`. 일반 target은 공유 `.agents/skills` dedup, Desktop target은 기존 native 계정의 manifest/plugin roots에 복사, 변경된 복사와 무관한 skill을 보호한다. `mgp:internal/gui/library.go:922,939,1045`, `internal/library/skills.go:718,1550,2237`, `internal/library/sync.go:135,148,154`, `internal/library/desktop_skills.go:45,59,167,250,274,305,328` | A5b. `ocx:src/claude/desktop-3p-library.ts:20` 및 `src/claude/desktop-picker-profile.ts:159`는 3P config profile library를 다룬다. `src/server/management/native-integration-routes.ts:783,1106`의 toggle 대상도 routing 설정이다. | gap | OBSERVED |
| CAP-surface-tray | 시스템 tray / 메뉴바와 조작 | `magpie tray` → `Run(false)` → Wails tray, usage/빠른 panel; native GUI 빌드 필요. `mgp:internal/cli/main.go:621`, `internal/gui/app.go:334,637,663,695`, `Makefile:17,57,60` | Tauri startup이 지원 tray를 붙이고, Windows 별도 `ocx tray install/start`에서 PowerShell tray 시작. 두 제품의 menu/panel 범위 차이. `ocx:desktop/src-tauri/src/startup.rs:1521`, `desktop/src-tauri/src/tray.rs:75`, `src/cli/dispatch.ts:603`, `src/tray/windows.ts:639,737,798` | partial | OBSERVED |
| CAP-surface-tui | 대화형 터미널 agent/model picker | `magpie tui` → `runTUI` → `tui.Run`; 감지된 agent·picker를 Bubble Tea에 표시. 명시적 subcommand. `mgp:internal/cli/main.go:294,610`, `internal/tui/tui.go:162,192,489` | A6. `ocx:src/cli/dispatch.ts:328,418,879`의 command별 status/sync/integration 및 `gui/src/pages/integrations/IntegrationsOverview.tsx:854` GUI는 터미널 picker에 해당하지 않는다. | gap | OBSERVED |
| CAP-surface-cli | 비대화형 진단·클라이언트 관리 명령 | `magpie ls/agents/status`, explicit field setters와 default 복원. `mgp:internal/cli/main.go:637,641,686,757,791,885` | `ocx status/integration/export` 및 native toggles. explicit mutation과 supported import/export 범위. CLI 조작 표면 수준의 동등성. `ocx:src/cli/dispatch.ts:328,879`, `src/cli/registry.ts:573`, `src/server/management/integration-routes.ts:1196` | parity | OBSERVED |
| CAP-surface-web | 브라우저에서 proxy 관리 | `magpie web`, `serve --web` → loopback 기본 `3430`, web session/key guard. `mgp:internal/cli/main.go:612,674`, `internal/cli/web_cli.go:21,29,225`, `internal/gui/web.go:264,416,436` | server에서 GUI dist를 제공하고 세션 bootstrap 및 ingress 정책을 적용한다. `ocx:src/server/index/serve-options.ts:440,1910`, `src/server/gui-static.ts:48,179,195` | parity | OBSERVED |
| CAP-distribution-docker | 컨테이너의 서비스 진입, 상태와 영속 경로 | Dockerfile은 Debian slim runtime + `/magpie serve`, `/config`, 3425/3430과 healthcheck. version builds와 stable/daily tag promotion. `mgp:Dockerfile:36,68,78,80,85`, `.github/workflows/docker.yml:3`, `.github/workflows/docker-stable.yml:12`, `.github/workflows/docker-daily.yml:14` | Bun runtime image + `start --port 10100`, homes volumes와 healthcheck. tag cadence의 동등성은 별도다. `ocx:Dockerfile:75,80,101,104,107` | parity | OBSERVED |
| CAP-release-channels | 채널에 따른 릴리스 선택과 배포 | `v*` tag dispatch → 별도 release repo 빌드·발행·mirror. site worker stable/daily 정책, Docker tag workflow가 feed를 조회한다. `mgp:.github/workflows/release.yml:10,49,131,165`, `site/worker.js:780,877`, `.github/workflows/docker-stable.yml:27,45` | dispatch release workflow의 latest/preview channel 검증 및 publish gate, package refresh는 이 채널을 사용한다. `ocx:.github/workflows/release.yml:10,151,241,1196`, `src/update/refresh-scheduler.ts:63,127` | partial | OBSERVED |
| CAP-auto-update | 주기적 확인, staging, 설치·재시작 | desktop/web start → updater loop. 기본 360분 체크, `NoAutoUpdate/NoAutoDownload` 및 별도 `AutoRestart` gate, install endpoint와 idle 대기. `mgp:internal/gui/app.go:613`, `internal/gui/web.go:145`, `internal/gui/update.go:204,208,244,731,1024`, `internal/gui/update_wait.go:236`, `internal/settings/settings.go:601,3066` | package startup refresh와 management check/run/status, Desktop 비-debug background checks와 별도 설치. Windows headless Desktop updater는 명시적으로 실행하고 GUI trust key로 staged MSI까지 검증. `ocx:src/server/index.ts:878`, `src/server/management/config-routes.ts:998,1008,1053`, `desktop/src-tauri/src/lib.rs:279,290,433`, `desktop/src-tauri/src/updater.rs:354,513`, `src/cli/dispatch.ts:657`, `src/desktop-update/headless.ts:131,186,208` | partial | OBSERVED |
| CAP-i18n | Web UI locale 선택 폭 | settings의 언어 선택 또는 시스템을 따르는 5종. `mgp:internal/gui/api.go:1794`, `internal/gui/assets/i18n.js:22447,22460`, `internal/uilang/uilang.go:14` | React 진입의 LanguageProvider → 저장된 locale/브라우저 값과 typed catalogs. GUI 목록은 한국어를 포함한 11종. `ocx:gui/src/main.tsx:18`, `gui/src/i18n/shared.ts:6,24`, `gui/src/i18n/provider.tsx:6,13,25`, `gui/src/i18n/catalogs.ts:26` | ocx-ahead | OBSERVED |
| CAP-onboarding-client | 첫 공급자·클라이언트 설정 | Agents 화면의 Add Provider, Providers discovery review 및 import preview, explicit Connect, Claude의 연결 완료 시 해당 onboarding mark 처리. `mgp:internal/gui/assets/app.js:1608,1961,10802,10840,11092`, `internal/gui/api.go:1647`, `internal/agent/claude.go:788,2081` | Home 체크리스트와 SetupHub, Connect에서 수동 설정. 체크리스트 hide/show 유지, Desktop launch 경로, 연결 대상에 따른 notice gate가 있다. `ocx:gui/src/pages/Home.tsx:79,89,150`, `gui/src/pages/SetupHub.tsx:54,109`, `gui/src/App.tsx:472,479`, `desktop/src-tauri/src/startup.rs:1479` | partial | OBSERVED |

### 부재 확인 명령

OpenCodex `9e0e298ef9` export에서 실행했다. `O=/Users/jun/Developer/new/700_projects/opencodex/.tmp/chase/opencodex-dev`이다. 각 행의 정확한 argv는 `rg -n -i -g '!*.test.*' "$P" "$O/src" "$O/gui/src" "$O/desktop/src-tauri" "$O/docs-site/src" "$O/structure"`이며 `P`에 표의 패턴 전문을 한 인자로 넘겼다. closest equivalent의 차이는 인벤토리 각 행에 있다.

| 확인 ID | 정확한 패턴 | exit | 결과 |
|---|---|---|---|
| A1 | `magpie://\|ccswitch://\|opencodex://\|ocx://\|protocol_scheme\|tauri.plugin.deep.link\|CFBundleURLSchemes` | 1 | 일치 0 |
| A3b | `codexbar\|sub2apiEntry\|parseLoginImport\|ImportCodexAccessOnly\|cliproxyapi` | 0 | CLIProxyAPI wire/identity 참조. `src/adapters/google-antigravity-wire.ts:89`, `src/providers/claude-cli-identity.ts:14` 등에 있고 registry importer에는 없음 |
| A4 | `davsync\|webdav\|follow.server\|sync passphrase\|encrypted sync\|S3 sync\|GitHub sync` | 1 | 일치 0 |
| A5 | `skill(s)?/(agents\|install)\|library/(servers\|skills)\|syncDesktopSkills\|local-agent skills\|managed MCP server library` | 1 | 일치 0 |
| A5b | `local-agent-mode-sessions\|skills-plugin\|desktopSkillRoots\|skills/agents` | 1 | 일치 0 |
| A6 | `bubbletea\|ink\.render\|blessed\.screen\|runTUI\|case ["']tui["']\|ocx tui` | 1 | 일치 0 |
| A7 | `zed/settings\|zed\.dev\|zedConfig\|case ["']zed["']\|["']zed["'] *:` | 0 | 14건. Zed upstream/provider 등록과 문서, client 등록 별도 확인 |
| A8 | `readClaudeSettings\|readCodexConfig\|readOpenCodeAuth\|importapps\|import.?from.?apps\|provider.?import.?preview` | 0 | 3건. routing healer의 config read 2건, CC Switch 명시적 CLI preview 1건 |

표 안의 `\|`는 Markdown 열 이스케이프다. 실제 정규식의 alternation은 `|`이다.


## 4. Gap candidates

평가는 L7의 제안이다. 구현을 채택할 경우 client/management 모듈에 두고 `src/router.ts`·`src/server/lifecycle.ts`·`src/server/responses/core.ts`의 Lab 비의존 경계를 지킨다. ratchet 여유가 없는 파일에서는 sibling module을 사용한다. 실제 자격 증명, 신원·크레딧·평판에 영향을 주는 동작은 사용자 확인과 privacy scan 범위를 설계에 포함한다.

| ID · CAP | 후보 | 가치 · 규모 | 적용 지점 · 의존성 · 위험 |
|---|---|---|---|
| L7-1 · CAP-client-config-claude | 일반 `claude` 실행을 연결하는 opt-in preview/apply/restore와 per-home 상태 표시 | high · L, 설정 우선순위·auth mode·기존 first-party 경로를 조정 | `src/claude/`, `src/server/management/native-integration-routes.ts`의 sibling, Connect UI. tracked env leaf ownership, 실패 시 원본 복원, `CLAUDE_CONFIG_DIR` footprint, 사용자의 기존 로그인과 launch env 유지. |
| L7-2 · CAP-import-account-batch | Codex·Claude용 명시적 batch migration. 형식별 adapter와 결과 receipt | high · L, 계정 식별·중복·부분 실패 대응 | `src/oauth/account-import/`, `src/cli/account-extended.ts`, Accounts UI. opt-in credential intake와 provider parity 검증, 결과 redaction. |
| L7-3 · CAP-import-local-discovery / CAP-import-cc-switch | keyless 앱 발견·리뷰. 시작은 기존 CC Switch importer와 Claude/Codex provider 설정 | high · M, 기존 importer 재사용과 안전한 source adapters | `src/providers/cc-switch-import*.ts`, `src/server/management/provider-routes.ts`의 sibling, Providers UI. 명시적 review 후 apply, source file allowlist, 브라우저에는 metadata만. OpenCode auth로 확대는 별도 승인/모델. |
| L7-4 · CAP-deeplink-import | relay preset의 endpoint·model review, 이후 OS 링크 transport 선택 | high · M, schema와 cross-platform 진입/승인 경계 | `desktop/src-tauri/`, `gui/src/pages/Providers.tsx`, `src/server/management/provider-routes.ts`의 sibling. 목적지 검증 재사용, 키는 링크에서 직접 넣지 않는 형태부터 검토, 식별자 충돌·링크 재사용 방어. |
| L7-5 · CAP-client-config-codex / CAP-client-config-drift | native Codex Connect에서 ownership·계정 모드·쿼터로 인해 다른 상태가 되는 이유와 복원 preview 표시 | high · M, 기존 desired state/restore 계약의 GUI projection | `src/codex/desired-state.ts`, `src/codex/inject/restore.ts` 주변 read-only projection, Connect UI. 기존 외부 소유권 refusal과 history 보호, catalog/실제 transport 상태 구분. Magpie의 automatic provider 전환 복제를 전제로 삼지 않는다. |
| L7-6 · CAP-remote-proxy-share | Hub/Link의 팀 접속 안내를 하나의 사용자 흐름으로 묶고 remote catalog 준비 상태를 표시 | med · M, enrollment/data-plane authority를 재사용 | `src/cli/hub.ts`, `src/link/`, `src/remote/`, Connect UI. origin/host 검증과 key scope 유지, `/join` 복제 전 포트와 권한 분리 확인. |
| L7-7 · CAP-client-config-zed | Zed custom provider export 및 opt-in 연결 | med · M, OS 별 credential 지원과 JSON merge 검증 | `src/clients/config-export/`, `src/integrations/registry.ts` 및 Connect. 기존 Zed upstream ID와 client ID의 구분, 설정에서 사용자 모델 선택 보존. |
| L7-8 · CAP-config-sync-encrypted | reject candidate · 범용 양방향 cloud settings/sign-in sync | low · XL, 암호화 키·충돌·부분 적용·rollback 제품 필요 | `src/config/` 외 선택적 subsystem이 필요. 잔존/새 credentials와 per-machine paths의 병합 위험이 크고, 현재 Hub/Link가 해결하는 연결 관리와 제품 범위가 다르다. |
| L7-9 · CAP-library-mcp / CAP-library-skills | reject candidate · 전체 MCP/skills 및 Cowork manifest 관리자 | low · XL, 여러 agent별 schema·외부 도구 실행·manifest ownership | `src/clients/`와 `src/integrations/` 밖의 별도 제품 영역. MCP 실행/네트워크와 skill 출처 승인이 추가로 필요하며 Codex/Claude 프록시 이주를 직접 줄이지 않는다. |
| L7-10 · CAP-surface-tui | reject candidate · 대화형 별도 TUI | low · L, cross-platform terminal UX와 추가 유지보수 | `src/cli/`. CLI+GUI가 기존 flow를 제공하며 동일한 preview/restore와 localization을 두 번째 UI에 유지하는 비용이 크다. |
| L7-11 · CAP-client-config-roster | reject candidate · 등록 수 맞추기 | low · XL, agent별 파일·플랫폼·릴리스 변경 추적 | `src/clients/`, `src/integrations/`. 잘못된 설치 감지와 오탐 쓰기의 영향을 고려하면 L7-7 같은 사용 근거가 있는 adapter부터 범위를 정한다. |

## 5. OpenCodex-ahead

- `CAP-i18n`의 GUI 언어 선택 폭. 위 판정은 배포된 모든 화면의 번역 품질까지 비교한 결과가 아니다. `ocx:gui/src/i18n/shared.ts:6`, `gui/src/i18n/catalogs.ts:26`.
- `CAP-import-cc-switch`의 keyless preview/restore journal과 `CAP-client-config-drift`의 plan-bound mutation/journal. 이주 시 credential 사용을 늦추거나 충돌을 검토하는 데 재사용할 수 있다. `ocx:src/cli/provider-cc-switch-import.ts:86,99`, `src/providers/cc-switch-import.ts:747,855`, `src/server/management/integration-routes.ts:915,966,1016,1230`.
- `CAP-auto-update`에서 GUI와 동일 trust root를 쓰는 Windows headless 경로, staging 재검증 및 drain. Magpie도 별도 서명·설치 모듈이 있으므로 전체 서명 체계 또는 Windows 설치 성공률 우위는 판정하지 않았다. `ocx:src/desktop-update/trust.ts:8,15`, `src/desktop-update/headless.ts:131,178,208`, `mgp:internal/update/signed.go`.
- `CAP-remote-proxy-share`의 Home/Child enrollment와 개별 child ops 자체가 기존 자산이다. 이를 암호화 cloud sync 또는 generic remote admin window와 동일시하지 않는다. `ocx:src/server/management/link-routes.ts:725,809,814,819,830`, `src/link/management-routes.ts`.

## 6. 최신 사례 (Aside)

`aside-codemode 0.9.2`, 명시적 `u0/local`, 공개 URL만 조회했다. 이 자료는 pinned source 판정과 별개다. 릴리스 페이지의 공개 asset 표와 code tag는 별도 저장소를 가리키므로 version 이름과 관찰된 게시 시각을 함께 기록했다.

| 발행일 | 릴리스/PR/이슈 | 출처 | 열람일 KST | 관찰 | OpenCodex 관련성 | 신뢰도 |
|---|---|---|---|---|---|---|
| 2026-11-23 UTC | Magpie v0.1.4720, release repo `7c8b974` | [GitHub release](https://github.com/yetone/magpie-releases/releases/tag/v0.1.4720) | 2026-11-23 | Web 로그인 유효기간과 키 위치 안내 개선을 기록했다. 바로 앞 버전들도 release list에 보이며, 이 페이지의 CLI 자산은 약 90–100 MB, DMG는 약 46–51 MB 범위다. 게시 시각 12:46 UTC는 Magpie 핀 commit 12:44 UTC 뒤다. **post-head publication**. Web guard 자체는 `mgp:internal/gui/web.go:264,416`에서 확인했다. | 관리 UI 세션이 만료되거나 이동할 때 다시 연결하는 UX, distribution footprint | 높음, 공식 notes/asset 표. 실행 검증 없음 |
| 2026-10-08 UTC | Magpie merged #1311 | [Qwen Code managed agent PR](https://github.com/yetone/magpie/pull/1311) | 2026-11-23 | Qwen의 JSON config에 모델 목록·auth type을 연결하고 원상 복구하는 adapter 추가. pinned `mgp:internal/agent/qwen.go:150`과 `internal/agent/agents.go:366`에 등록 확인. | roster 확대의 비용은 파일 존재 검사를 넘어 모델·auth 설정의 rollback까지 포함한다. | 높음, merged PR 및 등록 대조 |
| 2026-11-05 UTC | Magpie open #5302 | [Hook-only config detection](https://github.com/yetone/magpie/issues/5302) | 2026-11-23 | hook만 있는 설정에서 Kimi/OpenClaw가 `magpie ls`에 보였다는 사용자 보고. pin의 공통 detector가 `pathOwn` 조건하에 config 경로를 먼저 인정하는 분기는 관찰했다. `mgp:internal/agent/agent.go:466,475,478`. 두 앱에서의 재현은 확인 범위 밖이다. | 발견 단계의 confidence와 실제 연결 가능성을 구분한다. | 중간, 공개 보고와 공통 소스 경로 |
| 2026-10-12~15 | Linux.do #3012827 | [Linux.do 토론](https://linux.do/t/topic/3012827) | 2026-11-23 | cpa+cc-switch와 Claude 공식 구독, Codex relay, Pi·dsh를 함께 쓰던 사용자가 Magpie로의 이주를 검토한다고 적었다. | 설정/계정 이주의 분리와 cross-client onboarding 수요 | 낮음, 개별 사용자 보고 |
| 2026-11-23 UTC | CC Switch v4.0.40, `f19a9d4` | [CC Switch release](https://github.com/farion1231/cc-switch/releases/tag/v4.0.40) | 2026-11-23 | Grok 공식 카드의 계정 관리 및 기본 로그인 복원, 설치 감지와 버전 확인 분리, Antigravity CLI plugin 관리가 릴리스 노트에 있다. `ccs:src-tauri/src/grok_auth.rs:1,42`에서 auth 파일 대상 확인. 상태에 따른 복원 실행은 미검증. | 계정 단위의 이주와 설치 상태가 확정되기 전 관리 UI 차단을 줄이는 경쟁 사례 | 공식 발표는 높음, 사용자 환경 효과는 미측정 |

## 7. Deferred checks

- 등록 인덱스의 나머지 adapter 전체에 대해 실제 키·경로·충돌 정책을 검증하는 작업. 특히 Windows/WSL 경로 매핑, 프로필별 파일, agent binary restart, plugin이 built-in adapter를 대체하는 경우, Cline state store와 NewMax/AionUI DB migration.
- Magpie Codex history retag/mirror의 모든 조건, Codex App의 버전별 모델 picker/쿼터 전환, Claude의 force-login 및 isolated Desktop, Raycast renderer의 주석 보존 범위와 Zed의 플랫폼별 credential store.
- Relay link의 vendor별 landing 패키지와 사용자 확인, Remote Magpie 권한별 quota/usage/Library follow의 전체 표. `CAP-remote-admin-window` 동등성 및 `CAP-import-account-antigravity`의 format parity는 unknown으로 유지한다.
- 암호화 sync의 backend별 concurrent write/네트워크 단절 시 의미, backup archive 용량과 성능, Library의 native/project/WSL 동시 적용, tool/router·marketplace의 모든 subcommand, UI/tray locale 완전성.
- Release asset의 서명 실물 검증, container tag 전파 지연, installer/update/rollback 체감 시간, Docker·GUI 모드에서 웹과 gateway를 같이 열었을 때의 전 과정.

## 8. NOT RUN

- 빌드, 테스트, 서버/앱/TUI 실행, 실제 홈 설정 변경, import·sync·install·release·LAN 접속·custom protocol 실행.
- Aside에서 게시자·사용자 report의 재현과 인증된 화면, 다운로드 및 asset 실행. 두 `browse.exec` 호출 모두 codemode 외부 envelope가 `ENOMARKER / partial:[no-marker]`를 반환했다. 각 호출의 `raw.stdout` 안 native Aside `type:final` 레코드를 독립적으로 파싱해 URL별 `contentVerified:true`, 본문, 세부 페이지의 DOM 날짜를 확인했다. 바깥 envelope는 완전성 증거로 사용하지 않았다.
