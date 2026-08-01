# 012 — ChatGPT Pro 검토 (웹서치 활성, 대화 6a527685-…, 수신 03:5x)

판정: "Your plan is sound" + 교정 2건.

## 확정 (2.1.207 재검증)
- discovery id의 `[1m]` 대괄호 수용 확인 (필터는 `/^(claude|anthropic)/i`뿐). 단 **피커 폴딩**
  주의: canonical화 후 내장 행과 같은 모델로 접히는 경우(fable, native-1M, 날짜접미사가 내장
  모델로 canonical화될 때) — CLI 업데이트마다 픽커 행 회귀 확인 권고. 폴딩 문제 시 대안:
  `/model '<id>[1m]'` 직접 입력, `ANTHROPIC_CUSTOM_MODEL_OPTION='<id>[1m]'`(검증 스킵).
- `[1m]`은 2.1.207이 전송 전 스트립(우리 방어 스트립은 스큐 대비 유지 타당).
- 티어 4슬롯 지원 확인 + 부작용: OPUS/SONNET은 opusplan 양 단계 제어(컨텍스트 정합 권장),
  HAIKU는 백그라운드 트래픽(요약 등) 수신 — 저가 모델 권장, FABLE은 fallback 의미론 주의.
  `[1m]` in HAIKU/FABLE 변수는 문서 미보증(2.1.207 실동작) — 호환성 게이트 항목.
  `CLAUDE_CODE_SUBAGENT_MODEL`(inherit 외)은 per-agent 선택 전체를 덮음.
- attribution system block이 대화별로 달라 교차 대화 prefix 재사용은 원래 불가
  (`CLAUDE_CODE_ATTRIBUTION_HEADER=0` 외) — 코호트 키에서 제외해도 이득 없음.

## 반영한 교정
- B4 키: 도구 정렬 금지 → **wire 순서 그대로** 전체 번역 도구 정의를 canonical JSON
  `{version:2, model, system, tools}`로 해시 (버전 구분자 포함). 구현+테스트 반영 완료.
- CJK 2.5는 백엔드별 캘리브레이션 여지(과소보다 과대가 안전) — 차기 관측 항목.

## 채택 안 한 것(근거)
- 15RPM 초과 코호트의 샤딩(`:hash mod N`): 현재 로컬 단일 사용자 트래픽엔 불필요 — 기록만.
- 1M 모델의 base 행 제거([1m] 행만 노출): 사용자가 200k 회계를 고를 자유 유지.
