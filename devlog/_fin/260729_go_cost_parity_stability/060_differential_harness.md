# 060 — work-phase 6: TS 오라클 대 Go 차등 테스트 하네스

근거: `003`의 방법론 메모 — "앞으로 파리티 감사는 함수 대조와 별개로 응답 바이트를
비교해야 한다." W1(JSON 키 대소문자)이 정적 함수 대조로 안 잡힌 이유가 그것이다.

## 문제

`010`~`050`은 각각 자기 결함을 고치지만, **다음 결함이 같은 방식으로 조용히 살아남는 것**을
막지 못한다. `260729_go_port_blindspot_sweep/000_findings.md`가 이미 기록한 패턴이다:
파리티 스위트가 통과한 건 맞아서가 아니라 **보지 않아서**였다.

비용 경로에는 지금 차등 테스트가 없다. Go 테스트(`cost_test.go`, `tier_cost_test.go`)는
Go의 기대값을 Go로 검증할 뿐, TS가 같은 값을 내는지는 아무도 확인하지 않는다.

## 설계: 픽스처 기반 차등

프로세스 간 실시간 비교는 CI에서 취약하다(bun 런타임 의존, 순서 의존). 대신 **고정 픽스처**를 쓴다.

```
tests/fixtures/cost-parity/cases.json      <- 입력 케이스 (양쪽이 읽음)
tests/fixtures/cost-parity/expected.json   <- TS가 생성한 기대 출력 (오라클 산출물)
```

흐름:

1. TS 생성기가 `cases.json`의 모든 입력을 `estimateRequestCost`/`estimateComboCost`에
   넣고 결과를 `expected.json`으로 **직렬화**한다. 이게 오라클의 서명이다.
2. Go 테스트가 같은 `cases.json`을 읽어 `EstimateCostWithTier`를 돌리고,
   **마셜된 JSON 바이트**를 `expected.json`과 비교한다.
3. 불일치는 키 이름·값·존재 여부 어디서든 실패로 잡힌다.

바이트 비교가 핵심이다. 구조체 필드를 하나씩 비교하면 W1처럼 **키 이름이 다른** 결함을
또 놓친다.

## 파일 변경 지도

| 파일 | 종류 | 내용 |
| --- | --- | --- |
| `tests/fixtures/cost-parity/cases.json` | NEW | 입력 케이스 (아래 커버리지) |
| `scripts/generate-cost-parity-fixture.ts` | NEW | TS 오라클로 `expected.json` 생성 |
| `tests/fixtures/cost-parity/expected.json` | NEW (생성물) | 오라클 기대 출력 |
| `go/internal/usage/parity_diff_test.go` | NEW | Go 측 차등 검증 |
| `tests/cost-parity.test.ts` | NEW | TS 측: 픽스처가 최신인지 확인 |

## 케이스 커버리지

`001`의 G1~G11 전부가 케이스로 존재해야 한다. 최소 집합:

| 부류 | 케이스 |
| --- | --- |
| jawcode 정확 | `openai`/`gpt-5.6-sol`, `anthropic`/`claude-sonnet-5` |
| 오버레이 verified | `deepseek`/`deepseek-chat`, `minimax`/`MiniMax-M2.1-highspeed` |
| 오버레이 derived | `anthropic`/`claude-opus-5`, `kiro`/`claude-opus-5` |
| 벤더 폴백 | `kiro`/`claude-opus-4.6` (점 정규화), `cursor`/`claude-sonnet-4-6` |
| 가격 없음 | `no-such-provider`/`no-such-model` |
| 0 가격 jawcode | `zai`/`glm-4.7` (0행 → 오버레이 폴백 경로) |
| 캐시 zero-vs-null | `050`의 A~D 4종 |
| 티어 | `openai`/`gpt-5.5` × {standard, priority}, `chatgpt`/`gpt-5.5`/priority |
| 콤보 | 2-attempt 성공, 1-attempt 무가격(fail-closed), 빈 attempts |
| 프로바이더 접미사 | `kimi-code-pabcdef`, `google-antigravity-p442fff`, `openai-main` |
| antigravity 정규화 | wire id → canonical |

각 케이스는 `{id, provider, model, usage, usageStatus, serviceTier, attempts?}` 형태다.

## 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

이 사이클의 산출물은 검증 장치 자체다. 장치가 **실제로 결함을 잡는지** 증명해야 한다.

트리거: 의도적으로 결함을 주입한 상태에서 하네스를 돌린다.
관찰: 하네스가 **실패**하는지 확인.

주입 실험 3종(구현 중 임시로 되돌려 확인하고, 확인 후 복구):

1. `CostBreakdown`의 `json:"total"` 태그를 제거 → 하네스가 실패해야 한다(W1 재현).
2. `resolveExact`의 벤더 폴백 단계를 제거 → `kiro`/`claude-opus-4.6` 케이스가 실패해야 한다.
3. `NormalizeCostTokens`를 zero-check로 되돌림 → A·B 케이스가 실패해야 한다.

세 실험이 전부 실패를 내야 하네스가 살아 있다고 말할 수 있다. 하나라도 통과하면
그 부분은 **여전히 보지 않는 사각지대**다. 이 실험 결과를 D 요약에 기록한다.

## 픽스처 최신성

`expected.json`이 낡으면 하네스가 낡은 계약을 고정한다. 방지:

- `tests/cost-parity.test.ts`가 픽스처를 **재생성해서** 커밋본과 바이트 비교한다.
  다르면 실패 — TS 동작이 바뀌었는데 픽스처를 안 갱신한 상태를 잡는다.
- CI가 `bun run generate:cost-parity && git diff --exit-code tests/fixtures/`를 돈다.

## 테스트

```bash
bun run scripts/generate-cost-parity-fixture.ts
bun test tests/cost-parity.test.ts
cd go && go test ./internal/usage/ -run Parity -count=1 -v
cd go && go build ./... && go vet ./... && go test ./... -count=1
```

## 위험

- **부동소수 표기 차이.** JS `0.29590099999999997`와 Go `strconv.FormatFloat(.., 'g', -1, 64)`가
  다르게 찍힐 수 있다. 바이트 비교 전에 양쪽을 `map[string]any`로 파싱해 숫자는
  상대오차 1e-12로 비교하고, **키 집합은 정확 비교**한다. 키 비교가 이 하네스의 목적이므로
  거기서는 관용을 두지 않는다.
- 케이스가 늘면 픽스처가 커진다. 케이스당 한 줄 JSONL로 두면 diff가 읽힌다.
- `no-such-provider` 같은 케이스는 라이브 로그에 실제로 존재한다(`003`의 `/api/usage` 응답에
  `no-such-model`/`unpriced-model` 행이 보인다). 테스트 데이터가 프로덕션에 섞여 있다는
  뜻이므로, 픽스처 이름은 그와 충돌하지 않게 고른다.

## 완료 기준

3종 주입 실험이 전부 하네스 실패를 유발하고, 정상 상태에서 전체 케이스가 통과하며,
픽스처 최신성 검사가 초록이다.
