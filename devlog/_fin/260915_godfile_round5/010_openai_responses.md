# 010 — WP2: src/adapters/openai-responses.ts 분해 계약서 (godfile round5)

측정 기준: 이 워크트리 HEAD aa91958e3b (git log --oneline -1 실측, base origin/dev 와 동일). 아래 숫자는 전부 이 워크트리에서 실행한 명령 출력값이고, 실행 전에는 확정할 수 없는 값은 미측정으로 표기한다.

## 실측 요약

- wc -l: 2,627줄.
- rg 최상위 선언 83개(46~2183행). export 5개: FORWARD_HEADERS(46), sanitizeReasoningInputContent(76), stripCanonicalForwardSamplingParams(1303), stripOpenAiOnlyWebSearchFields(1957), createResponsesPassthroughAdapter(2183). 내부 전용 78개.
- awk 괄호 깊이 추적: 심볼 범위 합 2,163줄, 심볼 밖 464줄 = 헤더 1-45(45줄) + 심볼 사이 빈 줄·주석 419줄. OVERLAP 0건. 1-45(import 문)를 제외한 모든 갭이 빈 줄/주석뿐이라 각 심볼의 끝행 계산이 성립한다.
- 선행 주석(JSDoc)은 바로 아래 심볼에 붙아 함께 이동한다. 갭 검증이 이를 보장한다.
- 동적 import(: 파일 내 0건(rg -n 'import\(' 빈 출력). 테스트 쪽 동적 import 1건 — tests/adapters/anthropic/anthropic-thinking-signature.test.ts:317, facade 경로라 영향 없음.
- isPlainObject 등장 135회(rg -c). 전 리프가 쓰는 유일한 공용 유틸이다.

## 이동 규칙

- 순수 이동만 한다. 함수 본문 수정 없이 시작행-끝행 범위를 통째로 옮기고, 선행 주석 블록은 해당 심볼과 함께 옮긴다.
- 리프 디렉터리는 src/adapters/openai-responses/ 이다. 상대 지정자 규칙: ./x → ../x, ../y → ../../y, node:* 는 그대로. 리프 파일 첫 import 블록에 일괄 적용한다. 라운드2의 ../config 가 존재하지 않는 src/codex/config 를 가린 사례가 바로 이 클래스고, 정적 가드 tests/ci-workflows/repo-import-resolution.test.ts(라운드3 커밋 0eab3851a5)가 해상 실패를 잡는다.
- 파사드 export 표면은 위 5개로 고정한다. 리프는 리프 간 참조와 어댑터 호출에 필요한 심볼에만 선언부에 export 키워드를 더한다(본문 무변경).
- 리프 간 의존성(호출 그래프 rg 실측): 전 리프 → internal(isPlainObject), canonical-forward → prompt-cache(stripPromptCacheBreakpoints, 원본 1449행 호출 지점), passthrough(어댑터) → 전 리프 진입 함수. 이 외 교차는 없다.

## 리프 배치 (10개)

심볼 줄수는 awk 계산값이다. 리프별 최종 줄수(주석·import 포함)는 이동 후 wc -l 로 확정하므로 현재 미측정이다.

| 리프 파일 | 담는 심볼(원본 행) | 심볼 줄수 | 리프 진입 export |
|---|---|---|---|
| internal.ts | isPlainObject(458-460) | 3 | isPlainObject |
| reasoning.ts | sanitizeReasoningInputContent(76-142), stripUnsupportedReasoningSummaryDelivery(144-155), stripDisabledReasoningSummaries(377-413), stripDisabledVerbosity(420-434), normalizeConfiguredReasoningSummaryDelivery(440-456), mapRoutedResponsesReasoningEffort(467-488) | 170 | 위 6개 전부 |
| request-strips.ts | stripInvalidItemIds(157-183), CANONICAL_ONLY_TOOL_FIELDS(196-207), stripCanonicalOnlyToolFields(209-248), stripInternalChatMessageMetadataPassthrough(257-272), stripItemIdsWhenUnstored(280-294), scrubOcxCompactionItems(310-336) | 137 | stripInvalidItemIds, stripCanonicalOnlyToolFields, stripInternalChatMessageMetadataPassthrough, stripItemIdsWhenUnstored, scrubOcxCompactionItems |
| prompt-cache.ts | stripDeprecatedPromptCacheRetention(351-358), stripCanonicalForwardPromptCacheOptions(366-370), POSIT_CACHE_MARKER_MAX_DEPTH(1383), POSIT_CACHE_MARKER_MAX_NODES(1384), PromptCacheMarkerRewrite(1386-1390), stripPromptCacheBreakpoints(1397-1429) | 53 | stripDeprecatedPromptCacheRetention, stripCanonicalForwardPromptCacheOptions, stripPromptCacheBreakpoints |
| tool-schema.ts | normalizeFunctionToolSchema(490-505), reconcileToolChoiceForOmittedTools(516-551), normalizeToolSchemas(553-597), activateDeferredTool(599-606), mergeLoadedTools(608-669), promoteClientLoadedTools(676-703), stripUnsupportedHostedTools(1865-1926) | 257 | normalizeToolSchemas, promoteClientLoadedTools, stripUnsupportedHostedTools |
| tool-output-recovery.ts | MAX_RESPONSES_CALL_ID_LENGTH(705), REPAIRED_CALL_ID_PREFIX(707), REPAIRED_CALL_ID_DIGEST_LENGTH(708), repairOversizedReplayCallIds(719-753), toolOutputText(756-765), isRepairableToolOutput(768-794), orphanedToolOutputContent(797-820), isToolOutputEmpty(823-837), annotateEmptyResponsesToolOutputs(844-854), repairUnidentifiedToolOutputItems(862-880), backfillWebSearchQueries(928-966), repairOrphanedInputItems(968-1108), normalizeResponsesToolResultAdjacency(1121-1209) | 413 | repairOversizedReplayCallIds, annotateEmptyResponsesToolOutputs, repairUnidentifiedToolOutputItems, backfillWebSearchQueries, repairOrphanedInputItems, normalizeResponsesToolResultAdjacency |
| canonical-forward.ts | stripPreviousResponseId(1222-1226), applyTierDecisionToResponsesBody(1229-1235), stripStatefulResponsesParams(1260-1269), stripUnsupportedForwardParams(1279-1286), CANONICAL_FORWARD_UNSUPPORTED_SAMPLING(1289), stripCanonicalForwardSamplingParams(1303-1311), canonicalForwardSystemText(1314-1327), isCanonicalForwardSystemMessage(1330-1334), normalizeCanonicalForwardPromptEnvelope(1345-1381), normalizeCanonicalForwardContinuationEnvelope(1437-1455) | 115 | 위 10개 중 상수 1개 제외한 9개 |
| image-gen.ts | IMAGE_GEN_NAMESPACE(1457), HOSTED_IMAGE_GENERATION_TOOL(1458), IMAGE_GEN_DOTTED_PREFIX(1459), IMAGE_GEN_WIRE_PREFIX(1460), imageGenLocalName(1463-1467), imageGenWireName(1470-1472), isImageGenClientName(1475-1479), declaresImageGenClientTool(1482-1486), preferHostedImageGenToolChoice(1489-1515), preferConfiguredHostedTools(1522-1608), flattenImageGenNamespace(1619-1644), normalizeFlatImageGenFunction(1647-1655), imageGenFunctionName(1658-1663), declaresUsableImageGenAlias(1666-1676), imageGenToolChoiceAliases(1679-1711), normalizeImageGenToolChoice(1714-1737), declaresImageGenFunctionCall(1740-1745), normalizeImageGenFunctionCall(1748-1760), normalizeImageGenClientTools(1776-1858) | 347 | preferConfiguredHostedTools, normalizeImageGenClientTools |
| web-search.ts | OPENAI_ONLY_WEB_SEARCH_FIELDS(1938), stripOpenAiOnlyWebSearchFieldsFromTools(1940-1955), stripOpenAiOnlyWebSearchFields(1957-1988), MUSE_SPARK_WEB_SEARCH_STRICT_MODELS(1997-2002), MUSE_SPARK_WEB_SEARCH_STRICT_RESPONSE_URLS(2004-2008), MUSE_SPARK_UNSUPPORTED_WEB_SEARCH_FIELDS(2010-2013), stripMuseSparkUnsupportedWebSearchFields(2024-2081) | 122 | stripOpenAiOnlyWebSearchFields, stripMuseSparkUnsupportedWebSearchFields |
| passthrough.ts | FORWARD_HEADERS(46-65), stripInputImagesDeep(2084-2093), buildRoutedCompactionBody(2105-2121), usageFromResponsesPayload(2124-2150), responsesPayloadText(2152-2162), responsesErrorMessage(2164-2172), appendedUtf8Bytes(2175-2181), createResponsesPassthroughAdapter(2183-2627) | 546 | FORWARD_HEADERS, createResponsesPassthroughAdapter |

리프 합계 검산: 3+170+137+53+257+413+115+347+122+546 = 2,163 = awk covered 총계와 일치. 가장 큰 리프는 passthrough 546줄이고 전 리프가 700줄 미만이다.

## 전체 심볼 인벤토리 (83개)

O 는 현재 export, 리프 열은 이동 대상 파일이다.

| 심볼 | 원본 행 | 줄수 | export | 리프 |
|---|---|---|---|---|
| FORWARD_HEADERS | 46-65 | 20 | O | passthrough |
| sanitizeReasoningInputContent | 76-142 | 67 | O | reasoning |
| stripUnsupportedReasoningSummaryDelivery | 144-155 | 12 |  | reasoning |
| stripInvalidItemIds | 157-183 | 27 |  | request-strips |
| CANONICAL_ONLY_TOOL_FIELDS | 196-207 | 12 |  | request-strips |
| stripCanonicalOnlyToolFields | 209-248 | 40 |  | request-strips |
| stripInternalChatMessageMetadataPassthrough | 257-272 | 16 |  | request-strips |
| stripItemIdsWhenUnstored | 280-294 | 15 |  | request-strips |
| scrubOcxCompactionItems | 310-336 | 27 |  | request-strips |
| stripDeprecatedPromptCacheRetention | 351-358 | 8 |  | prompt-cache |
| stripCanonicalForwardPromptCacheOptions | 366-370 | 5 |  | prompt-cache |
| stripDisabledReasoningSummaries | 377-413 | 37 |  | reasoning |
| stripDisabledVerbosity | 420-434 | 15 |  | reasoning |
| normalizeConfiguredReasoningSummaryDelivery | 440-456 | 17 |  | reasoning |
| isPlainObject | 458-460 | 3 |  | internal |
| mapRoutedResponsesReasoningEffort | 467-488 | 22 |  | reasoning |
| normalizeFunctionToolSchema | 490-505 | 16 |  | tool-schema |
| reconcileToolChoiceForOmittedTools | 516-551 | 36 |  | tool-schema |
| normalizeToolSchemas | 553-597 | 45 |  | tool-schema |
| activateDeferredTool | 599-606 | 8 |  | tool-schema |
| mergeLoadedTools | 608-669 | 62 |  | tool-schema |
| promoteClientLoadedTools | 676-703 | 28 |  | tool-schema |
| MAX_RESPONSES_CALL_ID_LENGTH | 705 | 1 |  | tool-output-recovery |
| REPAIRED_CALL_ID_PREFIX | 707 | 1 |  | tool-output-recovery |
| REPAIRED_CALL_ID_DIGEST_LENGTH | 708 | 1 |  | tool-output-recovery |
| repairOversizedReplayCallIds | 719-753 | 35 |  | tool-output-recovery |
| toolOutputText | 756-765 | 10 |  | tool-output-recovery |
| isRepairableToolOutput | 768-794 | 27 |  | tool-output-recovery |
| orphanedToolOutputContent | 797-820 | 24 |  | tool-output-recovery |
| isToolOutputEmpty | 823-837 | 15 |  | tool-output-recovery |
| annotateEmptyResponsesToolOutputs | 844-854 | 11 |  | tool-output-recovery |
| repairUnidentifiedToolOutputItems | 862-880 | 19 |  | tool-output-recovery |
| backfillWebSearchQueries | 928-966 | 39 |  | tool-output-recovery |
| repairOrphanedInputItems | 968-1108 | 141 |  | tool-output-recovery |
| normalizeResponsesToolResultAdjacency | 1121-1209 | 89 |  | tool-output-recovery |
| stripPreviousResponseId | 1222-1226 | 5 |  | canonical-forward |
| applyTierDecisionToResponsesBody | 1229-1235 | 7 |  | canonical-forward |
| stripStatefulResponsesParams | 1260-1269 | 10 |  | canonical-forward |
| stripUnsupportedForwardParams | 1279-1286 | 8 |  | canonical-forward |
| CANONICAL_FORWARD_UNSUPPORTED_SAMPLING | 1289 | 1 |  | canonical-forward |
| stripCanonicalForwardSamplingParams | 1303-1311 | 9 | O | canonical-forward |
| canonicalForwardSystemText | 1314-1327 | 14 |  | canonical-forward |
| isCanonicalForwardSystemMessage | 1330-1334 | 5 |  | canonical-forward |
| normalizeCanonicalForwardPromptEnvelope | 1345-1381 | 37 |  | canonical-forward |
| POSIT_CACHE_MARKER_MAX_DEPTH | 1383 | 1 |  | prompt-cache |
| POSIT_CACHE_MARKER_MAX_NODES | 1384 | 1 |  | prompt-cache |
| PromptCacheMarkerRewrite | 1386-1390 | 5 |  | prompt-cache |
| stripPromptCacheBreakpoints | 1397-1429 | 33 |  | prompt-cache |
| normalizeCanonicalForwardContinuationEnvelope | 1437-1455 | 19 |  | canonical-forward |
| IMAGE_GEN_NAMESPACE | 1457 | 1 |  | image-gen |
| HOSTED_IMAGE_GENERATION_TOOL | 1458 | 1 |  | image-gen |
| IMAGE_GEN_DOTTED_PREFIX | 1459 | 1 |  | image-gen |
| IMAGE_GEN_WIRE_PREFIX | 1460 | 1 |  | image-gen |
| imageGenLocalName | 1463-1467 | 5 |  | image-gen |
| imageGenWireName | 1470-1472 | 3 |  | image-gen |
| isImageGenClientName | 1475-1479 | 5 |  | image-gen |
| declaresImageGenClientTool | 1482-1486 | 5 |  | image-gen |
| preferHostedImageGenToolChoice | 1489-1515 | 27 |  | image-gen |
| preferConfiguredHostedTools | 1522-1608 | 87 |  | image-gen |
| flattenImageGenNamespace | 1619-1644 | 26 |  | image-gen |
| normalizeFlatImageGenFunction | 1647-1655 | 9 |  | image-gen |
| imageGenFunctionName | 1658-1663 | 6 |  | image-gen |
| declaresUsableImageGenAlias | 1666-1676 | 11 |  | image-gen |
| imageGenToolChoiceAliases | 1679-1711 | 33 |  | image-gen |
| normalizeImageGenToolChoice | 1714-1737 | 24 |  | image-gen |
| declaresImageGenFunctionCall | 1740-1745 | 6 |  | image-gen |
| normalizeImageGenFunctionCall | 1748-1760 | 13 |  | image-gen |
| normalizeImageGenClientTools | 1776-1858 | 83 |  | image-gen |
| stripUnsupportedHostedTools | 1865-1926 | 62 |  | tool-schema |
| OPENAI_ONLY_WEB_SEARCH_FIELDS | 1938 | 1 |  | web-search |
| stripOpenAiOnlyWebSearchFieldsFromTools | 1940-1955 | 16 |  | web-search |
| stripOpenAiOnlyWebSearchFields | 1957-1988 | 32 | O | web-search |
| MUSE_SPARK_WEB_SEARCH_STRICT_MODELS | 1997-2002 | 6 |  | web-search |
| MUSE_SPARK_WEB_SEARCH_STRICT_RESPONSE_URLS | 2004-2008 | 5 |  | web-search |
| MUSE_SPARK_UNSUPPORTED_WEB_SEARCH_FIELDS | 2010-2013 | 4 |  | web-search |
| stripMuseSparkUnsupportedWebSearchFields | 2024-2081 | 58 |  | web-search |
| stripInputImagesDeep | 2084-2093 | 10 |  | passthrough |
| buildRoutedCompactionBody | 2105-2121 | 17 |  | passthrough |
| usageFromResponsesPayload | 2124-2150 | 27 |  | passthrough |
| responsesPayloadText | 2152-2162 | 11 |  | passthrough |
| responsesErrorMessage | 2164-2172 | 9 |  | passthrough |
| appendedUtf8Bytes | 2175-2181 | 7 |  | passthrough |
| createResponsesPassthroughAdapter | 2183-2627 | 445 | O | passthrough |

## 파사드

src/adapters/openai-responses.ts 는 헤더 주석과 아래 5개 재노출만 남는다. import 문이 필요 없는 export-from 형태라 실무 약 15줄이고 200줄 상한 여유가 크다. 경로가 그대라서 src/index.ts:9 와 src 내부 12곳, 테스트 31곳의 import 는 무수정이다.

| export | 새 위치 |
|---|---|
| FORWARD_HEADERS | ./openai-responses/passthrough |
| sanitizeReasoningInputContent | ./openai-responses/reasoning |
| stripCanonicalForwardSamplingParams | ./openai-responses/canonical-forward |
| stripOpenAiOnlyWebSearchFields | ./openai-responses/web-search |
| createResponsesPassthroughAdapter | ./openai-responses/passthrough |

## import 재작성 표 (원본 1-42 → 리프)

소비 리프는 식별자 사용 행을 rg 로 대조한 결과다. 멀티라인 문은 행 범위로 적었다.

| 원본 행 | 지정자 | 변환 후 | 소비 리프 |
|---|---|---|---|
| 1 | ./routed-agent-messages | ../routed-agent-messages | passthrough |
| 2 | ./openai-chat | ../openai-chat | passthrough |
| 3 | ./opencode-go-additional-tools | ../opencode-go-additional-tools | passthrough |
| 4 | ../providers/xai-transport | ../../providers/xai-transport | passthrough |
| 5 | node:crypto | 그대로 | tool-output-recovery(740) |
| 6 | node:buffer | 그대로 | passthrough(2180, 2445 이후) |
| 7 | ./base (import type) | ../base | passthrough |
| 8 | ../types | ../../types | passthrough, reasoning, tool-schema, canonical-forward, image-gen |
| 9 | ../codex/catalog | ../../codex/catalog | reasoning(145) |
| 10 | ../codex/forward-transport-headers | ../../codex/forward-transport-headers | passthrough(64, 2418-2425) |
| 11 | ../responses/compaction | ../../responses/compaction | request-strips(319-331), passthrough(2118) |
| 12 | ../responses/tool-groups | ../../responses/tool-groups | image-gen(1779) |
| 13 | ../responses/hosted-tool-policy | ../../responses/hosted-tool-policy | tool-schema(1871, 1910) |
| 14 | ../lib/sse-decoder | ../../lib/sse-decoder | passthrough(2485) |
| 15 | ../lib/debug | ../../lib/debug | tool-schema(592) |
| 16-20 | ../providers/openai-tiers | ../../providers/openai-tiers | passthrough(2194-2388) |
| 21 | ../responses/reasoning-envelope | ../../responses/reasoning-envelope | reasoning(96) |
| 22 | ../reasoning-effort | ../../reasoning-effort | reasoning(382-485) |
| 23 | ../lib/translator-budget (import type) | ../../lib/translator-budget | passthrough(2467, 2593) |
| 24 | ../responses/custom-tool-compat | ../../responses/custom-tool-compat | passthrough(2311) |
| 25 | ../responses/tool-search-compat | ../../responses/tool-search-compat | passthrough(2322) |
| 26 | ../responses/namespace-tool-compat | ../../responses/namespace-tool-compat | passthrough(2330) |
| 27 | ../responses/plaintext-v2-agent-messages | ../../responses/plaintext-v2-agent-messages | passthrough(2368) |
| 28 | ../responses/muse-tool-name-alias | ../../responses/muse-tool-name-alias | passthrough(2346-2347) |
| 29 | ./openai-responses-url | ../openai-responses-url | passthrough(2232) |
| 30 | ./responses-code-mode | ../responses-code-mode | passthrough(2360) |
| 31 | ./responses-tool-schema | ../responses-tool-schema | tool-schema(494) |
| 32 | ./xai-web-search | ../xai-web-search | passthrough(2335-2336) |
| 33 | ./empty-tool-output-annotation | ../empty-tool-output-annotation | tool-output-recovery(830, 851) |
| 34-38 | ./xai-tool-schema | ../xai-tool-schema | tool-schema(497, 525), passthrough(2396) |
| 39-41 | ../providers/fastwire | ../../providers/fastwire | passthrough(2430) |

## 동반 수정 (테스트·문서)

경로형 검색 두 종(파일명 포함 rg -n 'openai-responses\.ts' tests/, 경로형 rg -n 'adapters/openai-responses')의 결과가 아래 판정의 근거다. readFileSync 로 어댑터 원문을 읽어 문자열을 단언하는 소스 오라클 테스트는 0건이다. gui/ 와 docs-site/ 에는 경로 참조가 없다.

- tests/fixtures/file-size-baseline.json:21 — "src/adapters/openai-responses.ts": 2627. 파사드 축소는 SHRANK 로 통과(file-size-ratchet.test.ts:87). --update 로 캡을 내리는 건 선택. 신규 리프는 전부 2,000줄 미만(THRESHOLD, file-size-ratchet.test.ts:47)이라 NEW_OVERSIZED 없음. devlog/ 는 스캔 제외(같은 파일 203행).
- tests/ci-workflows/repo-import-resolution.test.ts — 리프 상대 경로 오타를 잡는 정적 가드. 분해 PR 은 이 테스트와 file-size-ratchet 이 1차 방어선이다.
- tests/routing/routing-compatibility-model-matching.test.ts:123, 146 — 주석이 파일명과 src/adapters/openai-responses.ts:1001 라인 앵커를 건다. 앵커는 이미 현행 1532-1534(preferConfiguredHostedTools)와 어긋진 상태고, 분해 후 image-gen.ts 로 재지정이 필요하다. 테스트 동작은 무관.
- src/routing/compatibility/behavior.ts:84 — 같은 :1001 앵커 주석. image-gen.ts 로 재지정.
- src/server/chat-completions.ts:244 — 파일 경로 주석. 파사드가 살아있어 깨지지 않고, 리프 언급으로 갱신하면 좋다.
- facade 경로 import 테스트 31개 파일(빠짐없이 열거): fastwire-policy:3, fastwire-observability:4, responses/compaction-progress:2, gui/volcengine-providers:3, responses/responses-routed-web-search-fields:2, responses/passthrough-override:2, responses/responses-forward-posit-continuation:2, responses/chat-responses-control-integration:24, responses/responses-forward-prompt-envelope:3, codex-integration/codex-metadata-integrity:2, responses/openai-responses-passthrough:4, responses/responses-muse-tool-name-alias:3, responses/plaintext-v2-agent-messages:2, responses/responses-compaction:3, responses/chat-responses-control-scope:17, responses/ws-upstream-reuse:6, responses/responses-forward-dangling-call:10, responses/responses-usage-passthrough:2, claude-integration/claude-inbound:8, providers/muse-spark-web-search-compat:2, providers/opencode-go-luna-wire:13, providers/muse-tool-name-alias:3, providers/meta-model-api-provider:16, providers/opencode-go-grok46-responses:2, providers/deepseek-reasoning-replay:10, providers/deepseek-inbound-wire:21, adapters/openai/openai-chat-model-suffix:3, adapters/routed-agent-messages:2, adapters/exec-tool-result-normalize:2, adapters/anthropic/anthropic-thinking-signature:12 과 317(동적 import), providers/xai/xai-web-search-compat:2. 전부 facade 재노출로 해결되고, named import 를 쓰는 파일(deepseek-reasoning-replay 의 sanitizeReasoningInputContent, chat-responses-control-scope 의 stripCanonicalForwardSamplingParams, responses-routed-web-search-fields 의 stripOpenAiOnlyWebSearchFields, codex-metadata-integrity 와 anthropic-thinking-signature 등의 FORWARD_HEADERS)도 표면 변화가 없어 깨지지 않는다.
- src 내부 소비자(무수정): index.ts:9, web-search/executor.ts:2, codex/auth-context.ts:60, server/chat-completions.ts:8, server/ws-bridge.ts:3, server/claude-messages.ts:9, vision/describe.ts:3, server/responses/compact.ts:11, server/responses/core.ts:44, server/responses/collaboration.ts:13, server/responses/encrypted-payload.ts:10, lab/conformance/executor.ts:2. providers/openai-tiers*.ts 의 openai-responses-url import 는 다른 모듈이라 오탐 제외.
- structure/ (파일:행 — 판정): runtime.md:178 테이블 행, 파사드 경로 유지로 유효, 리프 요구 보강 권장. runtime.md:419 동작 서술, 유효. data-planes/inbound-compat.md:290 파사드 경로 서술, 유효. subagents.md:12 유효. transports/byte-accounting.md:25 appendedUtf8Bytes 서술, 유효(passthrough 리프). transports/inventory.md:19 유효. adapters/registry.md:21, data-planes/images.md:21·43·76, transports/responses.md:107·152·220·310, adapters/compatibility-contracts.md:10·18(다른 파일 src/compatibility/openai-responses.ts), decisions/ADR-0061:9 는 어댑터 id 또는 타 파일 언급이라 무관. structure/manifest.json 과 INDEX.md 에는 이 파일명이 없다(rg 0건).
- tests/ 안의 openai-responses 문자열은 총 1,156회(rg -o | wc -l)이지만 대부분 어댑터 id 문자열이다. 파일 참조는 위에 열거한 것으로 전부다.

## 검산

- 심볼 2,163줄(리프 합) + 이동 주석·빈 줄 419줄 + 헤더 1-45 = 2,627 = wc -l. 파사드는 이동분을 갖지 않는다.
- 리프 10개 + 파사드 1개. 새 트리 총 줄수는 import 분할로 2,627보다 소폭 늘어나며 정확한 값은 실행 후 wc -l 로 확정(현재 미측정).

## 측정 명령 목록

- wc -l src/adapters/openai-responses.ts → 2627
- rg -n '^(export |declare )?(async |abstract )?(function|class|const|let|var|type|interface|enum)[[:space:]]' 대상 파일 → 83선언
- awk 괄호·중괄호·대괄호 깊이 추적(위 시작행 입력, SYM/GAP/TOTAL 출력) → 끝행·줄수·covered 2163·uncovered 464·OVERLAP 0
- awk NR 구간 출력: 43-75, 310-376, 1489-1618, 1865-1937, 2250-2312(대상 파일), 테스트·baseline·가드 파일 구간
- rg -n '심볼 83개 alternation' 대상 파일 → 호출 그래프와 어댑터 호출 행(2213-2400)
- rg -n 'import 식별자 52개 alternation' 대상 파일 → 소비 리프 판별
- rg -n 'import\(' 대상 파일 → 0건
- rg -n 'openai-responses\.ts' tests/ → 3건, rg -n 'adapters/openai-responses' tests/ src/ gui/ docs-site/ → 위 목록, rg -o 'openai-responses' tests/ | wc -l → 1156
- rg -c 'isPlainObject' 대상 파일 → 135, rg -n 'openai-responses' structure/ 및 structure/manifest.json INDEX.md
- git log --oneline -3, git show --stat --oneline 0eab3851a5, ls tests/ci-workflows/, ls devlog/_plan

