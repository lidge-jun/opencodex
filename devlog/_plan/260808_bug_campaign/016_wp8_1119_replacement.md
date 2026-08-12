# 016 — WP8: #1119 대체 회귀 테스트 (close 선행조건)

감사가 "#1119를 그냥 닫으면 커버리지를 잃는다" 고 지적했고, 그 대체본을 만들었다.

브랜치 `codex/260808-1100-custom-optin-contract`, 커밋 `8bde6c422`
(리베이스 후. 이전 `09e95ebb2` → `00ecc61ea` → 현재).
`Co-authored-by: bitkyc08-arch <bitkyc08@gmail.com>`

## 커버리지 공백 확인

현재 dev의 `tests/codex-catalog.test.ts` 에 있는 것:

| 위치 | 덮는 것 |
|---|---|
| `:2351` (#323) | 커스텀 프로바이더의 명시적 **`false`** opt-out |
| `:2371` (#538) | `modelReasoningSummaryDelivery` 경로 |
| `:2391` (#1100) | **내장 레지스트리** 행의 effort ladder와 summary 지원 |
| `:2454~` | destination enrichment, 저장 설정 미오염 |

없는 것: **커스텀 프로바이더의 명시적 `true` opt-in이 템플릿 경로를 통과하는지.**

결정적으로 `#323`과 `#538` 테스트는 둘 다 `buildCatalogEntries(null, ...)` 을
쓴다. 이는 폴백 분기(`src/codex/catalog/sync.ts:291~`)이며 **routed strip을 아예
실행하지 않는다.** 따라서 순서 회귀가 나도 두 테스트는 계속 통과한다.

## 무엇이 위험한가

`src/codex/catalog/sync.ts:266-269`:

```ts
applyReasoningLevels(e, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
normalizeRoutedCatalogEntry(e, model?.parallelToolCalls === true);   // flag를 지운다
if (model) applyCatalogMetadata(e, model.provider, model.id, model.contextCap);
applyCatalogModelMetadata(e, model);                                  // flag를 되살린다
```

opt-in은 **뒤의 호출이 앞의 삭제를 되돌리기 때문에만** 살아남는다. 순서를
뒤집으면 opt-in한 모든 라우팅 프로바이더가 Codex로부터 `reasoning.effort` 를
조용히 못 받게 되고, 그동안 picker는 effort ladder를 계속 표시한다. 이것이
#1100의 원래 증상이다.

## 추가한 테스트 3개

`tests/codex-catalog.test.ts` 의 #538 테스트 뒤에 삽입.

1. **`routed strip does not defeat an explicit custom-provider summary opt-in`**
   — `nativeTemplate()` 을 넘겨 템플릿 경로를 타고, ladder와
   `supports_reasoning_summaries: true` 를 함께 확인
2. **`custom routed rows without an opt-in stay conservative`** — opt-in이 없으면
   `false` 유지. 임의 엔드포인트에 OpenAI 전용 summary 전달을 주장하지 않는
   의도적 보수성을 못박는다
3. **`the no-template fallback never applies the routed summary strip`** — 폴백
   경로가 strip을 건너뛴다는 비대칭 자체를 명시. 두 경로를 통합할 때 눈에 보이게

## 활성화 증거 (C-ACTIVATION-GROUNDING-01)

통과만으로는 회귀를 잡는지 알 수 없다. 순서를 실제로 뒤집어 확인했다.

```
ABLATION: order swapped (strip now runs AFTER metadata)
(fail) routed strip does not defeat an explicit custom-provider summary opt-in (#1100)
(fail) built-in DeepSeek and GLM effort models opt into Codex reasoning propagation (#1100)
 6 pass, 2 fail
```

되돌린 뒤:

```
 8 pass, 0 fail
```

새 테스트가 순서 회귀를 잡는다. 나머지 두 테스트(보수성, 폴백)는 ablation에서도
통과하는데, 그것들은 순서가 아니라 다른 계약을 지키므로 정상이다.

## 검증

```
$ bun test tests/codex-catalog.test.ts
 132 pass, 0 fail, 600 expect() calls

$ bun run typecheck
(clean)
```

## 리뷰 반영
독립 리뷰가 ablation을 재현해 확인했다(전체 파일 130 pass / 2 fail, 복구 후
132 pass). 블로커 1건은 주석의 휘발성 라인 번호였다 — `:2391` 과
`sync.ts:266-269` 는 이미 어긋나 있었다. 라인 번호 대신 테스트 이름과 함수명으로
가리키도록 고쳤다. 리팩터링에도 주석이 유효하게 남는다.

## 리베이스 재검증 (dev 이동 대응)

검증 도중 dev가 `fdc47db7b` 에서 `517f44604` 로 이동했다. `003` 프로토콜대로
`git rebase --onto origin/dev` 후 **검증을 처음부터 다시 돌렸다** — 낡은 base의
결과는 증거가 아니다.

새 base 결과:

```
$ bun test tests/codex-catalog.test.ts     132 pass / 0 fail
$ bun run typecheck                        clean
$ (ablation) 순서 뒤집기                    6 pass / 2 fail
$ (복구 후)                                8 pass / 0 fail
```

diff 범위는 그대로 `tests/codex-catalog.test.ts` 한 파일 83줄이며,
`Co-authored-by` 트레일러도 리베이스를 통과했다.

## #1119 처분에 미치는 영향

감사가 건 조건("대체본 착지 후에만 close")의 코드 부분이 준비됐다. 남은 것:

1. 이 브랜치를 PR로 열어 착지 — **push/PR 생성은 사용자 승인 필요**
2. 착지 후 #1119를 superseded로 close하며 이 PR 링크
3. #1119의 devlog 16문서 중 보존 가치 있는 것 큐레이션 (25항목 grade matrix,
   provenance/isolation 설계, attribution/lease 기록)

테스트 자체는 원작자 트레일러를 달았다. 계약을 발견하고 문서화한 것은 #1119의
작업이며, 우리는 그것을 현재 dev 위로 옮겼을 뿐이다.
