# 002 — 조사 확정 2: CLI 메커니즘 표 (Herschel + 바이너리 교차검증)

기준: Claude Code 2.1.207 배포 바이너리(strings 추출) + 공식 docs + CCR@9cd0aab + LiteLLM@0bf81e2.
상세 원문 인용은 Herschel 반환(001의 보강) — 핵심 확정만 기록.

## Auto-Context 메커니즘 표 (Tier 2)
| 메커니즘 | 모델별 | 임의값 | 컴팩션 | 판정 |
|---|---|---|---|---|
| `[1m]` suffix | O | 1M만 | 유지 | **1M 라우트 정답** (`/\[1m\]/i` 무조건, 전송 전 제거) |
| MAX_CONTEXT_TOKENS 단독 | 프로세스 1값 | O | 유지 | canonical id가 claude- 시작이면 무시 — **우리 별칭 전부 무시됨** |
| MAX_CONTEXT + DISABLE_COMPACT | 전 모델 | O | **사망** | 기존 수동 옵션으로만 유지 |
| /v1/models metadata | X | X | — | id/display_name만 소비 (capability 캐시는 2.1.207에서 `return !1` 하드코딩) |
| count_tokens 조작 | 표시만 | X | 간접 | 창 광고 불가. 컴팩션 판단은 messages 응답 usage |

## count_tokens 실사용 (Tier 2)
- /context 분해 표시에 사용(시스템/도구/에이전트 각각 count). 대화 본체는 최신 messages
  usage(input+cache_read+cache_creation)가 있으면 그걸 사용 — **인플레이션 의혹의 답**:
  스킬 로드 시 3-4배 점프는 도구 4개+스킬 본문이 실제 컨텍스트에 들어간 실측일 가능성이
  높고, 우리 outbound는 exclusive 규약 준수 확인(001). 남은 개선은 캐시 적중을 올려
  비용을 낮추는 것(P0 코호트 키).
- 경쟁 대비: CCR은 단어수×1.15 휴리스틱, LiteLLM은 로컬 fallback에서 system/tools 누락.
  우리는 system+messages+tools 포함 + 모델별 ratio — 여기에 CJK-aware ratio를 더하면 우위.

## 서브에이전트 티어 별칭 (Tier 2-A, 바이너리)
- 2.1.207에 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` 4슬롯 전부 존재.
- Agent tool `model: "opus"|"sonnet"|"haiku"|"fable"`(+부모상속)은 이 슬롯으로 해석 →
  슬롯에 우리 별칭을 넣으면 서브에이전트도 라우팅 모델 사용 가능.

## 캐싱 결론 (Heisenberg, 001 참조)
- CCR/LiteLLM 모두 비-Anthropic 백엔드 캐시 힌트 변환 없음 → 우리가 이미 우위.
- P0: fallback prompt_cache_key 코호트를 model+system+tools 해시로 확장 (system 단독 X).
- GPT-5.6+ breakpoint/ttl은 차기 후보(기능 게이트 필요) — 이번 스코프 OUT, 기록만.
