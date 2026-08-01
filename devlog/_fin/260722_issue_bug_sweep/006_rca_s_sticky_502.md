# 006 — RCA S: 첫 502 이후 세션 내 502 빈발 잔존 경로 (#186)

- 이슈: #186 (open). 조사: sol 레인 S (2026-07-22, dev 트리 실측)
- 전제: #194/#205(e8a48a60)/51a27c18/0b8e81d8 모두 dev에 랜딩 확인.

## 증상과 증거 주의점

account-pool round-robin + Codex 5세션 동시 실행에서 일부 세션만 첫 502 후 반복 실패
(`502 upstream_server_error`, `Provider unreachable: socket closed unexpectedly`).
**증거 주의**: 사용자 재현 로그는 v2.7.28(수정 미포함) 기준이었고, "fix 버전에서도 2/5 재현"
후속 보고는 조사 시점 GitHub API에서 재확인 필요 상태. 잔존 여부는 아래 코드 결함으로 뒷받침됨.

## 현재 어피니티 정책 맵 (파일:라인)

- affinity: 전역 `threadAccountMap` (threadId→accountId), idle TTL 24h, max 2048 (`src/codex/routing.ts:25,42`)
- soft-avoid: **계정 전역** `upstreamHealth[accountId]` (`:26,51,176`); transient 30s 고정, failure streak 창 5분, failover threshold 3회 (`:42,340`)
- 선택 제외: hard cooldown/soft-avoid/needsReauth (`:238`); bound thread가 avoid·threshold 계정이면 affinity 해제 후 재선택 (`:372,410`)
- `connect_error`/timeout/5xx 기록 시 해당 thread affinity 즉시 삭제, threshold 도달 시 그 계정의 전체 affinity 삭제 (`:487,507`)
- 401/403→needsReauth+전체 해제 (`:461`); 429→hard cooldown+전체 해제 (`:472`); 2xx는 avoid·streak 즉시 전체 클리어 (`:451`)
- 후보 전멸 시 soft-avoided active 계정 fallback (fail-open, `:419`)

## 잔존 갭 가설 (순위)

### 1. (최유력) HTTP 200 이후 mid-stream reset이 계정 성공으로 기록됨 — split-brain

- 헤더 전 fetch 거부는 connect_error/timeout으로 정상 기록 (`src/server/responses.ts:1115,1130`)
- 그러나 200 이후 SSE 절단 시: client tee는 synthetic `response.failed/upstream_reset` 생성(`:1205`, `relay.ts:43`)하는데, routing outcome을 기록하는 inspection branch는 read throw 시 **`incomplete`** 보고(`relay.ts:442,483`) → terminal recorder가 이를 **정상 200 성공으로 기록**(`responses.ts:429`)
- 결과: mid-stream reset이 soft-avoid 미설정·affinity 미해제·streak 미증가, 심지어 직전 failure health를 **성공으로 클리어**. 클라이언트는 502를 보는데 라우터는 계정 성공으로 판단.
- Windows는 raw native relay라 synthetic failed tail조차 없음 (`responses.ts:1239`)

### 2. 구조적 불량 계정에 escalation 없음

30s 고정 soft-avoid만 존재(`routing.ts:494`) — 반복 실패해도 30s 연장뿐, 단 한 번의 2xx(또는 오분류
incomplete)가 streak 전체 초기화(`:451`). 불량 추가 계정이 30s 후 재후보화를 무한 반복.

### 3. 선택 전 health-check가 로컬 상태만 확인

usable 판정은 credential 존재/generation/needsReauth 중심 (`account-usability.ts:6`, `routing.ts:187`) —
refresh는 성공하되 특정 backend 요청만 거절되는 계정은 usable로 남음 (`auth-context.ts:126`).

### 4. pool 소진 시 known-bad active 재사용

후보 전멸 시 soft-avoided active 계정 조용히 선택 (`routing.ts:419`).

### 진단 노트

로그의 `"provider": "openai"`는 현 코드 기준 main 계정일 가능성이 높음(추가 풀 계정은
`openai-<safe-label>`, `responses.ts:987`, `routing.ts:524`) — 단 해당 로그는 fix 이전 버전.

## 수정 방향 (030 패치 단위 입력)

1. **(최우선)** `consumeForInspection` catch를 `incomplete` 대신 `transport_failure`/`failed+502`로 구분, terminal recorder가 transient 계정 실패로 기록. client cancel과 upstream read error 분리 필수.
2. per-account cooldown escalation: 30s→2m→10m→30m (5분 창 누적), 연속 정상 종료 N회 후에만 완전 복구.
3. 신규 binding 전 lightweight probe: 신규/재인증/쿼런틴 복귀 계정에 한해 backend 접근 1회 확인.
4. pool 소진 정책 명시화: 조용한 재사용 대신 명시적 503/429 + health 요약 또는 half-open circuit-breaker.
5. compact buffering 경로도 mid-read reset을 성공 처리하지 않도록 재검토 (`responses.ts:1823,1830`).
6. 진단 필드 추가: account label/hash, affinity 상태(reused/new_bind/rebound/cleared), transport phase(pre_headers/mid_stream/terminal_sse), terminal source(real/synthetic), 선택 이유·제외 후보.
