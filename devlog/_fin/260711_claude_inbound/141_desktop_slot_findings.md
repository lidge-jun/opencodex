# 141 — Desktop 본명 슬롯 실험 확정 결과 + 차기 스펙 (2026-07-12 02:3x-02:5x 라이브)

## 실측 확정 (사용자 Desktop 검증)
- **본명 id 슬롯 동작**: `claude-opus-4-8` → modelMap → terra: effort 슬라이더 열림,
  medium/xhigh가 wire까지 도달, **캐싱도 동작**(1급 취급이라 cache_control 정상).
- **날짜 접미사 슬롯 동작**: `claude-opus-4-8-20260704` → sol 정확 분리 라우팅 + effort 동작.
  modelMap은 정확 일치가 날짜-스트립보다 우선이라 접미사별 개별 매핑 가능.
- **labelOverride 존중됨**: "Opus 4.8 (GPT 5.6 Terra)" 표시 확인.
- **같은 name 중복 등록 불가**: 두 항목이 함께 픽됨(name 기준 동일 취급).
- **Desktop 유틸리티 호출**: 턴마다 claude-sonnet-5로 제목/요약 사이드콜 2건
  (1.3만 요약 + 36토큰 제목, configuredTier=fast). 순정 sonnet 쿼터 소모 —
  modelMap으로 싼 모델 매핑 가능(순정 sonnet 포기 대가).

## 한계 (사용자 확인)
1. **세션 간 슬롯 전환 불가**: opus-4-8 ↔ opus-4-8-20260704 전환이 세션을 넘으면 깨짐
   (Pro 보고의 __model_selector_state 정규화 결함 계열로 추정 — 프록시로 못 고침).
2. **컨텍스트는 이진**: 200k(기본) vs 1M(supports1m 행 선택)만. 중간값 불가 —
   Desktop 스키마에 수치 필드 없음. CLI는 CLAUDE_CODE_MAX_CONTEXT_TOKENS로 임의값 가능.

## 차기 스펙 (사용자 지시 반영, 미구현)
- **슬롯 자동 발급**: 라우팅 모델마다 `claude-opus-4-8-2026MMDD` 형태 날짜 접미사 슬롯.
  날짜는 2026년 범위에서 **중복 없는 난수**(모델 route 해시 → 유효 날짜 매핑, 충돌 회피).
  labelOverride = "Opus 4.8 (<실모델명>)", contextWindow>=1M이면 supports1m.
  `ocx claude desktop`이 슬롯 목록 + modelMap을 자동 기록.
- **티어 기본 3모델**: Claude Code 서브에이전트는 opus/sonnet/haiku(/fable) **별칭**으로
  호출하므로 티어별 기본 슬롯을 GUI에서 지정: opus=주력(복잡한 설계/디버깅),
  sonnet=균형(구현/조사), haiku=경량(탐색/분류/요약), fable=명시 선택.
  구현: 각 티어 대표 항목에 anthropicFamilyTier=<tier> + isFamilyDefault=true 부여
  (현재는 전부 opus 티어 — sonnet/haiku 티어 항목 신설 필요).
- **유틸 호출 절약(옵션)**: claude-sonnet-5 → 저가 모델 modelMap 토글.

## 브랜치 분리 (사용자 지시)
- `claudedesktop` 브랜치: Desktop 3P 기능 개발/테스트 전용 (사용자 별도 테스트).
- `claudecode` 브랜치: Claude Code(CLI) 제공 라인으로 유지, Desktop 신규 작업 안 섞음.
