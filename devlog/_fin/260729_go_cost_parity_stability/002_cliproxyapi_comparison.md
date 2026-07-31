# 002 — CLIProxyAPI 대조: 어디가 앞서고 어디가 뒤지는가

대조 대상: [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
Go로 쓰인 CLI 프록시로, Gemini/Codex/Claude/Qwen 백엔드를 OpenAI·Claude 호환 API로 노출한다.
포지션이 opencodex와 가장 가깝다.

측정일 2026-07-29. 상대 주장은 URL, 이쪽 주장은 `path:line`로 근거를 달았다.

## 가장 중요한 발견: 저쪽은 비용을 계산하지 않는다

CLIProxyAPI에는 **가격 테이블이 없다**. 저장소 전체에서 pricing 모듈이 검색되지 않고,
`usage.Record` 타입에도 `Cost`/`Price`/`USD` 필드가 없다
([usage/manager.go](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/cliproxy/usage/manager.go)).

게다가 **v6.10.0에서 내장 사용량 통계를 제거하고** 서드파티 도구에 위임했다. README는 비용
추정을 외부 CPA-Manager("editable model prices and one-click LiteLLM price sync")로 안내한다
([README](https://github.com/router-for-me/CLIProxyAPI/blob/main/README.md)).
즉 비용 회계는 저쪽의 **의도적 비범위**다.

대신 토큰 회계는 엄격하다. `TokenBreakdown` v2는 입력을 uncached/cache-read/cache-write로,
출력을 non-reasoning/reasoning으로 **상호배타 분해**하고, 하위 버킷 합이 총합과 정확히
맞는지 `Valid()`로 검사하며, 부분 데이터를 `complete`/`inconsistent`/`unclassified`
`Quality` 열거로 **라벨링**한다
([accounting.go](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/cliproxy/usage/accounting.go)).

이 대비가 이 유닛의 방향을 정한다. **비용 회계는 opencodex의 차별점이므로 정확해야 한다.**
지금처럼 오라클과 다른 숫자를 내면 차별점이 아니라 결함이다. 반대로 저쪽의 토큰 품질
라벨링(`Quality` 열거)은 우리가 배울 만하다 — 우리도 `usageStatus`가 있지만 버킷 합
불변식 검사는 없다.

## 우리가 이미 앞선 것

| 메커니즘 | opencodex-go | CLIProxyAPI |
| --- | --- | --- |
| 서버 타임아웃 | `ReadHeaderTimeout 10s`, `ReadTimeout 30s`, `IdleTimeout 2m` (`go/internal/server/server.go:697`) | `http.Server`에 `Addr`/`Handler`만 설정 — 타임아웃 필드 **미설정** ([server.go](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/server.go)) |
| 요청 본문 상한 | `http.MaxBytesReader` (`responses_core_port.go:124`, `sidecar.go:207`), 압축 해제 상한 (`decompress.go:26`) | 저장소 전체에 `MaxBytesReader` **없음**; 로깅용 1MiB/32MiB 캡만 존재 |
| 업스트림 응답 상한 | `io.LimitReader(response.Body, limit+1)` (`responses_core_port.go:1032`) | 미확인 |
| 비용 회계 | 있음(정확도는 `001`의 과제) | **없음**(의도적) |

패닉 복구와 graceful shutdown은 양쪽 다 있다.
우리 쪽은 `recoveryMiddleware`(`go/internal/server/middleware.go:20`, 배선은 `server.go:536`)와
`signal.Notify` + 드레인 타임아웃 `Shutdown`(`lifecycle.go:93-105`, `lifecycle_port.go:114`).
저쪽은 `gin.New()` + `GinLogrusRecovery()`와 `Service.Shutdown(ctx)`.

## 저쪽이 앞선 것 (이번 범위 밖, 후속 후보)

정직하게 적는다. 이 세 가지는 저쪽이 낫다.

1. **계정 선택 전략의 다양성.** RoundRobin / WeightedRoundRobin(smooth WRR) /
   FillFirst 세 가지를 플러그인으로 갖고, 자격증명에 `priority` 속성이 있다
   ([selector.go](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/cliproxy/auth/selector.go)).
   특히 FillFirst는 롤링 윈도우 구독 상한을 어긋나게 하려고 **일부러 한 계정을 소진시킨다** —
   캐시 어피니티를 지키려는 우리 정책과 목적이 다르지만 발상은 참고할 만하다.
2. **사전 토큰 갱신 스케줄러.** 만료 전에 프로바이더별 리드타임으로 갱신하는 min-heap
   스케줄러(5초 주기, 최대 16 동시), 실패 시 5m/1m/30s 백오프
   ([auto_refresh_loop.go](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/cliproxy/auth/auto_refresh_loop.go)).
   요청 중 401이면 **정확히 한 번** 갱신 후 재시도하고 실패하면 다음 자격증명으로 넘어간다.
3. **설정 핫리로드.** fsnotify 감시 + 구조적 diff(`config_diff`/`auth_diff`/`model_hash`)로
   실제로 바뀐 하위 시스템만 재시작
   ([watcher.go](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/watcher/watcher.go)).

쿨다운 사다리도 저쪽이 더 촘촘하다: 429는 Retry-After 우선, 없으면 1s→30m 지수 사다리,
401/402/403 30m, 404 12h, 5xx 1m, 전부 쿨링 중이면 자체 `Retry-After`를 단 합성 429
`model_cooldown`을 반환한다
([conductor_cooldown.go](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/cliproxy/auth/conductor_cooldown.go)).
우리도 429 Retry-After 파싱과 쿨다운은 있다(`providers/key_failover.go:26,73`,
`oauth/anthropic_pool.go:419-425`)지만 상태코드별 사다리는 없다.

## 우리 쪽 남은 구멍 (이번 범위)

감사 결과 네 개다.

| # | 구멍 | 근거 | 저쪽은? |
| --- | --- | --- | --- |
| 1 | 업스트림 동시 요청 상한 부재 | `MaxConnsPerHost|semaphore|Limiter|inflight` 검색이 관련 결과 0 | 미확인(저쪽도 명시적 상한은 못 찾음) |
| 2 | 일반 SSE 경로의 이벤트별 flush 부재 | eager relay는 flush함(`relay.go:136-140`)이나 bridge 경로는 `writeSSE` 후 flush 없음(`bridge.go:215-217`) | `ForwardStream`이 청크마다 `flusher.Flush()` + keep-alive 주석 ([stream_forwarder.go](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/api/handlers/stream_forwarder.go)) — **저쪽이 낫다** |
| 3 | 업스트림 에러 본문 패스스루의 잔여 유출 위험 | `responses_core_port.go:523-527`에서 본문을 잘라 `RedactSecretString` 후 클라이언트로(`:1149`) | 저쪽은 오히려 헤더를 버려 Retry-After를 잃는 버그가 열려 있음 ([#4633](https://github.com/router-for-me/CLIProxyAPI/issues/4633)) |
| 4 | `repair.go:65` 고루틴에 done 가드 없음 | `go func() { writer.CloseWithError(...) }()`, 호출처 `responses_core_port.go:856-859` | 해당 없음 |

2번은 사용자 체감이 가장 크다. 스트리밍이 버퍼링되면 "느리다"로 인식되는데, 원인이
네트워크가 아니라 우리 쪽 flush 부재다.

## 저쪽의 열린 결함 (참고)

- [#4633](https://github.com/router-for-me/CLIProxyAPI/issues/4633) Codex 에러 경로가
  업스트림 헤더를 버려 Retry-After와 request ID를 잃음
- [#4629](https://github.com/router-for-me/CLIProxyAPI/issues/4629) GitTokenStore가
  pull 실패 후 force push로 인증/설정을 날림
- [#4642](https://github.com/router-for-me/CLIProxyAPI/issues/4642) 다운스트림 커밋 전
  일시적 터미널 SSE 실패 복구
- [#4652](https://github.com/router-for-me/CLIProxyAPI/issues/4652) Antigravity 번역기가
  `response_format`을 누락
- [#4628](https://github.com/router-for-me/CLIProxyAPI/issues/4628) Antigravity Gemini
  reasoning 왕복에서 thought 텍스트 유실

## 미검증

정직하게 남긴다. 아래는 이번에 확인하지 못했다.

- 저쪽이 프로바이더별 실행기에서 Retry-After **헤더**를 실제로 파싱하는지
  (인터페이스 `RetryAfter() *time.Duration`와 429 소비처는 확인, 각 실행기 경로는 미확인)
- fsnotify 감시의 디바운스/합치기 타이밍
- `shouldRetryAfterError`의 정확한 시도 상한과 백오프 곡선
- 저쪽 `http.Server` 타임아웃 미설정을 리버스 프록시가 상쇄하는지
- 저쪽 스트리밍 고루틴 내부의 패닉 복구 여부(gin Recovery는 핸들러 고루틴만 덮음)

## 결론

"CLIProxyAPI보다 안정적으로"라는 목표는 이미 상당 부분 충족돼 있고, 남은 것은 위 네 구멍이다.
진짜 차별점은 안정성이 아니라 **비용 회계**인데 그쪽이 지금 틀려 있다. 그래서 이 유닛은
비용 파리티(work-phase 1~6)를 먼저 하고 안정성 구멍(7~10)을 잇는다.
