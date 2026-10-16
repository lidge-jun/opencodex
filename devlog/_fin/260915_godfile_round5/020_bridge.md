# Godfile Round 5 · wp3 — src/bridge.ts 분해 계약서

대상은 `src/bridge.ts` 2,206줄이다(`wc -l` 실측). 방식은 순수 이동 하나다. 함수 본문을 한 줄도 고치지 않고 지정한 라인 범위를 새 리프로 옮기고, 파사드 `src/bridge.ts`는 origin/dev와 동일한 export 6개를 재노출한다. 이 문서의 모든 숫자는 본 워크트리 HEAD에서 rg·sed·awk·wc로 잰 값이며, 측정 명령은 §10에 있다.

## 1. 이동 확정표

| 원본 라인 | 내용 | 줄 수 | 리프 |
| --- | --- | --- | --- |
| 1-45 | import 16개 선언 | 45 | §3대로 리프별 재분배 |
| 47-49 | uuid | 3 | internal |
| 51-56 | 예산 상태(주석 51, let 52, const 53, 세터 54-56) | 6 | sse |
| 58-60 | sseEvent | 3 | sse |
| 62-64 | isRecord | 3 | internal |
| 66-128 | responsesUsage | 63 | internal |
| 130-132 | responseError | 3 | sse |
| 134-150 | toolCallArgumentsUsable(주석 134-139 포함) | 17 | internal |
| 152-169 | adapterFailureFromEvent | 18 | internal |
| 171 | re-export `export { adapterFailureFromMessage } from "./lib/errors";` | 1 | 파사드 원문 유지 |
| 173-197 | webSearchAction(주석 173-193 포함, 닫는 `}` 197) | 25 | internal |
| 199-203 | interface OutputItem | 5 | internal |
| 205 | export type ResponsesTerminalStatus | 1 | sse |
| 207-211 | interface StringChunks(주석 207 포함) | 5 | internal |
| 212 | emptyChunks | 1 | internal |
| 213 | joinChunks | 1 | internal |
| 215-1601 | bridgeToResponsesSSE(끝 `}` 1601, awk 실측) | 1,387 | sse |
| 1603-1617 | buildResponseJSON | 15 | response-json |
| 1619-2180 | buildResponseJSONWithBudget(끝 `}` 2180, awk 실측) | 562 | response-json |
| 2182-2206 | formatErrorResponse | 25 | errors |

빈 줄 46, 50, 57, 61, 65, 129, 133, 151, 170, 172, 198, 204, 206, 214, 1602, 1618, 2181(17행)은 옮기지 않는다. 합계 검증: 이동 2,143(=1,400+141+577+25) + 파사드 잔류 63(=import 45 + 171행 1 + 빈 줄 17) = 2,206.

## 2. 심볼 사용처 실측과 배치

사용처 수는 구간별 `rg -o '\b<심볼>\b' | wc -l` 카운트고 정의 행을 포함한다. S=215-1601, J=1603-2180, E=2182-2206. 배치 규칙은 "두 리프 이상에서 쓰이면 internal"이다.

| 심볼 | 정의 | S | J | E | 리프 |
| --- | --- | --- | --- | --- | --- |
| uuid | 47 | 11 | 11 | 0 | internal |
| sseEvent | 58 | 2 | 0 | 0 | sse |
| isRecord | 62 | 0 | 0 | 0 | internal — responsesUsage 본문 전용(정의 구역 매칭 3 = 정의+본문 2) |
| responsesUsage | 66 | 6 | 1 | 0 | internal |
| responseError | 130 | 3 | 0 | 0 | sse |
| toolCallArgumentsUsable | 140 | 1 | 1 | 0 | internal |
| adapterFailureFromEvent | 152 | 2 | 1 | 0 | internal |
| webSearchAction | 194 | 1 | 1 | 0 | internal |
| OutputItem | 199 | 13 | 4 | 0 | internal |
| ResponsesTerminalStatus | 205 | 2 | 0 | 0 | sse |
| StringChunks | 208 | 7 | 3 | 0 | internal |
| emptyChunks | 212 | 8 | 9 | 0 | internal |
| joinChunks | 213 | 6 | 4 | 0 | internal |
| setOwnedBudgetAbandonedMsForTests | 54 | 0 | 0 | 0 | sse — 상태 52·53과 동행, 유일 읽기 340행 |
| formatErrorResponse | 2182 | 0 | 0 | 1 | errors — 파일 내부 사용처 없음, export 전용 |

제안 골격과 다른 세 결정: sseEvent는 sse 전용이라 sse로 가고, responseError도 sse 전용(S=3, J=0)이다. adapterFailureFromEvent는 리프 두 곳에서 쓰이므로 internal로 보낸다. errors.ts는 formatErrorResponse 하나뿐이다(25줄).

## 3. 리프별 import(원본 1-45 재분배, ./x → ../x)

원본 지정자는 전부 ./ 형태다. ../·../../ 케이스는 없고 인라인 동적 import()도 0건이다(rg 실측). 괄호 안은 리프 구역 매칭 수이고 0인 이름은 뺐다.

| 리프 | 변환 후 지정자 | 이름(실측 매칭 수) |
| --- | --- | --- |
| sse | ../types | AdapterEvent(2) OcxMessagePhase(2) OcxProviderContinuationState(1) OcxProviderOpaqueToolCallMetadata(1) OcxReasoningReplayScopeRef(1) OcxUsage(1) declaresCodeModeExec(1) normalizeDeclaredToolName(1) |
| sse | ../lib/errors | classifyError(1, 131행) isCyberPolicyCode(2) OcxErrorPayload(1, 130행 시그니처) |
| sse | ../lib/redact | redactSecretString(1) |
| sse | ../lib/tool-argument-integers | coerceIntegerToolArguments(1) |
| sse | ../lib/translator-budget | isTranslatorBudgetExceededError(4) createTranslatorBudget(1) TranslatorBudget(1) TranslatorBufferKind(5) |
| sse | ../responses/apply-patch-envelope | mayBecomePatchEnvelope(1) repairFreeformToolInput(1) |
| sse | ../responses/compaction | encodeCompactionSummary(1) |
| sse | ../responses/code-mode-helper-compat | compileCodeModeHelperInput(1) resolveCodeModeHelperName(1) |
| sse | ../responses/truncated-stop-reason | isTruncatedStopReason(3) truncationReasonFor(2) |
| sse | ../responses/reasoning-envelope | encodeReasoningEnvelope(4) ReasoningEnvelope(1) |
| sse | ../responses/reasoning-replay-cache | rememberReasoningForCall(1) |
| sse | ../responses/thought-signature-replay | rememberAndSerializeExtraContent(2) rememberExtraContentForReplay(2) awaitThoughtSignatureDurability(5) |
| sse | ../responses/citation-markers | createCitationMarkerFilter(1) stripCitationMarkers(1) CitationMarkerFilter(1) |
| sse | ../stall-timeout | resolveStallTimeoutSec(1) |
| sse | ../web-search/sources | appendSafeWebSearchSource(1) safeWebSearchSources(1) |
| sse | ./internal | uuid isRecord responsesUsage toolCallArgumentsUsable adapterFailureFromEvent webSearchAction OutputItem StringChunks emptyChunks joinChunks |
| response-json | ../types | AdapterEvent(4) OcxMessagePhase(2) OcxProviderContinuationState(1) OcxProviderOpaqueToolCallMetadata(1) OcxReasoningReplayScopeRef(1) OcxUsage(2) normalizeDeclaredToolName(1) |
| response-json | ../lib/errors | isCyberPolicyCode(1) |
| response-json | ../lib/tool-argument-integers | coerceIntegerToolArguments(1) |
| response-json | ../lib/translator-budget | releaseTranslatedEvent(3) createTranslatorBudget(1) TranslatorBudget(1) TranslatorBufferKind(4) |
| response-json | ../responses/apply-patch-envelope | repairFreeformToolInput(1) |
| response-json | ../responses/compaction | encodeCompactionSummary(1) |
| response-json | ../responses/code-mode-helper-compat | compileCodeModeHelperInput(1) resolveCodeModeHelperName(1) |
| response-json | ../responses/truncated-stop-reason | isTruncatedStopReason(2) truncationReasonFor(1) |
| response-json | ../responses/reasoning-envelope | encodeReasoningEnvelope(3) ReasoningEnvelope(1) |
| response-json | ../responses/reasoning-replay-cache | rememberReasoningForCall(1) |
| response-json | ../responses/thought-signature-replay | rememberAndSerializeExtraContent(1) rememberExtraContentForReplay(1) |
| response-json | ../responses/citation-markers | stripCitationMarkers(1) |
| response-json | ../web-search/sources | appendSafeWebSearchSource(1) safeWebSearchSources(1) |
| response-json | ./internal | uuid responsesUsage toolCallArgumentsUsable adapterFailureFromEvent webSearchAction OutputItem StringChunks emptyChunks joinChunks |
| errors | ../lib/errors | classifyError(1) cyberPolicyErrorType(1) CYBER_POLICY_ERROR_CODE(3) isCyberPolicyCode(1) |
| internal | ../types | AdapterEvent(1, 152행) OcxUsage(1, 66행) |
| internal | ../lib/errors | adapterFailureFromMessage(2) classifyError(1) cyberPolicyErrorType(1) CYBER_POLICY_ERROR_CODE(1) isCyberPolicyCode(2) OcxErrorPayload(1) |
| internal | ../lib/redact | redactSecretString(1) |
| internal | ../usage/totals | usageDisplayTotalTokens(1) |

빠진 이름은 매칭 0 실측이다. sse는 releaseTranslatedEvent(J 전용)를 가져오지 않고, response-json은 mayBecomePatchEnvelope·awaitThoughtSignatureDurability·resolveStallTimeoutSec·createCitationMarkerFilter·CitationMarkerFilter·declaresCodeModeExec·isTranslatorBudgetExceededError·redactSecretString·classifyError를 가져오지 않는다.

## 4. sse.ts 크기와 본문 분할 금지

sse로 모이는 본문은 1,400줄(6+3+3+1+1,387)이고 import가 더해진다. bridgeToResponsesSSE(215-1601) 본문을 이번 라운드에 쪼개지 않는다. 근거는 순수 이동 원칙과 함수 구조다. 예산 watchdog 지연(340행, ownedBudgetAbandonedMs 읽기), disposeOwnedBudget(334행 정의, 454·929·1518·1563·1576·1598행 호출), 툴 인자 버퍼, web-search 보류 해제가 한 클로저의 지역 상태를 공유하므로 범위를 자르는 순간 상태 재배치가 강제된다. 다음 라운드 참고 수치: S 구간 줄두 let 선언 39개, `\blet\b` 토큰 42개(주석·인라인 포함). 이 상태 경계 분석이 끝난 뒤에 내부 분할을 논의한다.

## 5. 파사드 최종 형태

export 6개 실측 위치: 54(setOwnedBudgetAbandonedMsForTests), 171(adapterFailureFromMessage re-export), 205(ResponsesTerminalStatus), 215(bridgeToResponsesSSE), 1603(buildResponseJSON), 2182(formatErrorResponse). 파사드 `src/bridge.ts`는 아래 6줄만 남긴다.

```ts
export { setOwnedBudgetAbandonedMsForTests } from "./bridge/sse";
export type { ResponsesTerminalStatus } from "./bridge/sse";
export { bridgeToResponsesSSE } from "./bridge/sse";
export { buildResponseJSON } from "./bridge/response-json";
export { formatErrorResponse } from "./bridge/errors";
export { adapterFailureFromMessage } from "./lib/errors";
```

171행은 ./lib/errors 지정자를 그대로 유지한다(파사드 위치가 src/bridge.ts로 불변). internal.ts는 같은 함수를 ../lib/errors에서 직접 가져온다(§3). buildResponseJSONWithBudget는 export가 아니므로 response-json.ts 안에 비공개로 남고 1610·1613행 호출도 같은 파일로 함께 이동한다. ResponsesTerminalStatus는 리프에서 export type으로 선언해 파사드 re-export가 타입 자리를 유지한다(src/server/index.ts:103의 type 수입 실측).

## 6. 상대 지정자 변환 규칙

리프는 src/bridge/ 한 단계 아래에 둔다. 변환은 ./x → ../x가 전부다. 라운드 2 결함(../config가 없는 src/codex/config를 가리켜 샤드 전체 import 단계 실패)의 재발 방지로, 각 리프 저장 직후 §3 지정자와 실제 파일 경로를 한 행씩 대조하는 확인을 실행 라운드가 수행한다. 리프 간 참조는 sse·response-json·errors → ./internal 한 방향이고 internal은 ../lib/*·../types·../usage/totals만 보므로 순환이 없다.

## 7. structure grace 처리

structure/manifest.json 390-391행 실측 인용:

```json
        "path": "src/bridge.ts",
        "reason": "no doc names this file; it is the legacy adapter bridge entry and its behavior is described under the adapter registry without a path reference"
```

scripts/structure-ssot.ts 규칙(495-535행 실측): grace 경로는 트리에 실재해야 하고(506행 fail), described와 grace 동시 등록이면 fail한다(507-508행). src 영역은 tracked 경로에서 수집되며(515-527행) 파일은 src/<파일>, 디렉터리는 src/<디렉터리>/ 단위다. 어느 쪽에도 없는 영역은 fail한다(530행).

분해 후 처리. 파사드 src/bridge.ts는 실재하므로 기존 grace 항목은 506행을 통과한다. reason의 "legacy adapter bridge entry"는 사실이 아니게 되므로 facade-only 사실로 갱신한다. src/bridge/는 새 영역이라 530행에 걸리며, grace 등록 대신 소유 문서 documents 목록에 src/bridge/를 추가해 claim한다. 이중 등록은 507-508행 충돌을 낸다. claim 위치는 grace reason이 가리키는 adapter registry 문서이고 INDEX.md 97행 실측 기준 structure/adapters/registry.md가 후보다(manifest docs 배열의 정확한 소유는 실행 라운드가 확인). INDEX.md는 생성물이므로 bun run structure:index 재생성과 structure:check 통과를 실행 라운드 게이트로 남긴다.

## 8. 동반 수정

참조 실측: tests/ src/에서 매칭 83행, 그중 리프 경로 import 29행, src/index.ts:3 파사드 re-export 1행, 나머지 53행은 주석과 픽스처 표기다. 파사드가 export 표면을 유지하므로 import 29행과 re-export는 한 곳도 고치지 않는다.

재지정이 필요한 두 지점:

- 소스 오라클 tests/lib/reasoning-replay-scope-source.test.ts. 32행 source("bridge.ts")가 277행(S)과 1642행(J)의 const replayCacheScope = options?.replayCacheScope; 2건을 한 파일에서 센다(34행 toHaveLength(2)). 분해 후 0건이 되어 34행이 실패하고 37행 not.toContain 부정 검사는 아무것도 검사하지 않는다. 재지정: 32행을 source("bridge/sse.ts")와 source("bridge/response-json.ts") 두 읽기로 바꾸고, 34행을 리프당 toHaveLength(1) 두 검사로 쪼개며, 부정 검사는 결합 문자열에 유지한다.
- 픽스처 tests/fixtures/file-size-baseline.json 22행 "src/bridge.ts": 2206. 래칫(scripts/file-size-ratchet.ts)은 SHRANK를 통과시키고(93행 offender는 NEW_OVERSIZED·GREW만, 테스트 87행 "줄면 통과") 베이스라인에 없는 새 파일은 2,000줄 이상일 때만 NEW_OVERSIZED다. 리프 이동분 최대인 sse 1,400+import는 2,000 미만이라 새 베이스라인 행이 필요 없고, 파사드 급감은 SHRANK로 통과하며 --update는 캡을 내리기만 한다.

주석 경로 표기 9곳은 빌드 영향이 없고 같은 PR에서 갱신한다. responsesUsage 지칭 3곳(src/chat/outbound.ts:51, src/server/request-log.ts:156, src/usage/log.ts:87)은 src/bridge/internal.ts로, 스트리밍 동작 지칭 3곳(src/web-search/passthrough-bridge.ts:1007, src/server/responses/core.ts:5565, src/server/responses-custom-tool-repair.ts:343)은 src/bridge/sse.ts로, declaredToolNames 옵션 지칭 2곳(src/server/responses-undeclared-tool-guard.ts:619, tests/responses/responses-undeclared-tool-guard.test.ts:5)은 양쪽 리프에 계약이 있으므로(sse 6건·response-json 5건 실측) 두 경로를 함께 적고, 일반 지칭 1곳(src/server/responses-snapshot-repair.ts:10)은 파사드 또는 리프 표기로 바꾼다.

## 9. 검증 게이트(실행 라운드)

이 문서 단계에서는 bun과 테스트를 실행하지 않았다(위임 범위 규칙). 실행 라운드 게이트: bun run structure:check, bun test tests/lib/reasoning-replay-scope-source.test.ts tests/ci-workflows/file-size-ratchet.test.ts tests/adapters/bridge.test.ts, bun run test:changed, PR 준비 시 bun run typecheck과 bun run test.

## 10. 측정 명령

```
wc -l src/bridge.ts
sed -n '1,214p' src/bridge.ts
rg -n '^(export )?(async )?function |^(export )?(type|interface) |^(export )?const ' src/bridge.ts
rg -n '^export' src/bridge.ts
awk 'NR>=1599&&NR<=1604{print NR": "$0}' src/bridge.ts
awk 'NR>=1615&&NR<=1620{print NR": "$0}' src/bridge.ts
awk 'NR>=2178&&NR<=2183{print NR": "$0}' src/bridge.ts
sed -n '<구간>' src/bridge.ts | rg -o '\b<심볼>\b' | wc -l
  # 구간: 47-49, 51-60, 62-128, 130-132, 134-169, 173-213, 205, 215-1601, 1603-2180, 2182-2206
  # 심볼: §2 표 15개 + ownedBudgetAbandonedMs + declaredToolNames + import 이름 41개(§3)
awk 'NR>=215&&NR<=1601' src/bridge.ts | rg -c '^\s*let\b'
awk 'NR>=215&&NR<=1601' src/bridge.ts | rg -o '\blet\b' | wc -l
rg -n 'import\(' src/bridge.ts
rg -n 'ownedBudgetAbandonedMs|disposeOwnedBudget|setOwnedBudgetAbandonedMsForTests' src/bridge.ts
rg -n 'replayCacheScope' src/bridge.ts
rg -n 'from "(\.\.?/)+bridge"|src/bridge' tests/ src/ | wc -l
rg -n 'import .* from "(\.\.?/)+bridge"' tests/ src/ | wc -l
rg -n 'bridge\.ts' tests/
awk 'NR>=386&&NR<=396{print NR": "$0}' structure/manifest.json
sed -n '495,535p' scripts/structure-ssot.ts
sed -n '1,90p' scripts/file-size-ratchet.ts
rg -n 'SHRANK|GREW|NEW_OVERSIZED' tests/ci-workflows/file-size-ratchet.test.ts
```
