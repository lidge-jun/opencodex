# 000 — Go 런타임 비용 회계 파리티와 요청 경로 안정화

브랜치 `dev2-go`, 기준 커밋 `bb5aa976e`, 작성 2026-07-29.
세션 `019fad7e-f1cb-7972-b716-0430ee4cacce`, HOTL PABCD 루프, 목표 work-phase 10개 이상.

## 목표

두 가지다. 하나는 Go 런타임이 TypeScript 오라클과 **같은 값**을 계산하게 만드는 것이고,
다른 하나는 요청 경로를 CLIProxyAPI보다 확실히 안정적으로 만드는 것이다.

비용 회계가 먼저인 이유는 단순하다. 지금 Go 런타임은 대시보드에 **틀린 돈**을 보여준다.
틀렸다는 것은 추정이 부정확하다는 뜻이 아니라, 오라클이 `$5.00`이라고 계산하는 요청을
Go가 `price_unmatched`로 처리하거나 캐시 토큰을 잘못 귀속해 `$0.000017` 같은 다른 숫자를
내놓는다는 뜻이다. 사용자는 어느 쪽이 맞는지 알 방법이 없다.

## 측정된 현재 상태

### 비용

`src/generated/jawcode-model-metadata.ts`에는 15개 프로바이더 번들에 724개 모델 행이 있고
그중 **652개가 0이 아닌 가격**을 갖는다(측정 명령은 `001`). Go에는 이 번들이 **존재하지 않는다**.

```
$ find go -name '*jawcode*'
(출력 없음)
```

Go의 가격 해석기 `FindPrice`(`go/internal/usage/prices.go:101`)는 48행짜리
`ExpectedPriceOverlays` 로스터만 훑는다. TS의 해석 순서는 4단계인데(`src/usage/cost.ts:139-145`)
Go는 그중 2단계만 갖고 있다.

| 단계 | TS | Go |
| --- | --- | --- |
| 1. jawcode 정확 매치(프로바이더 번들) 0 아님 | `src/usage/cost.ts:190-202` | 없음 |
| 2. 오버레이 verified | `src/usage/expected-prices.ts:136-143` | `prices.go:105-112` |
| 3. 오버레이 verified-derived | 같은 곳 | `prices.go:113-119` |
| 4. jawcode 모델 단위 벤더 폴백(크로스 프로바이더) | `src/usage/cost.ts:221-235` | 없음 |

즉 `openai/gpt-5.6-sol` 요청 1M 입력 토큰은 TS에서 `$5.00`, Go에서 가격 없음이다.
`kiro/claude-opus-4.6`은 TS가 벤더 폴백으로 `$5.00`을 내지만 Go는 아무것도 못 낸다.

### 안정성

예상과 달리 Go 런타임은 이미 상당히 단단하다. 패닉 복구(`go/internal/server/middleware.go:20`),
요청 본문 상한(`responses_core_port.go:124`), 서버 타임아웃(`server.go:697`),
graceful shutdown(`lifecycle.go:93-105`), 429 Retry-After 쿨다운
(`providers/key_failover.go:26`, `oauth/anthropic_pool.go:419`)이 전부 있다.

비교 대상인 CLIProxyAPI는 오히려 `http.Server`에 `ReadTimeout`/`WriteTimeout`/`IdleTimeout`을
**설정하지 않고**, 저장소 전체에 `MaxBytesReader`가 **하나도 없다**(`002` 참조).
반면 계정 선택 전략, 사전 토큰 갱신 스케줄러, 설정 핫리로드는 CLIProxyAPI가 앞선다.

그래서 이 유닛의 안정성 작업은 "없는 것을 만든다"가 아니라 **남은 네 구멍을 막는다**이다:
업스트림 동시 요청 상한 부재, 일반 SSE 경로의 이벤트별 flush 부재, 업스트림 에러 본문
패스스루의 잔여 유출 위험, `repair.go:65`의 가드 없는 고루틴.

## 제약

- `src/`의 런타임 동작은 바꾸지 않는다. TS는 **오라클**이며 읽기 전용이다.
  생성기 스크립트 추가만 허용한다.
- `go/internal/platform/secrets.go`와 `go/internal/platform/platform_test.go`는
  사용자의 미커밋 작업이다. 건드리지 않는다.
- push/PR/태그/릴리스 없음. 로컬 커밋만.

## work-phase 지도 (의존성 순)

효과 크기가 아니라 **의존 순서**로 잘랐다. 뒤 단계는 앞 단계의 산출물을 소비한다.

| # | 문서 | 유닛 | 의존 |
| --- | --- | --- | --- |
| 0 | `000`–`003` | 문서 전용 사이클: 근거 수집과 로드맵 확정 | — |
| 1 | `010` | 비용 JSON 키 파리티 (프런트엔드 공백 수정) | 0 |
| 2 | `020` | jawcode 가격 번들 생성기 + Go 생성 패키지 | 0 |
| 3 | `030` | jawcode 우선 가격 해석 체인(오버레이·벤더 폴백·source/sourceRef 분리) | 2 |
| 4 | `040` | base provider 정규화 일원화 + 우선순위 티어 게이팅 | 3 |
| 5 | `050` | 토큰 정규화 zero-vs-null 수정(cost + summary) | 1 |
| 6 | `060` | 차등 테스트 하네스: TS 오라클 픽스처 대 Go | 1–5 |
| 7 | `065` | 관리 API 비용 표면 파리티(콤보 집계·attempt별·reason 분류) | 3, 6 |
| 8 | `070` | 업스트림 동시 요청 상한 | — |
| 9 | `080` | 일반 SSE 경로 이벤트별 flush + 연결 끊김 중단 | — |
| 10 | `090` | 업스트림 에러 본문 유출 차단 강화 | — |
| 11 | `100` | `repair.go` 고루틴 가드 + 누수 회귀 테스트 | — |

`030`이 `040`보다 앞서는 이유: `030`의 해석 체인은 `providers.BaseProviderLabel`을
호출하는데, 그 함수는 **이미 존재한다**(`go/internal/providers/label.go:16`).
`040`은 usage 패키지의 자체 `BaseProvider`를 그 함수로 갈아끼우는 작업이므로
`030`을 막지 않는다. 임포트 순환도 없다 — `usage`는 이미 `providers`를 임포트하고
있고(`go/internal/usage/summary.go:7`) 역방향은 없다.

work-phase 1~7은 사슬이다. 8~11은 서로 독립이라 순서를 바꿔도 되지만, 각각은
여전히 자기 PABCD 사이클 하나를 온전히 쓴다.

## 검증

매 사이클 C는 아래를 신선하게 실행하고 출력을 붙인다.

```bash
cd go && go build ./...
cd go && go vet ./...
cd go && go test ./internal/usage/... -count=1
cd go && go test ./... -count=1
```

비용 관련 사이클은 추가로 차등 증거를 요구한다: 같은 입력에 대해 TS와 Go가 같은 숫자를
내는 것을 보여주는 출력. 조건부 경로를 추가하는 사이클은 그 경로가 실제로 발화하는
테스트를 요구한다(C-ACTIVATION-GROUNDING-01). "테스트 전부 통과"만으로는 부족하다.

## 이 문서가 주장하지 않는 것

- 652개 모델 전부가 실제 트래픽에 등장한다는 주장이 아니다. 측정한 것은 카탈로그 크기이고,
  사용자 영향은 "오라클이 가격을 내는 요청에서 Go가 못 낸다"는 형태로만 주장한다.
- CLIProxyAPI가 전반적으로 약하다는 주장이 아니다. 계정 선택 전략과 사전 갱신
  스케줄러는 이쪽이 배울 부분이며 `002`에 그렇게 적었다.
