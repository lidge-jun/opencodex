# 050 — 사이클 5: src/adapters/openai-chat.ts 파사드 분해

src/adapters/openai-chat.ts 2,234줄이 요청 직렬화·passthrough·오류 본문 추출·SSE 스트림 해석·도구 스키마 정규화(zen/azure/moonshot/volcengine/xai)·메시지 변환을 한 파일에 들고 있어 래칫 기준 1,999줄을 넘긴다. 이 문서는 그 파일을 4개 PR로 줄이는 복붙 가능한 이동 계약이다. 구현자는 아래 원본 행 범위를 새 리프로 옮기고, 파사드는 createOpenAIChatAdapter 본문과 현행 공개 export 4종을 그대로 유지하며, 소비자(registry·mimo-free·openai-responses·chat-native·src/index·lab executor)는 import 경로를 건드리지 않는다. 상태는 오직 파사드 팩토리 클로저의 lastRequestedModelId 한 개뿐이고, 이동은 순수 잘라 붙이기다. translator budget 위치 인자 계약과 reasoning-replay 소스 오라클 승계, 라운드 2에서 CI가 실제로 잡은 5종 결함(리프 미export·파사드 로컬 import 누락·타입 오import·정의 소실·상대 경로 깊이 오류)에 대한 예방 항목을 포함한다.

> 전달 형태 정정: 이 문서가 적은 브랜치 이름과 PR 개수는 실행되지 않았다. 다섯 파일이 한 워킹트리에서 동시에 작업돼 두 개의 PR로 수렴했다. 이동 계약과 함정 항목은 그대로 실행됐다. 실제 전달은 [090_outcome.md](./090_outcome.md) 를 보라.


브랜치는 round3 레인 패턴을 따르는 `codex/m3-l6-adapters-chat`(round2 기준 phase5=여섯 번째 링크. 레인 명칭 확정은 round3 000_plan 소유이며, 확정되면 그 이름을 따른다). base는 round3 레인에서 바로 앞 링크의 head이고, 레인 밖 기준 트리는 origin/dev ce0ac617da이다(이 문서의 실측 HEAD와 동일 커밋). 순수 이동, 동작 변경 없음. 로컬 스위트·typecheck·build·install은 이 단위 금지(hosted CI). 새 테스트 파일을 만들지 않으므로 layout.json과 tests/fixtures/test-layout-expected.json은 등록하지 않는다. 기준 파일 2,234줄.

## 실측 기록 (이 트리, ce0ac617da)

- wc -l: 2,234줄. top-level export 4종: stripBracketedModelSuffix(49), buildOpenAIChatPassthroughRequest(128), formatOpenAIChatErrorBody(237), createOpenAIChatAdapter(1501). 이외 export 없음.
- 모듈 스코프 가변 상태 0건(rg '^let ' 0매치). 모듈 상수는 CHAT_PASSTHROUGH_FIELDS(60-84), VIDEO_UNSUPPORTED_MARKER(120), SAFE_TOOL_CALL_SHAPE_KEY_SET(487), ZEN_SCHEMA_MAP_KEYS/ZEN_DROPPED_SCHEMA_KEYS(973-974), AZURE_CHAT_FORBIDDEN_ROOT_KEYS(1058), MOONSHOT/VOLCENGINE hostname Set(1092, 1106)과 moonshot 한도 상수(1161-1213) 전부이며, 불변 취급으로 리프와 함께 이동한다. Set/배열 자체를 export하지 않는다.
- 클로저 상태 1개: lastRequestedModelId(1502, let). buildRequest가 쓰고(1509) parseStream/parseResponse가 읽는다(1803, 2185). 팩토리 본문은 파사드에 잔류시키므로 인자화가 아예 필요 없다.
- createOpenAIChatAdapter(1501-2234, 734줄)가 최대 함수이고, 그 내부는 buildRequest(1508-1714), parseStream(1716-2110), parseResponse(2112-2233)다. 다음 최대는 messagesToChatFormat(699-965, 267줄), normalizeMoonshotSchemaNode(1287-1370, 84줄), diagnoseInvalidToolCalls(551-627, 77줄) 순이다.
- ProviderAdapter 계약 실측: 이 어댑터는 name, formatErrorBody, buildRequest, parseStream, parseResponse만 구현한다. runTurn·localTerminal·fetchResponse·tierLogForRunTurn은 없다(rg 0매치). registry createRegisteredAdapter의 runTurn 브랜치는 이 어댑터에 적용되지 않는다.
- translatorBudget 인자 계약: buildRequest(parsed, incoming)의 incoming.translatorBudget, parseStream(response, budget, tierMetadata?), parseResponse(response, budget, tierMetadata?)의 위치 인자. budget은 호출자가 만들어 넘기고 어댑터가 생성하지 않는다. tests/fixtures/translator-budget-required.invalid.ts가 budget 누락 호출의 typecheck 실패를 기대하고, tests/adapters/translator-budget.test.ts:368-371이 그 픽스처를 spawnSync로 검증한다.
- registry 팩토리 사용(단일 생성 권한): src/adapters/registry.ts:13 import, :86에서 withClinePassDeepSeekV4ToolReplayCompatibility(createOpenAIChatAdapter(provider)). 래핑과 tierLog 시딩(withInputMediaGuard, buildRequest 랩)은 전부 registry 소유다. 분해는 createOpenAIChatAdapter의 정의 위치와 시그니처를 바꾸지 않음으로써 이 권한을 유지한다.
- 형제 공유 헬퍼 위치: 공유 헬퍼는 이미 별도 모듈에 있다(openai-chat-images, openai-chat-url, image, empty-tool-output-annotation, identity, tool-catalog-nudge, responses-tool-schema, xai-tool-schema, agentrouter, providers/service-tier, providers/fastwire, lib/translator-budget). 형제 어댑터가 이 파일에서 직접 가져가는 심볼은 하나뿐이다: openai-responses.ts:2가 stripBracketedModelSuffix를 import(사용 :2414). mimo-free.ts:7/215는 createOpenAIChatAdapter만 쓴다. 따라서 신규 공유 모듈 생성은 불필요하고, openai-responses의 import 경로도 파사드로 유지된다.

## 계약 (최우선 보존)

1. 단일 생성 권한: 어댑터 인스턴스 생성은 createOpenAIChatAdapter 한 곳이고, registry가 유일한 조립 지점이다. 리프가 팩토리·래퍼를 갖지 않고, registry의 import 문(`import { createOpenAIChatAdapter } from "./openai-chat";`)이 불변이다.
2. translator budget: 세 메서드의 budget 인자 이름·순서·필수성을 그대로 둔다. budget을 옵션 객체로 흡수하거나 선택 인자로 바꾸면 invalid 픽스처가 typecheck을 통과해 버려 tests/adapters/translator-budget.test.ts가 실패한다.
3. replayCacheScope 소스 오라클: tests/lib/reasoning-replay-scope-source.test.ts:33-41이 src/adapters/openai-chat.ts 본문을 readFileSync로 읽어 `const replayCacheScope = parsed._reasoningReplayScope;` 정확히 1회와 금지 패턴 부재를 단언한다. 이 리터럴은 messagesToChatFormat(702) 안에 있으므로 PR3에서 오라클 읽기 경로를 리프로 갱신한다(아래 동반 수정 의무).
4. 공개 export 집합 불변: 위 4종. 파사드는 3종을 `export { ... } from`으로 재수출하고 createOpenAIChatAdapter는 파사드에서 정의한다. 리프 내부 export가 파사드 공개 표면에 추가되는 일이 없다.

## 공통 이동 규칙

원본 함수·상수 본문을 고치지 않고 잘라 붙인다. 옮긴 파사드 공개 심볼은 파사드에서 정의를 지우고 `export { name } from "./openai-chat/…";` 한 줄로 다시보낸다. 파사드가 계속 쓰는 내부 심볼은 `import { name } from "./openai-chat/…";` 한다. 리프는 파사드 src/adapters/openai-chat.ts를 import하지 않는다(순환 금지). specifier는 extensionless. 주석은 코드와 함께 이동하며 잘라내지 않는다.

리프 위치가 한 단계 깊어지므로(`src/adapters/openai-chat/`) 상대 경로 규칙은 다음과 같다. 이것이 라운드 2 CI 결함 (e)의 직접 예방 항목이다.

| 대상 | 기존(파사드 기준) | 리프 기준 |
|---|---|---|
| src/types.ts | ../types | ../../types |
| src/lib/* | ../lib/x | ../../lib/x |
| src/providers/* | ../providers/x | ../../providers/x |
| src/responses/reasoning-replay-cache | ../responses/reasoning-replay-cache | ../../responses/reasoning-replay-cache |
| src/reasoning-effort | ../reasoning-effort | ../../reasoning-effort |
| src/adapters/base.ts | ./base | ../base |
| 형제 어댑터 모듈(image, identity, agentrouter, xai-tool-schema, responses-tool-schema, empty-tool-output-annotation, openai-chat-images, openai-chat-url) | ./x | ../x |

## 상태 소유권

| 바인딩 | 원본 행 | 소유 | 이유 |
|---|---|---|---|
| lastRequestedModelId | 1502 | 파사드 createOpenAIChatAdapter 클로저 | buildRequest 쓰기(1509)와 parseStream/parseResponse 읽기(1803, 2185)가 한 클로저를 공유한다. 리프로 빼거나 인자로 넘기면 어댑터 인스턴스당 상태가 갈라진다 |
| parseStream 지역 상태(pendingToolCalls, toolCallSeq, pendingUsage, finishReason, reasoningDetailSnapshots 등) | 1727-1801 | 파사드 parseStream 제너레이터 지역 | 모듈 상태가 아니므로 이동 대상이 아니다 |
| CHAT_PASSTHROUGH_FIELDS | 60-84 | passthrough.ts | 유일 소비자가 buildOpenAIChatPassthroughRequest(143)다 |
| VIDEO_UNSUPPORTED_MARKER | 114-120 | messages.ts | 유일 소비자가 messagesToChatFormat(807, 818)다 |
| SAFE_TOOL_CALL_SHAPE_KEY_SET | 478-487 | tool-call-validation.ts | diagnose 클러스터 전용 |
| ZEN_*/AZURE_*/MOONSHOT_*/VOLCENGINE_* 상수 | 973-1380 내 | tool-schema.ts | 스키마 정규화 클러스터 전용 |

Set·배열 상수를 export하거나 인자로 넘겨 두 번째 참조를 만들지 않는다.

## 모듈 지도 (inclusive 원본 행 → 대상, raw 줄)

| 대상 | 원본 | raw | 예상 wc | 공개(파사드 재수출 O/X) |
|---|---|---:|---:|---|
| NEW src/adapters/openai-chat/wire.ts | 45-58, 86-112, 652-665 | 55 | 80 | O stripBracketedModelSuffix. openAIChatTransport·isNativeOpenAIChatTarget는 리프 내부 export |
| NEW src/adapters/openai-chat/passthrough.ts | 60-84, 124-236 | 138 | 170 | O buildOpenAIChatPassthroughRequest |
| NEW src/adapters/openai-chat/errors.ts | 237-342 | 106 | 135 | O formatOpenAIChatErrorBody. unwrapChatCompletionPayload·OpenAIChatError·safeUpstreamRequestId·upstreamErrorEvent는 리프 내부 export |
| NEW src/adapters/openai-chat/tool-call-validation.ts | 447-643 | 197 | 230 | X. isRecord·diagnoseInvalidToolCalls·logInvalidToolCalls와 진단 3타입(451-476)은 리프 내부 export |
| NEW src/adapters/openai-chat/response-events.ts | 344-445, 1449-1459 | 113 | 145 | X. stopReasonFor·reasoningTextFrom·ReasoningDetailSegment(+From/ForWire)·invalidChoicesEvent·invalidToolCallsEvent·unnamedToolCallEvent·usageFromOpenAIChat는 리프 내부 export |
| NEW src/adapters/openai-chat/messages.ts | 114-120, 645-650, 666-971, 1121-1123 | 328 | 385 | X. messagesToChatFormat·developerSystemText·toolResultTextForWire·toolResultImageChatParts·safeToolName(967-971 인출)·emptyAssistantContent(1121-1123 인출)는 리프 내부 export |
| NEW src/adapters/openai-chat/tool-schema.ts | 973-1119, 1125-1380, 1382-1447 | 470 | 545 | X. toolsToChatFormat·toolsToChatFormatForProvider·toolChoiceToChatFormat·isVolcengineArkPaygChatTarget는 리프 내부 export |
| MODIFY src/adapters/openai-chat.ts 잔여 | 1-43 헤더 + 1461-1499 + 1501-2234 + re-export | 796 | 880 | 현행 공개 4종 전부 |

DELETE 없음. 잔여 1461-1499는 resolveMaxTokens(1461-1465)·thinkingBudgetForEffort(1467-1479)·canSerializeOpenAIChatServiceTier(1481-1499)이며 buildRequest 전용이라 파사드에 남는다. usageFromOpenAIChat(1449-1459)만 response-events.ts로 나간다. 파사드 예상 ≈ 880 = 2234 − 1416 이동 + 리프 import/re-export 약 35 + 헤더 정리. 전 파일 1,999 이하.

## 리프 간 import (비순환)

| 리프 | import하는 리프 심볼 |
|---|---|
| wire.ts | 없음 |
| passthrough.ts | wire: openAIChatTransport, stripBracketedModelSuffix |
| errors.ts | 없음 |
| tool-call-validation.ts | 없음 |
| response-events.ts | tool-call-validation: diagnoseInvalidToolCalls |
| tool-schema.ts | wire: isNativeOpenAIChatTarget |
| messages.ts | wire: isNativeOpenAIChatTarget, stripBracketedModelSuffix / response-events: reasoningDetailSegmentForWire / tool-schema: isVolcengineArkPaygChatTarget |
| 파사드 | 위 전부: openAIChatTransport, stripBracketedModelSuffix, isNativeOpenAIChatTarget, messagesToChatFormat, toolsToChatFormatForProvider, toolChoiceToChatFormat, upstreamErrorEvent, unwrapChatCompletionPayload, OpenAIChatError(type), formatOpenAIChatErrorBody(재수출), stopReasonFor, reasoningTextFrom, reasoningDetailSegmentsFrom, invalidChoicesEvent, invalidToolCallsEvent, unnamedToolCallEvent, usageFromOpenAIChat, isRecord, logInvalidToolCalls |

messages→tool-schema 단방향이고 역변 없음. 전체 그래프에 사이클 없다. 리프 외부 import는 기존과 동일 모듈에서 옮긴다: errors.ts는 ../../lib/redact, ../../lib/errors. tool-call-validation.ts는 ../../lib/debug. messages.ts는 ../image(contentPartsToText), ../empty-tool-output-annotation, ../identity, ../../providers/registry, ../../responses/reasoning-replay-cache. tool-schema.ts는 ../xai-tool-schema, ../responses-tool-schema. passthrough.ts는 ../agentrouter, ../../providers/{openrouter-routing, vercel-gateway-routing, service-tier, fastwire}, ../../lib/debug, ../../reasoning-effort. wire.ts는 ../agentrouter, ../openai-chat-url.

## CI가 실제로 잡았던 5종 결함 — 이번 라운드 예방 항목

라운드 2(260914_godfile_round2)에서 hosted CI가 잡아 머지를 막았던 다섯 결함 클래스다. 각 PR에서 구현자가 직접 확인한다.

1. (a) 리프가 심볼을 정의하고 export 안 함: messagesToChatFormat을 messages.ts에 `function`으로만 두면 파사드 buildRequest import가 실패한다. 예방: 모듈 지도의 "공개" 열과 "리프 간 import" 표의 모든 심볼에 export 키워드를 명시한다. PR 직후 `rg -n "^export (function|const|type|interface) <name>" src/adapters/openai-chat/`로 각 소비 심볼의 export 존재를 확인한다.
2. (b) 파사드가 re-export만 하고 로컬 import 누락: 파사드는 createOpenAIChatAdapter를 로컬 정의로 유지하므로 `export { x } from` 추가와 별개로, 파사드 본문이 쓰는 리프 심볼의 `import { ... } from "./openai-chat/…";`를 상단에 함께 넣어야 한다. 예방: 본문 삭제 전에 import를 먼저 추가하고, PR 직후 파사드 본문 사용 지점 전부(messagesToChatFormat, toolsToChatFormatForProvider, upstreamErrorEvent 등)가 상단 import와 대응하는지 확인한다.
3. (c) 타입을 잘못된 모듈에서 import: AdapterEvent·OcxUsage·OcxMessage 등은 ../../types에서, IncomingMeta·ProviderAdapter는 ../base에서, TranslatorBudget은 ../../lib/translator-budget(type)에서, AdapterTierMetadata·ResolvedFastPolicy는 ../../providers/fastwire에서 가져온다. base.ts는 이들을 재수출하지 않으므로 base에서 타입을 당겨오지 않는다. MoonshotNormalizeState(1281-1285)는 tool-schema.ts 로컬 인터페이스로 이동한다.
4. (d) 정의가 통째로 사라지고 호출부만 남음: upstreamErrorEvent(302)를 errors.ts로 옮기지 않고 parseStream 호출부(1832, 1853, 2144, 2160)만 남으면 파사드 컴파일이 깨진다. 예방: 모듈 지도 각 행의 심볼에 대해 PR 직후 `rg -n "^(export )?(async )?function <name>" src/adapters`가 정확히 1회 정의(리프)를 반환하고 파사드에는 import 문만 남는지 확인한다.
5. (e) 한 단계 깊어진 디렉터리에서 ../x 오해석: 리프는 src/adapters/openai-chat/이므로 `../types`는 src/adapters/types를 가리켜 실패한다. 위 "공통 이동 규칙"의 경로 표를 그대로 쓴다. 특히 messages.ts의 `../responses/reasoning-replay-cache`→`../../responses/reasoning-replay-cache`, 형제 모듈 `./image`→`../image` 전환을 빠뜨리면 hosted CI에서만 적색이 된다.

## 함정

1. translator budget(typecheck 픽스처): parseStream/parseResponse의 budget은 2번째 위치 인자로 필수다. 리프 추출 과정에서 budget을 어댑터 필드·옵션 객체로 흡수하면 tests/fixtures/translator-budget-required.invalid.ts가 컴파일되어 버리고 tests/adapters/translator-budget.test.ts:368-371이 적색이 된다. valid 픽스처가 buildRequest(parsed, incoming)에 incoming.translatorBudget을 요구하는 것도 동일하게 유지된다.
2. lastRequestedModelId: buildRequest가 기록한 모델 id를 parseStream/parseResponse가 reasoningDetailsModels 게이트(1803, 2185)에 쓴다. 메서드를 서로 다른 리프로 쪼개 이 상태를 인자로 넘기는 순간 어댑터 인스턴스별 기억이 사라진다. 팩토리 본문은 통째로 파사드에 남긴다.
3. replayCacheScope 오라클: 리터럴이 messages.ts로 이동한 뒤에도 오라클이 파사드를 읽고 있으면 tests/lib/reasoning-replay-scope-source.test.ts가 적색이다. PR3에서 같은 PR 안에 오라클 경로를 갱신한다. 단언 본문(1회 매치, 금지 패턴)은 바꾸지 않는다.
4. openai-responses 역의존: stripBracketedModelSuffix를 wire.ts로 옮겨도 openai-responses.ts:2의 `from "./openai-chat"`은 그대로다. 리프 직접 import로 바꾸면 소비자 계약을 깬다.
5. 미사용 import 잔류: 이동 후 파사드 상단에서만 쓰이던 import(redactSecretString, isCyberPolicyCode, contentPartsToText, EMPTY_TOOL_OUTPUT_ANNOTATION, isWhitespaceOnlyTextPartArray, identifyRoutedModel, registryEntryForProviderDestination, peekReasoningForCall, stripResponsesOnlyEncryptedMarker, stripUnicodePropertyPatterns)는 해당 PR에서 함께 제거한다. 남기면 strict typecheck이 실패한다.
6. sseFieldValue·openai-chat-images·mapReasoningEffort·modelRecordValue·modelInList·isDebugEnabled·debugProviderDiagnostic·frameAgentRouterMessages는 파사드에도 계속 필요하다(사용 지점: 1564, 1463, 1505, 1687-1711, 1806). 실수로 지우지 않는다.

## 동반 수정 의무

| 항목 | 조치 |
|---|---|
| structure/runtime.md:180 | `src/adapters/openai-chat.ts` 행에 그 PR이 만든 리프 경로를 같은 칸에 백틱으로 추가. 없는 파일을 미리 백틱하지 말 것(git index 기준 structure:check 실패) |
| structure/providers/chat-compat.md:13 | deepseek text-only timeline 문장의 소유 경로를 messages.ts 리프로 갱신(PR3) |
| structure/providers/chat-compat.md:273 | tool-call 버퍼 유지 문장은 파사드 parseStream 설명이므로 경로 유지 |
| structure/transports/inventory.md:26 | Chat Completions inbound 셀의 `src/adapters/openai-chat.ts` 뒤에 리프 경로를 PR3/PR4에서 백틱 추가 |
| structure/data-planes/inbound-compat.md:59 | "Request construction remains owned by" 문장: buildRequest는 파사드 잔류이므로 유지. passthrough 리프 착지 시(PR1) 한 절에 리프 경로 병기 |
| tests/lib/reasoning-replay-scope-source.test.ts:33-41 | PR3에서 source("adapters/openai-chat.ts")를 source("adapters/openai-chat/messages.ts")로 갱신. 단언 본문 불변. 소스 오라클 승계의 전부다 |
| tests/fixtures/file-size-baseline.json:20 | `"src/adapters/openai-chat.ts": 2234` 항목. 분해 착지 후 round3 tip/D 사이클에서 `bun run ratchet:update`로 회수. 중간 PR에서 이 숫자를 늘리지 않는다 |
| structure/manifest.json | 변경 없음. 이 파일에 바인딩된 INV-*가 없다(manifest 검색 0건 실측). 승계할 INV는 없고 위 소스 오라클 승계가 계약이다 |
| layout.json / test-layout-expected.json | 등록하지 않음. 새 테스트 파일 없음. 기존 openai-chat-*.test.ts는 이미 explicit 등록(layout.json:989-995, expected:817-826)이라 불변 |
| src/lab 경계 | 리프가 src/lab을 import하지 않는다(현행 파일도 아님). tests/lab/core-lab-boundary.test.ts는 경계 감시로 유지 |

## 소비자 (파사드 유지, write set 밖)

src/index.ts:8, src/adapters/registry.ts:13/86, src/adapters/mimo-free.ts:7/215, src/adapters/openai-responses.ts:2/2414, src/server/chat-native.ts:1/256/271/333/406, src/lab/conformance/executor.ts:1/84/129/223/300/343/558/582. 전부 파사드 경로를 유지하며 이 단위에서 수정하지 않는다. 리프를 직접 import하는 신규 소비자를 만들지 않는다.

---

## PR 1 — wire + passthrough (비-tip, [skip ci] 가능)

### NEW

src/adapters/openai-chat/wire.ts 예상 80줄. 원본 45-58(주석 포함 stripBracketedModelSuffix), 86-112(openAIChatTransport), 652-665(isNativeOpenAIChatTarget). import: ../agentrouter(agentRouterDefaultHeaders), ../openai-chat-url, ../../types(OcxProviderConfig).

src/adapters/openai-chat/passthrough.ts 예상 170줄. 원본 60-84(CHAT_PASSTHROUGH_FIELDS), 124-236(주석 포함 buildOpenAIChatPassthroughRequest). import: ./wire(2종), ../agentrouter, ../../providers/openrouter-routing, ../../providers/vercel-gateway-routing, ../../providers/service-tier(fastPolicyForModel, type ResolvedFastPolicy), ../../providers/fastwire(canonicalFastTierMarker, decideTier), ../../lib/debug, ../../lib/debug-settings, ../../reasoning-effort(modelRecordValue), ../../types(modelInList, type AdapterRequest, type OcxProviderConfig).

### MODIFY

src/adapters/openai-chat.ts: 45-58, 60-84, 86-112, 124-236, 652-665 삭제. 상단에 wire/passthrough import와 `export { stripBracketedModelSuffix } from "./openai-chat/wire";`, `export { buildOpenAIChatPassthroughRequest } from "./openai-chat/passthrough";` 추가. VIDEO 주석 114-120은 이 PR에서 이동하지 않고 PR3까지 파사드에 잔여한다(소비자가 messages뿐).

structure/data-planes/inbound-compat.md:59에 passthrough 리프 병기. structure/runtime.md:180에 두 리프 백틱.

### 회귀

tests/adapters/openai/openai-chat-hardening.test.ts(passthrough 직접 호출), tests/adapters/openai/openai-chat-model-suffix.test.ts(stripBracketedModelSuffix 직접), tests/adapters/openai/openai-chat-url.test.ts, tests/adapters/openai/openai-chat-path-override.test.ts, tests/adapters/openai/openai-chat-native-policy.test.ts, tests/adapters/adapter-registry-authority.test.ts, tests/providers/mimo-free-provider.test.ts.

예상: 파사드 2234 − 193 + import/re-export ≈ 2,070. 아직 1,999 초과 — PR2~4에서 해소된다.

---

## PR 2 — errors + response-events + tool-call-validation (비-tip)

### NEW

src/adapters/openai-chat/errors.ts 예상 135줄. 원본 237-342(formatOpenAIChatErrorBody 237-247, extractErrorDetail 249-272, unwrapChatCompletionPayload 274-280, OpenAIChatError 282-288, safeUpstreamRequestId 290-300, upstreamErrorEvent 302-342). import: ../../lib/errors(isCyberPolicyCode), ../../lib/redact(redactSecretString), ../../types(AdapterEvent, OcxUsage).

src/adapters/openai-chat/tool-call-validation.ts 예상 230줄. 원본 447-643(isRecord, 진단 타입 3종, SAFE_TOOL_CALL_SHAPE_KEYS/SET, structuralValueType, invalidToolCallField, fingerprintInvalidField, isInvalidStreamStringField, diagnoseInvalidToolCalls, logInvalidToolCalls). import: ../../lib/debug, ../../types(AdapterEvent, OcxUsage).

src/adapters/openai-chat/response-events.ts 예상 145줄. 원본 344-445(stopReasonFor, reasoningTextFrom, ReasoningDetailSegment, reasoningDetailSegmentsFrom, reasoningDetailSegmentForWire, invalidChoicesEvent, invalidToolCallsEvent, unnamedToolCallEvent), 1449-1459(usageFromOpenAIChat). import: ./tool-call-validation(diagnoseInvalidToolCalls), ../../types(AdapterEvent, OcxUsage, OcxThinkingContent).

### MODIFY

src/adapters/openai-chat.ts: 237-342, 344-445, 1449-1459 삭제. errors/response-events/tool-call-validation import 추가, formatOpenAIChatErrorBody 재수출 추가. 상단에서 redactSecretString·isCyberPolicyCode import 제거.

structure/runtime.md:180에 세 리프 백틱.

### 회귀

tests/adapters/adapter-error-inline.test.ts, tests/adapters/openai/openai-chat-invalid-tool-call-diagnostics.test.ts, tests/adapters/openai/openai-chat-dangling-toolcalls.test.ts, tests/adapters/openai/openai-chat-eof.test.ts, tests/adapters/openai/openai-chat-parallel-stream.test.ts, tests/adapters/openai/openai-chat-hardening.test.ts, tests/adapters/adapter-usage.test.ts, tests/adapters/buffered-response-shape-guards.test.ts, tests/adapters/translator-budget.test.ts, tests/providers/cyber-policy-error-fidelity.test.ts, tests/providers/nvidia-nim-hardening.test.ts, tests/responses/sse-null-data-frame.test.ts, tests/responses/sse-unspaced-data-fields.test.ts, tests/web-search/web-search.test.ts(formatErrorBody #126 계약).

예상: 파사드 ≈ 2,070 − 456 + import ≈ 1,640. 1,999 이하로 처음 진입.

---

## PR 3 — messages + 소스 오라클 승계 (비-tip)

### NEW

src/adapters/openai-chat/messages.ts 예상 385줄. 원본 114-120(VIDEO 주석·상수), 645-650(developerSystemText), 666-971(toolResultTextForWire, toolResultImageChatParts, messagesToChatFormat, safeToolName), 1121-1123(emptyAssistantContent). import: ./wire(isNativeOpenAIChatTarget, stripBracketedModelSuffix), ./response-events(reasoningDetailSegmentForWire), ./tool-schema(isVolcengineArkPaygChatTarget), ../image(contentPartsToText), ../empty-tool-output-annotation, ../identity(identifyRoutedModel), ../../providers/registry(registryEntryForProviderDestination), ../../responses/reasoning-replay-cache(peekReasoningForCall), ../../types.

702의 `const replayCacheScope = parsed._reasoningReplayScope;`는 본문 그대로 이 리프로 간다.

### MODIFY

src/adapters/openai-chat.ts: 114-120, 645-650, 666-971, 1121-1123 삭제. messages import 추가. 상단에서 contentPartsToText, EMPTY_TOOL_OUTPUT_ANNOTATION, isWhitespaceOnlyTextPartArray, identifyRoutedModel, registryEntryForProviderDestination, peekReasoningForCall import 제거.

tests/lib/reasoning-replay-scope-source.test.ts: source("adapters/openai-chat.ts") → source("adapters/openai-chat/messages.ts")(:33). 단언 본문(:34-41) 불변.

structure/providers/chat-compat.md:13 경로 갱신. structure/runtime.md:180에 messages.ts 백틱. structure/transports/inventory.md:26 백틱 추가.

### 회귀

tests/lib/reasoning-replay-scope-source.test.ts(오라클), tests/adapters/openai/openai-chat-system-order.test.ts, tests/adapters/openai/openai-chat-video-part.test.ts, tests/adapters/openai/openai-chat-tool-result-images.test.ts, tests/adapters/openai/openai-chat-image-normalization.test.ts, tests/adapters/coding-agent-tool-result-images.test.ts, tests/adapters/empty-tool-output-annotation.test.ts, tests/adapters/identity-neutralize.test.ts, tests/adapters/reasoning-replay-identity.test.ts, tests/adapters/reasoning-replay-robustness.test.ts, tests/providers/minimax-reasoning-split.test.ts, tests/providers/opencode-go-deepseek.test.ts, tests/providers/mimo-free-provider.test.ts, tests/responses/chat-media-translation.test.ts, tests/responses/chat-inbound-reasoning-replay.test.ts.

예상: 파사드 ≈ 1,640 − 328 + import ≈ 1,330.

---

## PR 4 — tool-schema (레인 tip)

### NEW

src/adapters/openai-chat/tool-schema.ts 예상 545줄. 원본 973-1119(ZEN/AZURE/MOONSHOT/VOLCENGINE 상수·판별·sanitize 클러스터), 1125-1380(ensureRootObjectType, isXaiObjectSchema, moonshot 정규화 상태 기계), 1382-1447(toolsToChatFormat, toolsToChatFormatForProvider, toolChoiceToChatFormat). import: ./wire(isNativeOpenAIChatTarget), ../xai-tool-schema(isXaiSchemaTarget, lookupLocalJsonPointer, normalizeXaiToolParameters), ../responses-tool-schema(stripResponsesOnlyEncryptedMarker, stripUnicodePropertyPatterns), ../../types(isAllowedToolChoice, resolveToolChoiceWireName, toolChoiceToolPredicate, type OcxParsedRequest, type OcxProviderConfig).

### MODIFY

src/adapters/openai-chat.ts: 973-1119, 1125-1380, 1382-1447 삭제. tool-schema import 추가. 상단에서 stripResponsesOnlyEncryptedMarker·stripUnicodePropertyPatterns import 제거.

structure/runtime.md:180에 tool-schema.ts 백틱. structure/transports/inventory.md:26 완성. 이 PR이 tip이므로 커밋 제목에 [skip ci]를 붙이지 않는다.

### 회귀

tests/providers/opencode-zen-deepseek-reasoning.test.ts, tests/providers/moonshot-tool-schema.test.ts, tests/providers/azure-model-router-tool-schema.test.ts, tests/providers/volcengine-ark-assistant-content.test.ts, tests/providers/xai/xai-tool-schema.test.ts, tests/adapters/adapter-tool-conformance.test.ts, tests/adapters/adapter-buffered-tool-conformance.test.ts, tests/adapters/tool-choice-performance.test.ts, tests/adapters/tool-catalog-nudge.test.ts, tests/adapters/adapter-registry-authority.test.ts.

### 잔여 파사드 골격

헤더 import + resolveMaxTokens(1461-1465) + thinkingBudgetForEffort(1467-1479) + canSerializeOpenAIChatServiceTier(1481-1499) + createOpenAIChatAdapter(1501-2234) + 재수출 3종. 예상 ≈ 1,330 − 470 + import ≈ 880.

## 수락 기준

1. src/adapters/openai-chat.ts ≤ 1,999(예상 ≈ 880), 새 리프 7개 전부 ≤ 1,999(최대 tool-schema 예상 545).
2. 파사드 공개 export는 stripBracketedModelSuffix, buildOpenAIChatPassthroughRequest, formatOpenAIChatErrorBody, createOpenAIChatAdapter 4종 그대로. 리프 내부 export가 파사드 표면에 새로 보이지 않는다.
3. createOpenAIChatAdapter 본문(1501-2234)이 파사드에 원문 잔류하고 lastRequestedModelId 클로저가 인자화되지 않는다. registry.ts:86 래핑 합성과 소비자 import 경로 7곳 불변.
4. parseStream/parseResponse의 budget 위치 인자와 incoming.translatorBudget 계약 불변. tests/fixtures/translator-budget-required.{valid,invalid}.ts 판정이 뒤집히지 않는다.
5. `const replayCacheScope = parsed._reasoningReplayScope;`가 messages.ts에 정확히 1회, 오라클 갱신 동반, 파사드·타 리프에 0회.
6. 리프→파사드 import 0, 리프 간 순환 0. 리프의 src-level import는 전부 ../../ 깊이.
7. structure:check 녹색(runtime.md:180, chat-compat.md:13, inventory.md:26, inbound-compat.md:59 갱신). manifest.json·INDEX.md 수동 편집 없음. layout 등록 없음.
8. file-size-baseline.json의 2234 항목은 round3 tip/D 사이클에서 ratchet:update로 회수되고, 중간 PR에서 증가하지 않는다.

