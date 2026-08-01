# 133 — A-게이트 감사 합성 (라운드 1: Boole, VERDICT: FAIL, 블로커 9)

| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | 레지스트리가 실제 Anthropic id까지 등록 → sk-ant 네이티브 패스스루 사망 (`resolveInboundModel("claude-opus-4-8")`≠항등) | **수용** — anthropic passthrough 항목은 레지스트리 미등록, 회귀 테스트 추가 |
| 2 | Low | 충돌 논거의 모델 id 서술 부정확 (4.6+는 dateless canonical) | **수용** — 근거 교정 + 신구 별칭 상호 충돌 검사 |
| 3 | Med | effort 소스 키 미확정 (routed는 `provider/id` 키만 hit) | **수용** — native=bare, routed=`provider/id`로 diff-level 고정 |
| 4 | High | B4b가 Desktop에 도달할 경로 없음 (discovery off + 정적 목록에 capabilities 불가) | **수용** — 기본 discovery-on 모드로 전환, `--static` 안전판. CLI는 추가 필드 strip 확인됨(리뷰어 재현) |
| 5 | Med | 캡처 지점 불완전 (count_tokens 별도 핸들러, body 이중 소비 위험) | **수용** — parse 직후 공유 capture 함수, 3경로 테스트 |
| 6 | Med | 프라이버시: raw 객체/해시 프리픽스 fingerprint + 무인증 loopback | **수용** — opt-in debug 키, allowlist 스칼라만, 해시 저장 안 함, OFF 시 클리어 |
| 7 | High | 추정 input 병합이 정확 usage 오염 (max() 병합) | **수용** — cursor/kiro 어댑터 한정 세팅 + anthropic 무접촉 회귀 테스트 |
| 8 | Med | system 해시는 대화 식별자 아님 / session_id 교차 의미 미입증 | **부분 수용** — B1 캡처 선행 게이트, system 부재 스킵, exact-prefix 무해성 문서화, 라이브 cached_tokens 검증 |
| 9 | Med | 활성화 시나리오 B3에만 존재 | **수용** — B0/B1/B2/B4b 각 분기에 활성화 시나리오 명기 |

교차 충돌: #4(discovery-on)와 B0의 anthropicFamilyTier/isFamilyDefault 핀은 양립 불가
(discovery 모드에선 정적 필드 소멸) → 기본값은 discovery-on(실험 우선), 정적 핀이 필요한
사용자는 `--static`. 플랜 130에 반영 완료.

## 라운드 2 (Boole, VERDICT: FAIL, 블로커 4)

| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | `catalogModelEfforts`의 routed 키는 합성 catalog(ladder 기본화 + max/ultra 증강)라 capability 진실원 부적격 | **수용** — routed는 `fetchAllModels`의 `reasoningEfforts`만, 없으면 supported:false |
| 2 | Med | ModelInfo 값 생성 규칙 부재 (created_at/max_tokens 추측 위험) | **수용** — created_at 고정 상수, max_input_tokens=authoritative or null, max_tokens=null |
| 3 | Med | B1 캡처가 안정 식별자 판별 불가 + system-hash session_id 교차 의미 미입증 | **수용** — 프로세스 salt ephemeral equality tag 저장, fallback 키는 prompt_cache_key만(session_id 헤더 합성 금지) |
| 4 | Low | `--static` 활성화 시나리오 부재 | **수용** — 인자 파싱→config shape→별칭 decode 단일 테스트 명기 |

## 라운드 3 (Boole, VERDICT: FAIL, 블로커 2)

| # | Sev | 요지 | 처분 |
|---|-----|------|------|
| 1 | High | fallback 표시를 body 내부 marker로 하면 native adapter가 upstream으로 유출(400 위험) | **수용** — `anthropicToResponsesBody`가 `{body, cacheKeySource}` 튜플 반환, wire body 무오염 단언 테스트 |
| 2 | Med | native ladder도 합성 증강(max/ultra) 포함 가능 — clamp와 광고 불일치 | **수용** — clamp 항등 rung만 광고(`clamp(r)===r`), 항등 단언 테스트 |
