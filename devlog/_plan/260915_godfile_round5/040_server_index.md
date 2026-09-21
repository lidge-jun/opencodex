# 040 — wp5: `src/server/index.ts` 분해 계약서

대상 파일은 이 워크트리 HEAD 기준 3,400줄이다(`wc -l` 실측). 측정 도구는 `wc`, `awk`, `rg`, `sed`뿐이다. 워크트리에 `node_modules`가 없어 bun 계열 명령은 실행하지 않았고, 본 문서의 모든 줄 수·개수는 실행한 명령 출력에서 왔다. 추측·기억·반올림으로 쓴 숫자는 없고, 확인하지 못한 항목은 "미측정"으로 표기했다.

블록의 "끝"은 별도 언급이 없는 한 다음 최상위 문장 시작 줄 − 1이며 빈 줄과 주석을 포함한다. 마지막 블록은 파일 끝(3,400)까지다. 이 규칙 아래 모든 블록 줄수의 합은 3,400과 정확히 일치한다(1절 검산). 순수 이동 시 블록 끝의 빈 줄이 함께 옮겨져도 파사드 합산은 이 규칙으로 보정된다.

## 1. 최상위 심볼 인벤토리

헤더 1-266은 import 문과 재-export 문이 섞인 구간이다. `awk`가 잡은 최상위 `export` 문은 92-96(routing), 101(gui-static), 102(adapter-resolve), 116, 139, 159, 188, 198(responses)로 8개이고, 나머지는 import 문이다. 92-101 구간 실측: 92-96 export 블록, 97-100 import 4개, 101 export 1개. 199-265은 import 37개, 266은 빈 줄이다.

| 심볼 | 시작 | 끝 | 줄수 | export |
|---|---|---|---|---|
| (헤더: import·재-export 혼재) | 1 | 266 | 266 | 재-export 8개 |
| MAX_WS_FRAME_BYTES | 267 | 267 | 1 | O |
| WEBSOCKET_IDLE_TIMEOUT_SECONDS | 268 | 271 | 4 | X |
| REMOTE_CATALOG_KEY_ID_PATTERN | 272 | 272 | 1 | X |
| GUI_PAIRING_EXCHANGE_BODY_LIMIT | 273 | 273 | 1 | X |
| REMOTE_WORKSPACE_PAIRING_BODY_LIMIT | 274 | 286 | 13 | X |
| readBoundedRequestText | 287 | 327 | 41 | X |
| withRemoteCatalogKeyId | 328 | 337 | 10 | X |
| LIVE_SIDEBAND_PENDING_MAX | 338 | 338 | 1 | X |
| LIVE_SIDEBAND_PENDING_BYTES_MAX | 339 | 339 | 1 | X |
| LIVE_SIDEBAND_CLOSE_FALLBACK_MS | 340 | 344 | 5 | X |
| LIVE_SIDEBAND_UPSTREAM_OPEN_TIMEOUT_MS | 345 | 355 | 11 | O |
| LiveSidebandUpstreamOpenResult | 356 | 364 | 9 | O(type) |
| exceedsLiveSidebandFrameByteLimit | 365 | 368 | 4 | O |
| exceedsLiveSidebandPendingByteLimit | 369 | 372 | 4 | O |
| webSocketFrameBytes | 373 | 378 | 6 | X |
| LiveSidebandPendingEnqueueResult | 379 | 380 | 2 | O(type) |
| enqueueLiveSidebandPendingFrame | 381 | 394 | 14 | O |
| LiveSidebandWebSocketFactory | 395 | 400 | 6 | X(type) |
| releaseLiveSidebandAdmission | 401 | 413 | 13 | X |
| sendUpstreamFrame | 414 | 421 | 8 | X |
| finalizeLiveSideband | 422 | 448 | 27 | X |
| armLiveSidebandCloseFallback | 449 | 475 | 27 | X |
| closeLiveSidebandBeforeUpgrade | 476 | 517 | 42 | X |
| closeLiveSideband | 518 | 563 | 46 | X |
| openLiveSidebandUpstream | 564 | 711 | 148 | O |
| attachLiveSidebandUpstream | 712 | 889 | 178 | O |
| REQUEST_LOG_ID_RESPONSE_HEADER | 890 | 891 | 2 | X |
| withRequestLogId | 892 | 920 | 29 | X |
| StartServerDeps | 921 | 943 | 23 | O(interface) |
| inspectStartupOwnership | 944 | 980 | 37 | X |
| startupCacheInvalidationWrote | 981 | 983 | 3 | X |
| consumeStartupCacheInvalidationWrite | 984 | 989 | 6 | O |
| warnAgentTaskRecoveryStartup | 990 | 998 | 9 | O |
| warnPlaintextV2AgentMessagesStartup | 999 | 1005 | 7 | O |
| startServer | 1006 | 3400 | 2395 | O |

검산: 266 + (1+4+1+1+13+41+10+1+1+5+11+9+4+4+6+2+14+6+13+8+27+27+42+46+148+178+2+29+23+37+3+6+9+7+2395) = 266 + 3134 = 3,400.

export 문은 22개다: 92, 101, 102, 116, 139, 159, 188, 198, 267, 345, 356, 365, 369, 379, 381, 564, 712, 921, 984, 990, 999, 1006. 앵커와 일치한다. 분해 후에도 이 22개 이름이 파사드에서 같은 의미로 보여야 하고, 이름 추가·삭제·변경은 없다.

## 2. 산술 — startServer 내부를 잘라야 한다

startServer는 1006-3400, 2,395줄이다. 함수 밖은 1-1005, 1,005줄이다.

함수 밖을 전부 옮겨도 파사드는 헤더 266줄(startServer가 그 import를 그대로 쓴다)에 startServer 2,395줄을 더한 2,661줄이 된다. 옮긴 export의 재-export 대체 라인이 몇 줄 더 붙는다.

2,661 > 1,900이라 목표 도달이 불가능하다. startServer 본문 1006-3400에서 블록을 뽑는 것이 필수다.

## 3. startServer 내부 구조 (1006-3400)

### 3.1 앵커와 동기 창

측정된 앵커 세 개: Bun.serve 호출 3222(`server = Bun.serve<WsData>({ ...serveOptions, port: listenPort, hostname: bindHost });`), lab 체크 3386(`if (labActivationRequired(config, labConfigDir)) {`, 준비 3385, 호출 3387), `return server;` 3399.

동기 창은 3222-3399(178줄)이고 창 밖 준비부는 1006-3221(2,216줄)이다. 창 안에는 server.stop 롤백 클로저(3241)와 보조 바인드(3230, 3250), nativeStop 결선(3274), 포트 로그(3318), lab 활성화(3385-3388), reset-credit 활성화(3391-3395)가 있다.

### 3.2 serveOptions 해부

`serveOptions` 리터럴은 1481-3220(1,740줄)이다. 구성은 키 2개와 주석 1483-1485(3줄), fetch 핸들러 1487-2975(1,489줄), websocket 핸들러 2976-3219(244줄)다. fetch 본문은 파일에서 가장 큰 단일 블록이다.

### 3.3 판정 — fetch는 최대 블록이지만 순수 이동 대상이 아니다

근거는 라이브 바인딩 네 곳이다. `boundPort`(let, 1343 선언, 3319 배정)를 1543, 1782, 1801에서 읽고 `server`(let, 1426 선언, 3222 배정)를 1740에서 읽는다. serveOptions는 3222보다 앞서 만들어지므로 빌드 시점에 두 let은 아직 배정 전이고, 값을 파라미터로 넘기면 undefined가 고정된다.

1740의 `server.port`는 /healthz 응답용이다. /healthz는 보조 리스너에서 차단된다(loopbackRouteAllowed 1191-1223에 /healthz가 없고, managementIngressRouteAllowed는 1246-1250에서 명시 거부). 그래서 `requestServer.port` 1줄 대체는 도달 경로가 동일하다. boundPort 세 곳은 게터 접근으로만 동일 의미가 유지된다. 네 줄 모두 본문 수정이므로 순수 이동 원칙의 예외가 필요하고, 승인은 부모의 몫이다.

`server`의 나머지 7건 일치는 주석(1722, 1725, 1857, 1954, 2253)과 "server busy" 문자열(2999, 3006)이다(rg -w 실측). websocket 블록 2976-3219의 `server` 일치 2건도 문자열이다.

"라우트 핸들러 본문은 fetch 콜백 안이라 동기 보장 대상이 아니다"는 관찰은 맞다(중첩 함수 무시 규칙, tests/lab/core-lab-boundary.test.ts:396-419 실측). 그러나 그것이 안전하게 뽑아낼 수 있는 가장 큰 덩어리라는 뜻은 아니다. 라이브 바인딩 네 곳과 7절의 텍스트 오라클 네 종이 fetch·websocket 본문을 붙들고 있다.

### 3.4 창 밖에서 순수 이동 가능한 최대 블록

1191-1330(140줄)다. 여섯 함수가 있다: loopbackRouteAllowed 1191-1223, managementIngressRouteAllowed 1231-1253, drainingResponse 1262-1270, serverBusyResponse 1272-1279, packageTreeChangedResponse 1281-1288, runAdmittedHttpTurn 1290-1330.

이들이 startServer 지역을 붙잡는 곳은 managementIngressRouteAllowed의 `config`(1234, 1236) 하나뿐이다. 나머지 자유 식별자는 전부 import 공급이다.

1331-1480은 이동 불가 상태다: readinessGate(1337), packageTreeIntegrity(1338), boundPort(1343), nativeOwnership(1351), preparedNativeMainLifecycle(1357), retry 변수군(1364-1366), reprobeNativeOwnership(1367), ownershipRetryOptions(1393), nativeMainLifecycle(1403), server 계열 let(1426-1428), inboundBodyLimitBytes(1434), ingressForServer(1447), backgroundLifecycle(1452), managementApiDeps(1456), loadRemoteWorkspaceRuntime(1462-1471)이 서로를 참조하는 클로저 상태다.

## 4. 리프 배치 — 순수 이동분

| 리프 | 원본 범위 | 줄수 | 파사드 잔류물 |
|---|---|---|---|
| src/server/index/bounded-request.ts | 272-337 | 66 | `import { GUI_PAIRING_EXCHANGE_BODY_LIMIT, REMOTE_WORKSPACE_PAIRING_BODY_LIMIT, readBoundedRequestText, withRemoteCatalogKeyId } from "./index/bounded-request"` — 사용처 1621, 1624, 1908, 2918, 2921 |
| src/server/index/live-sideband.ts | 338-889 | 552 | `export { LIVE_SIDEBAND_UPSTREAM_OPEN_TIMEOUT_MS, type LiveSidebandUpstreamOpenResult, exceedsLiveSidebandFrameByteLimit, exceedsLiveSidebandPendingByteLimit, type LiveSidebandPendingEnqueueResult, enqueueLiveSidebandPendingFrame, openLiveSidebandUpstream, attachLiveSidebandUpstream } from "./index/live-sideband"` — 이름 8개, 표면 동일 |
| src/server/index/startup-warnings.ts | 890-1005 | 116 | `import { withRequestLogId, inspectStartupOwnership }`(사용처 2585, 1062, 1351, 1383) + `export { type StartServerDeps, consumeStartupCacheInvalidationWrite, warnAgentTaskRecoveryStartup, warnPlaintextV2AgentMessagesStartup } from "./index/startup-warnings"` |
| src/server/index/route-guards.ts | 1191-1330 | 140 | `export function createRouteGuards(config: RequestPolicyView) { /* 1191-1330 원본 그대로 */ return { loopbackRouteAllowed, managementIngressRouteAllowed, drainingResponse, serverBusyResponse, packageTreeChangedResponse, runAdmittedHttpTurn }; }` — 파사드는 원래 1191 위치에서 구조 분해 1줄 |

리프 의존 방향은 파사드 → 네 리프, startup-warnings → live-sideband(타입 1개)뿐이다. route-guards와 bounded-request는 리프 간 의존이 없다. 순환 import는 만들지 않는다.

### 4.1 import 지정자 재작성 규칙

리프는 `src/server/index/` 한 단계 아래다. `./x`는 `../x`로, `../x`는 `../../x`로, `../../x`는 `../../../x`로 바꾼다. 라운드 2의 결함(`../config`가 없는 `src/codex/config`를 가리켜 샤드 전체가 import 단계에서 사망)이 정확히 이 규칙 위반이었다.

실측 예시: 17행 `from "./ws-bridge"` → `from "../ws-bridge"`(WsData, LiveSidebandUpstreamFailure, LiveSidebandUpstreamHandoff), 27행 `from "../config"` → `from "../../config"`, 1행 `from "../remote-control/workspace-activation"` → `from "../../remote-control/workspace-activation"`.

### 4.2 리프별 공급 식별자

- live-sideband 리프: WsData·LiveSidebandUpstreamFailure·LiveSidebandUpstreamHandoff(`../ws-bridge`), Server·ServerWebSocket(18행, bun).
- startup-warnings 리프: StartServerDeps가 참조하는 LiveSidebandWebSocketFactory를 `"./live-sideband"`에서 가져온다(공급 395-400). currentServiceHomes·inspectNativeCodexOwnership·OwnershipInspection·createWindowsTaskListingCache는 36행·40-44행 공급 모듈을 ../..로 가져온다.
- route-guards 리프: contextEndpoint(225행 공급), remoteWorkspaceEnabled(1행)은 측정됐다. RequestPolicyView와 tryAdmitTurn·sessionLaneIdFromRequest·admitWorkflowTurn·workflowRefusalResponse·withCors·formatErrorResponse·corsHeaders·serveGuiFile의 공급 모듈은 미측정이다 — 원본 1-265 import 블록에서 같은 식별자를 찾아 ../.. 규칙을 적용한다.
- bounded-request 리프: DataPlaneAdmission 타입의 공급 모듈은 미측정이다 — 같은 규칙을 적용한다. Request는 전역 타입이다.

### 4.3 동적 import

이동 범위 272-1330에는 `import(`가 없다. 파일 전체 동적 import는 19곳이다: 1461, 1463(startServer 준비부), 1590-2465(fetch 본문 15곳), 3364, 3371(창). 전부 이동 범위 밖이다.

## 5. 파사드 목표 검산

- 순수 이동만(리프 4개): 3,400 − (66+552+116+140) = 2,526, 리프 import·재-export 추가 약 8줄 → 약 2,534. 목표 1,900 미달, 차이 약 634.
- route-guards를 뺀 세 리프만(테스트 무수정): 3,400 − 734 = 2,666 + 약 6 → 약 2,672.
- startServer 안에 순수 이동 가능한 나머지는 없다(1331-1480은 상태 클로저, 3222-3399는 창).

1,900의 유일한 지렛대는 serveOptions 리프다. 1543·1782·1801·1740 네 줄 본문 수정을 승인하면 2,526 − 1,740 = 786에 buildServeOptions import 1줄과 호출부(deps 객체 — 측정된 캡처 21개에 게터 2개, 예상 약 26줄)를 더해 약 813이 된다. 이때 리프 합계는 66+552+116+140+1,740 = 2,614이다.

serveOptions 캡처 21개(`uniq -c` 실측): config, drainingResponse, runAdmittedHttpTurn, managementAuth, listenPort, remoteWorkspaceStopping, boundPort(라이브), serverBusyResponse, loopbackPolicy, localAttestationSecret, loadRemoteWorkspaceRuntime, liveCallBindings, readinessGate, packageTreeIntegrity, packageTreeChangedResponse, managementSessionControl, managementIngressRouteAllowed, managementApiDeps, loopbackRouteAllowed, ingressForServer, inboundBodyLimitBytes. 라이브 바인딩은 boundPort와 server(1740) 둘뿐이다. websocket 블록 단독 캡처는 config뿐이다(2976-3219 스캔 실측).

## 6. 동기 보장 제약

창 3222-3399의 코드는 리프로 옮기지 않는다. 테스트가 파사드 텍스트에서 앵커 세 개를 찾고(SERVE·ACTIVATION·RETURN 문자열, tests/lab/core-lab-boundary.test.ts:139-150 정의 실측), 본문 레벨 await을 금지한다(같은 파일 369-389 실측). 중첩 함수의 await은 무시된다(396-419 실측).

lab 코드 — import 67행, 주석 3377-3384, 활성화 3385-3388 — 는 컴포지션 루트 의무라 파사드에 남는다. 파일 안 lab 토큰은 이 네 곳이 전부다(rg 'lab' 실측, 나머지 일치는 available 등 부분 문자열). 이동 범위 272-1330에 lab 참조가 없으므로 어떤 리프도 lab importer가 되지 않고, tests/lab/core-lab-boundary.test.ts 그래프는 불변이다.

네 리프 모두 startServer 본문 레벨에서는 await 없이 한 번 호출된다. bounded-request·live-sideband·startup-warnings는 기존 호출 지점이 유지되고, route-guards는 1191 위치의 구조 분해 1줄이다. 리프 함수를 async로 바꾸거나 본문에 await을 추가하는 것을 금한다. runAdmittedHttpTurn은 이미 async이지만 호출이 전부 fetch 콜백 안이라(2415, 2451, 2507, 2533, 2568, 2605, 2635, 2665, 2683, 2715) 창 대상이 아니다.

World B의 serveOptions 리프: buildServeOptions 호출은 1481 위치에서 동기 1회다. fetch·websocket은 중첩 함수라 창 스캔 제외 대상이고, 이동 후에도 파사드 창 텍스트 3222-3399는 변하지 않는다.

## 7. 동반 수정 (World A 기준)

| 파일:줄 | 검사 내용 | 조치 |
|---|---|---|
| tests/server/loopback-listener-admission.test.ts:92-100 | 허용 목록 2문자열(원본 1197, 1198) | 읽기 경로를 src/server/index/route-guards.ts로 |
| tests/server/loopback-listener-admission.test.ts:110-117 | `indexOf("function loopbackRouteAllowed(")` 앵커 2개 | 같은 리프 읽기로 |
| tests/codex-integration/model-visibility-management-api.test.ts:72-77 | `"Retry-After": "1"`(원본 1277) | 검사 대상 소스에 리프 추가 |
| tests/fixtures/file-size-baseline.json:27 | 3400 | 이동 후 실측값으로 갱신 — SHRANK는 offender가 아니다(scripts/file-size-ratchet.ts:87, 92-93 실측) |
| structure/manifest.json, structure/runtime.md | 신규 src/server/index/ 영역 | 소유자 등록 — AGENTS.md 규칙상 미소유 신규 src/ 영역에서 structure:check 실패 |

무수정 근거. tests/server/server-live.test.ts:18-23과 tests/server/agent-task-recovery.test.ts:4는 런타임 import라 재-export가 표면을 유지한다. tests/codex-integration/codex-retained-root-serialization.test.ts:267은 런타임 import고, 295-299는 `const startupCodexHome`(1074)·`armClaudeCodeBaseline`(1090)을 읽는데 둘 다 파사드에 남는다.

tests/windows/windows-deploy-close-regressions.test.ts:81-89는 1115-1116과 3222를 검사하고 둘 다 잔류한다. tests/codex-integration/compatibility-manifest.test.ts:184는 import 그래프 검사로 이동이 새 의존을 만들지 않는다. tests/usage/quota-reset-core-boundary.test.ts:74-82는 66행의 background-lifecycle 직접 import를 전제하므로 유지한다. tests/lab/core-lab-boundary.test.ts는 앵커 잔류로 무수정이다. 구조 문서 7곳(structure/runtime.md:18·27·367, remote-workspace.md:19, data-planes/inbound-compat.md:30, clients/claude-desktop.md:28, gui-and-management-api.md:106)의 `src/server/index.ts` 이름 참조는 파사드가 남으므로 경로 유효성 검사를 통과한다.

World B(serveOptions 리프) 승인 시 추가 재지정: tests/responses/ws-endpoint.test.ts:40-46(websocket 키와 finalizeLog 2문자열), tests/lib/workflow-budget.test.ts:474-482(`return runAdmittedHttpTurn(` 개수와 `withCors(workflowRefusalResponse(`), loopback-listener-admission:63-89·122-130(라우트 마커), model-visibility:74-75(CatalogGatherBusyError·"catalog_busy" — 원본 2030-2031, 98행 import는 fetch 이동 후 미사용이라 삭제).

fetch 본문의 동적 import 15곳(1590-2465)은 World B에서 지정자를 한 단계 내린다. 예: 1851 `import("./catalog-download")` → `import("../catalog-download")`, 1969 `import("../remote/hub-state")` → `import("../../remote/hub-state")`.

## 8. 검증 순서 (구현자용)

- live-sideband 이동 직후: bun test tests/server/server-live.test.ts — 재-export 표면 검증.
- startup-warnings 이동 직후: bun test tests/server/agent-task-recovery.test.ts.
- route-guards 이동·재지정 직후: bun test tests/server/loopback-listener-admission.test.ts tests/codex-integration/model-visibility-management-api.test.ts.
- 전체 완료 후: bun run typecheck, bun run test:changed, bun run structure:check, bun run privacy:scan. PR-ready 전에는 AGENTS.md 게이트대로 bun run typecheck과 bun run test를 실행한다.
- file-size-baseline.json은 마지막 리프 이동 후 실측값으로 한 번만 갱신한다.

## 9. 측정 명령 목록

```
wc -l src/server/index.ts
awk '/^(export |async |function |const |let |var |class |interface |type |enum )/ {print NR": "$0}' src/server/index.ts
awk 'NR<=91 && /from / {print NR": "$0}' src/server/index.ts
awk 'NR>=1006 && /^  (const|let|async function|function|type|interface)/ {print NR": "$0}' src/server/index.ts
rg -n 'Bun\.serve|labActivationRequired|return server|fetch:|websocket:' src/server/index.ts
rg -n 'serveOptions|server\.stop|loopbackServer|managementIngressServer' src/server/index.ts
rg -n 'as const' src/server/index.ts
rg -n 'boundPort' src/server/index.ts
rg -n 'import\(' src/server/index.ts
rg -n 'GUI_PAIRING_EXCHANGE_BODY_LIMIT|REMOTE_WORKSPACE_PAIRING_BODY_LIMIT|REMOTE_CATALOG_KEY_ID_PATTERN|REQUEST_LOG_ID_RESPONSE_HEADER|withRequestLogId|withRemoteCatalogKeyId|MAX_WS_FRAME_BYTES|WEBSOCKET_IDLE_TIMEOUT_SECONDS|CatalogGatherBusyError|"catalog_busy"|const startupCodexHome|armClaudeCodeBaseline\(' src/server/index.ts tests/
rg -n 'openLiveSidebandUpstream|attachLiveSidebandUpstream|enqueueLiveSidebandPendingFrame|exceedsLiveSideband|consumeStartupCacheInvalidationWrite|warnAgentTaskRecoveryStartup|warnPlaintextV2AgentMessagesStartup|StartServerDeps' tests/
rg -n 'ANCHOR =|bodyLevelAwaitLines' tests/lab/core-lab-boundary.test.ts
rg -n 'SHRANK|NEW_OK|OVERSIZED|isOffender' scripts/file-size-ratchet.ts
rg -n 'server/index' tests/ structure/
sed -n '<구간>p' src/server/index.ts   # 1-91, 92-101, 199-266, 267-296, 338-356, 921-1006, 1191-1340, 1325-1346, 1462-1492, 1730-1745, 2958-2980, 3200-3262, 3216-3223, 3370-3400
sed -n '1481,3220p' src/server/index.ts | rg -o -w '<startServer 지역변수 54종>' | sort | uniq -c   # serveOptions 캡처
sed -n '2976,3219p' src/server/index.ts | rg -o -w '<동일 목록>' | sort | uniq -c                   # websocket 캡처
sed -n '1481,3220p' src/server/index.ts | rg -n -w 'server'                                          # 라이브 바인딩 위치
ls src/server/ ; ls -la devlog/_plan/260915_godfile_round5/
```
