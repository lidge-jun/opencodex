# 139 — 사이클 2 A-게이트 감사 합성

## 라운드 1 (Gibbs, sol high, VERDICT: FAIL, 블로커 8)

| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | contextWindow가 `{provider,id}` 축약에서 소실 | **수용** — DTO `{provider,id,contextWindow?}` 확장, 실데이터 테스트 |
| 2 | High | maxContextTokens의 GET/PUT/GUI 왕복 경로 계획 누락 | **수용** — types→API 검증→GUI→테스트 전면 명시 |
| 3 | High | systemEnv가 사용자 선존값을 덮어쓰고 revert가 지움 | **수용** — user-wins 스킵 + 실주입 키만 추적 + 보존 회귀 테스트 |
| 4 | High | ALWAYS_ENABLE_EFFORT 기본 주입이 비추론 라우트에 effort 강제 유출 | **수용** — opt-in 강등(사용자 단서: opus 별칭 effort 이미 wire 도달) + 인바운드 비추론 reasoning 제거 안전판 |
| 5 | High | 변수명 오류(DISABLE_COMPACT) + recognized id 분류 미검증 | **수용** — 변수명 교정, MAX_CONTEXT_TOKENS와 쌍 주입, 라이브 스모크 게이트 + compaction 경고 |
| 6 | Med | 3중 모드 타입/플래그 충돌 처리 부재 | **수용** — 3값 mode + 상호배타 파서 + 4분기 테스트 |
| 7 | Med | 활성화 증거가 런처 3분기뿐 | **수용** — (a)-(e) 활성화 매트릭스로 확장 |
| 8 | Low | 사이클 2 기록 파일 번호 미예약 | **수용** — 138/139/140 예약 |

사용자 단서(02:2x): anthropic 모델 경로는 effort 전부 동작 + 라이브 로그에서 opus 별칭에
high/xhigh wire 도달 → #4의 "기본 주입" 동기 자체가 소멸, opt-in으로 충분.

## 라운드 2 (Gibbs, VERDICT: FAIL, 블로커 5)

| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | shell env 파일이 launchctl 부재+shell 선존 사용자 값을 덮음 | **수용** — 신규 키 조건부 export(`${VAR+x}`) + 보존 테스트 |
| 2 | Med | "authoritative ladder" 조회 계약 미고정 | **수용** — `supportedLadderFor(route)===[]`일 때만 제거, unknown 통과, live 조회 불가 명시 |
| 3 | Med | 근거 요약에 잘못된 변수명 잔존 | **수용** — line 23 `DISABLE_COMPACT`로 교정 |
| 4 | Med | 미지 플래그 테스트 분기 누락 | **수용** — 파서 5분기로 확장 |
| 5 | Med | alwaysEnableEffort API 검증 분기 누락 | **수용** — boolean 왕복 + 비boolean 400 명시 |
