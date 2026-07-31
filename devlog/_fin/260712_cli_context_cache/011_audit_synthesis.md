# 011 — A-게이트 감사 합성 (라운드 1: Curie sol high, VERDICT: FAIL, 블로커 11)

| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | [1m] 변형이 1M native(gpt-5.4 등) 누락 | 수용 — nativeOpenAiContextWindow 포함 |
| 2 | High | cmdClaude에 별칭 레지스트리 없음 → resolveInboundModel 불가 | 수용 — 기동 프록시 GET /v1/models(anthropic)의 id→max_input_tokens 맵 사용(레지스트리 불요) |
| 3 | High | 티어 슬롯이 ocx claude 경로만 | 수용 — system-env(launchctl/shell/추적) + 수동 안내 3경로 |
| 4 | High | 도구 이름만 해시 → 동명이스키마 충돌 | 수용 — 번역된 tools 안정 직렬화 전체 해시 |
| 5 | High | phase decade 로드맵 부재 + 예약번호 규약 위반 | 부분 수용 — 단일 work-phase로 재규정 + loop-spec 헤더 명시, 예약번호 011/012/090 정정 |
| 6 | High | 픽커 [1m] id 수용의 E2E 증거 없음 | 수용 — C 게이트에 사용자 라이브 스모크 + 실패 시 축소 경로 명시 |
| 7 | Med | 단발 프로세스 fetchAllModels 콜드 8초 | 수용 — 프록시 HTTP 조회(웜 캐시)로 대체, 실패 시 무부여 |
| 8 | Med | haiku 우선순위 두 변수 계약 불명 | 수용 — effective-haiku 단일 값 → 두 변수 주입 |
| 9 | Med | B3 활성화가 estimator 직접 호출뿐 | 수용 — endpoint + usageLog 병합 단언 추가 |
| 10 | Med | raw alias 키 → 코호트 분리·리셋 | 수용 — resolved model 사용 + 콜드스타트 문서화 |
| 11 | Med | [1m] variant dedupe/이중 접미사 | 수용 — seen 등록 + base [1m] 시 미생성 + 테스트 |

## 라운드 2 (Curie, FAIL, 블로커 7)
| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | /v1/models는 alias 키만 — 슬롯의 bare/provider-id 매칭 불가 | 수용 — /api/claude-code에 3형식 키 contextWindows 맵 추가 |
| 2 | High | 데이터플레인 /v1/models 401 리스크 | 수용 — 관리 평면(loopback 무인증) 조회로 전환, 인증 분기 소멸 |
| 3 | High | system-env의 [1m]/맵 전달 순서 미정 | 수용 — 데몬 in-process 헬퍼 호출 순서 고정 + 부분 실패 정책 |
| 4 | High | loop-spec 헤더 불완전 + `_plan` 경로 주장 | 부분 수용 — Memory/terminal/escalation 보완; 경로는 레포 실증(날짜 최상위 유닛 15+)으로 반박 |
| 5 | Med | JSON.stringify는 중첩 키순서 비정규 | 수용 — 재귀 canonical JSON + 키순서 동일성 테스트 |
| 6 | Med | [1m] 스트립 테스트가 별칭 한 계열만 | 수용 — 두 계열 각각 단언 |
| 7 | Med | CJK ratio가 모델별 ratio와 충돌 모호 | 수용 — effectiveRatio=min(모델 ratio, 2.5) + 경계 3분기 |

## 라운드 3 (Curie, FAIL, 블로커 5)
| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | 맵이 legacy claude-ocx-* 키 누락 | 수용 — 4형식 키(+aliasForNative/aliasForRoute) 등록 + 테스트 |
| 2 | High | non-loopback 바인드 시 관리 API 인증 필요 | 수용 — apiKeys 존재 시 x-opencodex-api-key 헤더 동봉 |
| 3 | Med | 콜드 catalog 경합/지연 | 수용 — 3초 bounded timeout + 무부여 fallback + 콜드스타트 테스트 |
| 4 | Med | 별칭 충돌 시 후자 덮어쓰기 | 수용 — first-wins dedupe 공유 헬퍼 + 충돌 테스트 |
| 5 | Med | manualEnv가 raw 값 표시 | 수용 — effectiveTierEnv 맵 반환 + GUI 렌더 |

## 라운드 4 (Curie, FAIL, 블로커 4)
| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | 인증 헤더가 config apiKeys만 — env-token-only 구성 401 | 수용 — OPENCODEX_API_AUTH_TOKEN env 우선 + config fallback |
| 2 | Med | 타임아웃 분기 테스트 비결정적 | 수용 — 3초 초과 지연 fixture + AbortError 관측 단언 |
| 3 | Med | system-env in-process 조회 8초 무제한 | 수용 — 동일 3초 bound Promise.race 공유 헬퍼 |
| 4 | Med | effectiveTierEnv 키 범위 불명 | 수용 — effectiveModelEnv 6키 명시 + manualEnv 렌더 단언 |

## 라운드 5 (Curie, VERDICT: GO-WITH-FIXES, blockers=1)
| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | Med | 011에 R4 합성표 누락 | 수용 — 본 표 추가로 즉시 해소 (문서 동기화) |
