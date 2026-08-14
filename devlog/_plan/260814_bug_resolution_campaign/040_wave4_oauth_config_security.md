# 040 — Wave 4: OAuth, Config, Security

선행: Wave 1 (#1656)
이슈: #1478, #1635
PR: #1656, #1663, #1609, #1635, #1653

## 목표

OAuth identity와 config integrity를 provider별로 증명하고,
config security hardening을 분리 구현한다.

## 실행 순서

### Step 1: #1656 rebase + 병합

- 변경:
  - MODIFY: src/auth/ (또는 credential import)
    - exact accountId를 먼저 찾는 identity resolution
  - 테스트: focused green, exact-head maintained CI 필요
- 검증: CI green 후 병합

### Step 2: #1663 rebase + 병합

- 선행: #1656 머지 완료
- 변경:
  - MODIFY: src/auth/ (또는 add-account flow)
    - forced add-account에서 identity-less credential 보존
  - NEW/MODIFY: tests/oauth-add-account-matrix.test.ts
    - provider matrix: ChatGPT single-slot, Kiro, Kimi, 일반 OAuth
- 검증: provider matrix + credential security review

### Step 3: #1609 최소 cherry-pick

- 전체 branch rebase가 아닌 최소 누락 commit만 가져옴
- #1605 merge commit ancestry 비교:
  - 이미 dev에 있는 코드 제외
  - 다음 불변식에 필요한 commit만:
    1. replacement B 생존
    2. preserved copy 검증 후 source claim
    3. claimed read/harden/restore 실패 시 secret-bearing path 보존
    4. residual-secret 오류의 정확한 분류
- 보안 리뷰 필요 (MAINTAINERS.md)

### Step 4: #1635 분할

1. fix/config-nesting-depth-cap
   - MODIFY: src/config/ (JSON5/YAML parser)
     - 공통 nesting-depth cap 추가
   - NEW: tests/config-depth-cap.test.ts

2. fix/config-numeric-roundtrip-refusal
   - MODIFY: src/config/ (TOML/JSON5/YAML rewriter)
     - unsafe numeric round-trip 감지 시 rewrite 거부
   - NEW: tests/config-numeric-roundtrip.test.ts

### Step 5: #1478 ADR

- 직접 코드 수정이 아닌 config provenance ADR 작성
- 현재 두 시나리오가 dev에서 통과하므로 active hotfix가 아님
- devlog/_plan/ 또는 structure/ 에 ADR 문서

### Step 6: #1653 병합

- token estimate context window cap
- 독립 수정, #1638과 무관
- CI green 후 병합

## 이 Wave 완료 조건

- #1656, #1663 OAuth chain dev에 머지됨
- #1609 cherry-pick PR 머지됨, security review 통과
- #1635 2개 분할 PR 머지됨
- #1478 ADR 문서 작성됨
- #1653 머지됨
