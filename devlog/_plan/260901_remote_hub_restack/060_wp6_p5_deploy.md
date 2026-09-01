# wp6 — p5(#2786) 재스택 + 라우트 선언 / 계약 복원

브랜치 `codex/remote-hub-p5`, head `a62c8eba2`, 8커밋 / 19파일.
dev와 겹치는 파일 5개로 스택에서 가장 얕다. 그런데 블로커는 가장 많다.

## 블로커 4건 — 전부 계약 위반

리뷰어가 "인프라 노이즈가 아니라 제품 계약"이라고 못박은 항목들이다.

### tests/cli-headless-parity.test.ts:287 — 미선언 /api/machine/* 7개

p5가 머신 관리 라우트 7개를 추가했는데 CLI/headless 표면 선언에 등록하지
않았다. 이 테스트는 "서버가 여는 라우트와 CLI가 선언한 표면이 일치한다"를
주장한다. 해소는 둘 중 하나: 7개 라우트를 명시 선언하거나, 제거한다.
숨기는 방향(테스트 예외 추가)은 금지.

먼저 7개가 무엇인지 열거하고, 각각이 이 단계에 필요한지 판정한다.
배포 단계가 실제로 쓰지 않는 라우트가 섞여 있으면 그건 제거가 정답이다.

### tests/update-stop-first.test.ts:225 — stop-first 계약

업데이트 시 먼저 중지한다는 계약이 깨졌다. p5가 관리 ingress를 추가하면서
라이프사이클 순서를 건드렸을 가능성이 높다. `149b7215a feat(deploy): add
loopback hub management ingress` 부터 본다.

### tests/loopback-listener-admission.test.ts:196 — role-admission 계약

loopback 리스너의 admission 규칙이 깨졌다. `d6461bfd2 feat(deploy): harden
management ingress allowlist` 가 allowlist를 바꾸면서 기존 admission을
덮었는지 확인한다. 두 allowlist가 공존해야 하는 구조라면 병합한다.

### privacy 게이트

배포 가이드와 ingress 로깅에서 자격증명/호스트 식별자가 새는지 확인한다.
`bun run privacy:scan`으로 재현하고 코드를 고친다.

## release-version-line

wp2와 동일 원인. 재스택으로 소멸.

## 검증

- `git range-diff` 8커밋 보존.
- `bun test tests/cli-headless-parity.test.ts tests/update-stop-first.test.ts tests/loopback-listener-admission.test.ts tests/service.test.ts`
- `bun run privacy:scan`
- exact-head CI.
