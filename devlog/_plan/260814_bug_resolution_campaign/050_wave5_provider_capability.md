# 050 — Wave 5: Provider and Capability

선행: Wave 1 완료
이슈: #1483, #1594, #1024, #1651, #1582 (Wave 1에서 처리)
PR: #1639, #1640, #1582 (Wave 1)

## 목표

Provider 호환성과 capability 모델링을 바로잡는다.

## 실행 순서

### Step 1: #1483 MiMo effort mapping 분리

- 변경:
  - MODIFY: src/providers/ (또는 MiMo adapter)
    - MiMo effort mapping: reasoning ladder 수정
  - MODIFY: src/adapters/ (또는 tool-call wire)
    - malformed tool-call wire 정규화
  - 두 변경을 별도 커밋으로 분리
  - NEW: tests/mimo-effort-mapping.test.ts
  - NEW: tests/mimo-tool-call-wire.test.ts
- 검증: 최신 dev에서 MiMo v2.5 재현 후 수정 확인

### Step 2: #1594 DeepSeek wire capture

- 바로 코드 수정하지 않음
- 최소 redacted wire capture 확보 필요
- capture 확보 후:
  - MODIFY: src/adapters/openai-response.ts (또는 해당)
    - reasoning continuation 처리 수정
  - NEW: tests/deepseek-reasoning-continuation.test.ts

### Step 3: #1639 scope 수정 + 병합

- 상태: REQUEST_CHANGES (scope 수정 필요)
- 변경:
  - 전역 authMode ?? "key" 변경을 MiMo canonical legacy repair로 제한
  - Cline, MiMo Free, xAI discovery만 포함
- 검증: rebase + scope 수정 후 CI green

### Step 4: #1640 fingerprint 실증 + 병합

- 변경:
  - MODIFY: src/providers/antigravity/ (CLI fingerprint)
    - first-party Antigravity fingerprint 실증 후 작은 delta
- 검증: 실증 데이터 + CI green

### Step 5: #1024 vision capability 3상태 모델링

- 변경:
  - MODIFY: src/providers/ (model metadata)
    - custom provider vision capability: native / text-only / unknown 3상태
  - 금지: model name/vendor lineage 기반 전역 추측
  - NEW: tests/custom-provider-vision-capability.test.ts

### Step 6: #1651 terminal guard opt-in 확장

- 변경:
  - MODIFY: src/adapters/ (terminal continuation guard)
    - 전체 openai-chat에 켜지 않음
    - provider/model opt-in으로만 확장
  - NEW: tests/terminal-guard-opt-in.test.ts
- 주의: 일반 버그 핫픽스가 아닌 호환 정책 설계

## 이 Wave 완료 조건

- #1483, #1639, #1640 dev에 머지됨
- #1594 wire capture 확보 후 수정 머지됨
- #1024, #1651 설계 구현 및 머지됨
- MiMo, DeepSeek, xAI, Antigravity 호환 테스트 green
