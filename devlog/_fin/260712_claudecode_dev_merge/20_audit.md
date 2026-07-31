# 20 — sol 감사 기록 (리뷰어: Plato, gpt-5.6-sol high)

## A-게이트 (플랜 감사) — 2회 fold-in 후 PASS

- R1 FAIL: (1) merge-base 182ddae9 명시 누락, (2) 충돌 성격 오기술 — management-api는 인접 라우트 블록, Debug.tsx는 entries 아키텍처 충돌, (3) 검증 게이트가 ci.yml 대비 불완전.
- R2 FAIL (내 정정 방향 오류를 재지적): ManagementApiDeps/getLogicalMaxThreads/transitionMultiAgentV2는 **953fb5b9가 추가한 claudecode-계보 API**로 유지 대상 (제거 지시는 기능 삭제였음). ci.yml 재현에 release build + npm-global 스모크 누락.
- R3: "No residual findings" → **VERDICT: PASS**

## C-게이트 (구현 검증) — 1회 fold-in 후 PASS

- R1 FAIL:
  - MAJOR: Debug.tsx 가상화가 인덱스 키 → 롤링 2000엔트리 윈도우에서 head 트림 시 측정 캐시가 다른 엔트리에 붙음. `getItemKey`를 `entries[index].seq`로.
  - MINOR: ClaudeCode.tsx 지연 로드가 Models.tsx 패턴과 불일치 (`load`가 useCallback 아님, deps 경고).
  - 백엔드 의도 보존은 통과: 양쪽 라우트/v2 API/SSRF 거부 테스트/claude GET·PUT/캐시 토큰 필드 전부 생존. 통합 138 + SSRF 17 테스트 통과 확인.
- 수정: `edf16cb2` — seq 키 가상화 + useCallback load. lint 경고 3→2 (잔여는 기존 virtualizer 경고).
- R2: "No residual findings ... both changes are correct" → **VERDICT: PASS**

## 감사가 잡아낸 실질 가치

1. 잘못된 base(953fb5b9) 비교로 인한 방향 착오 → 유효 API 삭제 사고 방지
2. 가상화 행 정체성 버그 (머지 자체가 아니라 접붙인 코드의 잠재 버그) 발견
3. CI 게이트 완전 재현 강제 → 로컬에서 SSRF 픽스처 14 fail을 푸시 전에 발견
