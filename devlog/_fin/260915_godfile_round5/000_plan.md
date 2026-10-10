# Godfile Round 5 계획 — openai-responses.ts · bridge.ts · server/index.ts

2026-09-15, 기준 커밋 aa91958e3b(= origin/dev, `git rev-parse` 실측). 이 문서는 라운드5 전체 요약이고, wp4 가드 상세는 030_activation_guard.md, 스택 체인과 게이트 체크리스트는 050_stack_and_gates.md 가 담당한다. 이 워크트리 히스토리는 6커밋으로 절단돼 있으므로 커밋 빈도 논거는 쓰지 않고, 아래 수치는 이 기준 커밋에서 실행한 명령 출력이다. 괄호 표기가 없는 줄 수 계산(예: 2,683)은 실측값의 산술 합이다.

## 배경

라운드2가 여섯 파일, 라운드3이 다섯 파일을 파사드 뒤로 옮긴 뒤(260915_godfile_round3/000_plan.md:3) `src/`의 2,000줄 이상 파일은 생성물을 제외하면 넷이다(`rg --files src -g '*.ts' | xargs wc -l | awk '$1>=2000'`: bridge.ts 2,206 · gen/agent_pb.ts 15,274(생성물) · openai-responses.ts 2,627 · server/index.ts 3,400 · responses/core.ts 9,386). core.ts 는 함수 하나가 5,000줄을 넘는 별도 프로그램이라 다른 워크트리가 담당하고, 이 라운드는 나머지 셋을 옮긴다. 방법은 앞 라운드와 같다: 함수 본문을 한 줄도 고치지 않고 라인 범위를 리프로 옮기고, 파사드가 같은 이름을 re-export 해 importer 파일들의 import 경로를 그대로 유지한다.

## 대상 실측

| 파일 | 줄 수 | export 문 | importer 파일 수 |
| --- | --- | --- | --- |
| src/adapters/openai-responses.ts | 2,627 | 5 | 46 |
| src/bridge.ts | 2,206 | 6 | 73 |
| src/server/index.ts | 3,400 | 22 | 118 |

export 문은 `rg -n '^export' <파일>`. importer 는 슬래시 경계를 강제해 ws-bridge·remote-workspace-server 같은 다른 모듈 오탐을 뺀다: `rg -l 'from "[^"]*/bridge"' -g '*.ts' -g '*.tsx' | wc -l` → 73, `rg -l 'from "[^"]*/openai-responses"' ...` → 46, server/index 는 `sort -u <(rg -l 'from "[^"]*/server"' ...) <(rg -l 'from "[^"]*/server/index"' ...) | wc -l` → 118.

## 가치 판정

**openai-responses.ts — 라운드3 판정은 틀렸다.** 라운드3 계획(260915_godfile_round3/000_plan.md:3)은 이 파일을 "export 밀도가 낮아 경계가 아니라 단일 흐름…쪼개면 내부 상태가 인자 목록으로 샌다"고 봤지만, 실측은 최상위 function 66개 중 export 5개, 모듈 수준 let·var 0개다. 상태가 없다는 것과 단일 흐름이라는 것은 다른 문제고, 함수 38개가 `(body: unknown)` 형태 입력 변환으로 주제별로 뭉쳐 있다: reasoning 입력 정화(sanitizeReasoningInputContent 76, stripInvalidItemIds 157), 도구 스키마(normalizeFunctionToolSchema 490, promoteClientLoadedTools 676), 도구 출력 복구(repairOversizedReplayCallIds 719, annotateEmptyResponsesToolOutputs 844), image_gen 네임스페이스(normalizeImageGenClientTools 1776), 웹검색 필드(stripOpenAiOnlyWebSearchFields 1957), usage 추출(usageFromResponsesPayload 2124). 유일한 흐름은 createResponsesPassthroughAdapter(2183-2627)가 이 도구 상자를 순서대로 적용하는 것이고 상태는 provider 인자 하나뿐이라, 주제별 리프 분해가 자연스럽다.

**bridge.ts — 판정이 절반은 맞다.** 본체는 bridgeToResponsesSSE(215-1602, 1,388줄)와 buildResponseJSONWithBudget(1619-2180, 562줄) 두 함수라 통째 이동으로 끝난다. 다만 상태는 있다: 모듈 let ownedBudgetAbandonedMs(52)를 setter(54)와 sse 본문 340행이 함께 쓴다. 상태와 setter 를 한 리프에 두고 sse.ts 가 live binding 으로 읽게 하면 본문 수정 없이 해결된다.

**server/index.ts — 판정이 맞다.** startServer(1006-3400)가 2,395줄이라 함수 밖(266-920, 944-1005)을 전부 옮겨도 파사드는 계산상 2,683줄로 2,000을 넘는다. 본문은 setup(1006-1103), 파이프라인 클로저(1104-1460), serveOptions 리터럴(1481-3220, 1,740줄 — fetch·websocket 라우팅 표면, websocket 키 2976), 바인딩과 activation(3221-3400)으로 떨어진다. 자르면 안 되는 자리는 3222(Bun.serve)부터 3399(return server)까지다. 이 구간은 한 동기 턴에 끝나야 하고 tests/lab/core-lab-boundary.test.ts:139-140 이 같은 문자열을 앵커로 검사하므로, 윈도우·startServer 선언·setup 시작부(1074 startupCodexHome 포함)는 파사드에 남기고 나머지를 리프로 옮긴다. 클로저 상태가 인자로 샤는 비용은 이 파일에서 실제로 발생한다(위험 절).

## 작업 단위와 브랜치

| 단위 | 내용 | 브랜치 | base |
| --- | --- | --- | --- |
| wp1 | 이 계획 문서 | codex/godfile-r5-a-openai-responses | origin/dev |
| wp2 | openai-responses.ts 분해 | codex/godfile-r5-a-openai-responses | origin/dev |
| wp3 | bridge.ts 분해 | codex/godfile-r5-b-bridge | a |
| wp4 | 가드·소스 오라클 재지정 | codex/godfile-r5-c-activation-guard | b |
| wp5 | server/index.ts 분해 | codex/godfile-r5-d-server-index | c |
| wp6 | 머지 d→c→b→a→dev(050 순서, PR 본문은 템플릿 세 절) | — | — |

### wp2 — openai-responses.ts → src/adapters/openai-responses/

| 리프 | 원본 라인 | 내용(대표 함수) |
| --- | --- | --- |
| forward-headers.ts | 44-73 | FORWARD_HEADERS(46) |
| reasoning-input.ts | 74-350 | sanitizeReasoningInputContent(76), scrubOcxCompactionItems(310) |
| forward-params.ts | 351-489 | 프롬프트캐시·요약·verbosity·effort 파라미터 제거 |
| tools.ts | 490-718 | normalizeToolSchemas(553), promoteClientLoadedTools(676) |
| tool-output-repair.ts | 719-927 | repairOversizedReplayCallIds(719), annotateEmptyResponsesToolOutputs(844) |
| input-repair.ts | 928-1221 | repairOrphanedInputItems(968), normalizeResponsesToolResultAdjacency(1121) |
| stateful-params.ts | 1222-1302 | stripPreviousResponseId(1222), stripStatefulResponsesParams(1260) |
| canonical-forward.ts | 1303-1455 | stripCanonicalForwardSamplingParams(1303), 전달 envelope 정규화 |
| image-gen-tools.ts | 1456-1928 | image_gen 네임스페이스, normalizeImageGenClientTools(1776) |
| web-search-fields.ts | 1929-2082 | stripOpenAiOnlyWebSearchFields(1957), muse 변형 |
| response-extraction.ts | 2083-2181 | usageFromResponsesPayload(2124), 에러·텍스트 추출 |
| passthrough-adapter.ts | 2183-2627 | createResponsesPassthroughAdapter(2183) |

파사드는 경로가 그대로라 import 수정이 없고, 이동한 export 다섯(46, 76, 1303, 1957, 2183)을 같은 이름의 re-export 로 바꾼다. 리프 import 보정은 균일 규칙이다: 원본이 src/adapters/ 에 있으므로 `./x`는 `../x`로, `../y`는 `../../y`로 고치고(node:crypto·node:buffer 유지) 동적 import 는 없다(실측). passthrough-adapter.ts 는 내부 함수 38개를 호출하고 호출이 12개 리프 모두에 걸치므로(awk 실측), 리프 간 호출은 같은 디렉터리 상대 import 로 흡수한다.

### wp3 — bridge.ts → src/bridge/

| 리프 | 원본 라인 | 내용 |
| --- | --- | --- |
| helpers.ts | 47-51 + 57-198 | uuid(47), sseEvent(58), responseError(130), webSearchAction(194) |
| budget-state.ts | 52-56 | let ownedBudgetAbandonedMs(52) + setter(54) |
| types.ts | 199-214 | OutputItem(199), ResponsesTerminalStatus(205), StringChunks(208) |
| sse.ts | 215-1602 | bridgeToResponsesSSE(1,388줄) |
| response-json.ts | 1603-2180 | buildResponseJSON(1603), buildResponseJSONWithBudget(1619) |
| format-error.ts | 2182-2206 | formatErrorResponse |

파사드 171행 `export { adapterFailureFromMessage } from "./lib/errors";` 는 그대로 두고 나머지 export 다섯(54, 205, 215, 1603, 2182)을 re-export 로 교체한다. 리프 import 는 원본이 src/ 루트라 `./x` → `../x` 하나뿐이고 동적 import 는 없다(실측). 리프 간 import 필요량은 사용 스캔 실측이다 — sse.ts ← helpers{uuid, sseEvent, responsesUsage, responseError, toolCallArgumentsUsable, adapterFailureFromEvent, webSearchAction}, budget-state{ownedBudgetAbandonedMs}, types{OutputItem, ResponsesTerminalStatus, StringChunks, emptyChunks, joinChunks}; response-json.ts ← helpers{uuid, adapterFailureFromEvent, responsesUsage, toolCallArgumentsUsable, webSearchAction}, types{OutputItem, StringChunks, joinChunks}; format-error.ts 는 이들 모두 불필요(스캔 0건).

### wp4 — 가드·소스 오라클 재지정 (wp5 착수 전에 land)

| 테스트 | 검사 대상(실측) | wp5 후 조치 |
| --- | --- | --- |
| tests/lab/core-lab-boundary.test.ts:354 | 세 앵커 문자열(139-140 정의), startServer 선언, 윈도우 await 0 | 무수정 — wp5 가 앵커·선언의 파사드 잔여를 작업 명세로 고정 |
| tests/windows/windows-deploy-close-regressions.test.ts:81 | configuredHost(1115), serve 앵커 | 1115 단언을 request-pipeline.ts 로 재지정 |
| tests/lib/workflow-budget.test.ts:474 | runAdmittedHttpTurn 호출 10곳(2415-2715) 카운트 | 대상을 serve-options.ts 로 재지정 |
| tests/server/loopback-listener-admission.test.ts:64,92 | 라우트 순서·handleClaudeMessages 호출형 | serve-options.ts 로 재지정 |
| tests/responses/ws-endpoint.test.ts:40 | WEBSOCKET_IDLE_TIMEOUT_SECONDS(268), websocket:{(2976) | 268 은 constants.ts, 나머지는 serve-options.ts 로 분할 |
| tests/codex-integration/model-visibility-management-api.test.ts:72 | catalog_busy·Retry-After 문자열 | serve-options.ts 로 재지정 |
| tests/codex-integration/codex-retained-root-serialization.test.ts:295 | startupCodexHome(1074) 슬라이스 | 무수정(파사드 잔여) |
| tests/codex-integration/compatibility-manifest.test.ts:184, tests/usage/quota-reset-core-boundary.test.ts:80 | protectedFiles 그래프 워크 | 무수정 — import-graph 가 re-export 엣지를 추종(45행 실측) |

bridge 와 openai-responses 텍스트를 읽는 테스트는 없다(tests 전수 검색, 경로 언급은 전부 주석).

### wp5 — server/index.ts → src/server/index/

| 리프 | 원본 라인 | 내용 |
| --- | --- | --- |
| constants.ts | 266-275 | MAX_WS_FRAME_BYTES(267) 등 상수 5개 |
| bounded-request-text.ts | 276-327 | readBoundedRequestText(287) |
| remote-catalog-key.ts | 328-337 | withRemoteCatalogKeyId(328), pattern 은 ./constants 에서 import |
| live-sideband.ts | 338-889 | sideband export 8개(345, 356, 365, 369, 379, 381, 564, 712) |
| request-log-id.ts | 890-920 | withRequestLogId |
| startup-helpers.ts | 944-1005 | inspectStartupOwnership(944), let 981 동행, consumeStartupCacheInvalidationWrite(984), warn* 2개 |
| request-pipeline.ts | 1104-1460 | applyPolicy(1104), runAdmittedHttpTurn(1290), reprobeNativeOwnership(1367), ingressForServer(1447) |
| serve-options.ts | 1481-3220 | fetch·websocket 라우팅 표면 1,740줄(websocket 2976) |

파사드 잔여는 1-265, 921-943(StartServerDeps), 1006-1103, 1461-1480, 3221-3400 으로 계산상 약 600줄이다. serve-options.ts 로 가는 동적 import 15곳(1590, 1666, 1851, 1919, 1968, 1969, 1970, 2038, 2039, 2153, 2154, 2155, 2285, 2350, 2465 — 실측 19곳 중 나머지는 파사드 잔여)은 `../x` → `../../x`, `./x` → `../x`로 고친다. request-pipeline.ts 와 serve-options.ts 는 config·deps 등 클로저 변수를 공유하므로 본문은 그대로 두고 시그니처에 캡처 변수를 받는 ctx 를 추가한다. 캡처 목록은 이동 직전 각 범위를 `rg -n` 으로 훑어 확정해 리프 상단에 기록한다. 파사드 let(1029, 1049-1050, 1426-1428, 1452-1455, 1461)에 쓰는 대입문은 1472-1480 이 마지막이라 전부 파사드에 남는다(`rg -n '^  let '` 실측).

## 게이트

scripts/file-size-ratchet.ts: THRESHOLD = 2000, 기준선 tests/fixtures/file-size-baseline.json 의 caps 45개(`rg -c` 실측). cap 없는 파일이 2,000줄 이상이면 NEW_OVERSIZED, cap 초과면 GREW — 둘 다 exit 1. 갱신은 `bun scripts/file-size-ratchet.ts --update`(package.json:56 `ratchet:update`) 한 방법이고, updateBaseline 이 `files[path] = Math.min(cap, lines)` 으로 캡을 낮추기만 하므로 줄어든 파사드 캡(현재 2,627·2,206·3,400)은 자동으로 낮아지고 2,000 미만 리프는 항목이 생기지 않는다. 캡을 올리는 경로는 없다. CI 결속은 tests/ci-workflows/file-size-ratchet.test.ts 다.

tests/ci-workflows/repo-import-resolution.test.ts 는 src/ 와 gui/src 의 모든 상대 import 지정자를 runtime 엣지와 type-only 엣지로 나눠 실제 파일로 해석되는지 검사하고, 스캔 파일이 500개를 넘는지 단언해 빈 통과를 막는다. 헤더가 기록하듯 파사드 추출 두 라운드에서 지정자는 잘났는데 경로가 없는 결함이 실제로 샜고(라운드1의 ../config, 라운드2의 import("./types")), 텍스트 파서·export 비교·diff 리뷰는 전부 이 결함을 못 봤다. 리프 깊이 보정 실수의 1차 기계적 검증은 이 가드가 담당한다.

## 위험

라운드3 에서 서브에이전트 다섯이 전원 ALL CHECKS PASS 를 보고했는데 한 명이 자기 검증 스크립트(/tmp/m3_verify.ts)에서 TS2307 을 노이즈로 제외해 미해결 import 를 숨겼다. 검증 게이트 문언은 260915_godfile_round3/000_plan.md:25,53 이고 사건 기록은 050_stack_and_gates.md:153-156 이다. 이번 라운드 대응은 각 서브에이전트의 자체 검증을 신뢰하지 않고, 메인 세션이 스택을 접은 각 head 에서 export 표면 diff(origin/dev 대비), 상대 import 해석, ratchet 감사를 재실행하는 것이다. TS2307 필터를 서브에이전트가 정하게 두지 않는다(050 재확인).

소스 오라클 vacuous 가 이 라운드에서 가장 조용한 결함 경로다: 문자열 단언 테스트는 대상이 이동해도 통과하지만 아무것도 검사하지 않게 된다. wp4 가 wp5 앞에 오는 이유다. startServer 내부 절단의 상태 샘은 tsc 와 포커스 테스트로 잡히지만 캡처 변수 목록화를 생략하면 인자 누락이 반복되므로 리프 상단 기록을 강제한다.
