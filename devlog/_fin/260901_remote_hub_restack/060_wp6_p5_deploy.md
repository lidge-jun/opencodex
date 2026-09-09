# wp6 — p5(#2786) 재스택 + 라우트 선언 / 계약 복원

브랜치 `codex/remote-hub-p5`, head `a62c8eba2`, 8커밋 / 19파일.
dev와 겹치는 파일 5개로 스택에서 가장 얕다. 그런데 블로커는 가장 많다.

## 블로커 4건 — 전부 계약 위반

리뷰어가 "인프라 노이즈가 아니라 제품 계약"이라고 못박은 항목들이다.

### tests/cli-headless-parity.test.ts:287 — 여기가 아니다

`#2786`에 보고됐지만 `/api/machine/` 추가 라인은 p4에 49건, p5에는 0건이다.
라우트를 도입한 건 p4이므로 **wp5로 재배정했다**(감사 A5). 여기서는 p4가
선언을 고친 뒤에도 이 단계에서 회귀하지 않는지만 확인한다.

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

## 이 단계가 소유하는 스레드

### T29 (P2) — hub role을 disconnected client state에서 배제

`src/client/state.ts:46`. `client` 블록이 없는 허브를 `disconnected`로
분류하면 `connectClient()`가 그 상태 검사를 통과해버린다.

### T30 (P2) — missing-config 부트스트랩 조건화

`src/client/state.ts:85`. `mutatePersistedConfig()`가 `missing`을 보고할 때
뮤테이션 락을 얻기 전에 반환해서, 다른 첫 실행 명령과 경쟁한다.

### T3 / T11 (#2771에서)

관리 ingress에서 GUI health 엔드포인트 보존(`070_phase5_deploy.md:164`),
안정성 지적(`:300`). Tailscale Serve 배포에서 브라우저가 관리 리스너를 쓰므로
health 경로가 살아 있어야 한다.

## release-version-line

wp2와 동일. 이 단계 head에서 명시적으로 확인한다.

## 검증

- `git range-diff` 8커밋 보존.
- `bun test tests/cli-headless-parity.test.ts tests/update-stop-first.test.ts tests/loopback-listener-admission.test.ts tests/service.test.ts tests/release-version-line.test.ts`
- `bun run privacy:scan`
- **이 단계 head가 초록이어야 p6을 그 위에 쌓는다.**
- exact-head CI.
