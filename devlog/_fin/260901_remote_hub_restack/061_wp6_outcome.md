# wp6 결과 — p5(#2786) 재스택

브랜치 `codex/remote-hub-p5`: `a62c8eba2` → `8bcfcaa8e`.
베이스는 재스택된 `codex/remote-hub-p4@95787b9bc`.

## 충돌 2건

`tests/server-management-auth.test.ts`: 이 단계가 관리 ingress pairing 교환
테스트를 wp3이 다시 쓴 평문 pairing 테스트 앞에 삽입한다. 둘 다 유지했다.

`structure/01_runtime.md`: dev가 `codex-cli-update` 문장을, 이 단계가
hub-management 리스너 절을 각각 추가했다. 두 행 모두 양쪽 내용을 담도록 합쳤고,
합친 뒤 각 문장이 실제로 살아 있는지 grep으로 확인했다.

원본 8커밋 보존.

## 리뷰가 지목한 블로커 4건 — 실측 결과

리뷰는 `cli-headless-parity:287`, `update-stop-first:225`,
`loopback-listener-admission:196`, privacy 게이트를 들었다. 재스택 후 실제로
돌려보니 넷 중 셋은 이미 해소돼 있었다.

- `cli-headless-parity` 42 pass — `/api/machine/*` 선언은 소유 단계인 wp5에서
  이미 처리했다(감사 A5의 재배정이 맞았다).
- `update-stop-first` 15 pass — 상속된 staleness였다.
- privacy 게이트 통과 — 역시 staleness.
- `loopback-listener-admission`만 실제로 빨간색이었다.

## loopback-listener-admission:196

테스트가 non-hub role 셋(undefined, standalone, client)을 순회하며 전부
`"requires runtimeRole hub"` 메시지로 거절되기를 요구했다. 그런데 `client`는
더 앞선 규칙 — client role은 완전한 연결 블록이 필요하다 — 에 먼저 걸린다.

거절 자체는 옳다. 틀린 것은 **두 독립적인 검증 규칙 사이의 순서를 단언한 것**이다.
계약은 그런 순서를 약속한 적이 없다.

행을 쪼갰다. undefined/standalone은 정확한 ingress 메시지를 그대로 단언하고,
`client`는 "거절된다"만 단언한다. 그리고 이게 구멍을 만들지 않도록 케이스를
하나 더 넣었다: **완전한** client 연결을 주면 앞선 규칙이 안 걸리고, 그때
거절하는 것이 ingress 규칙임을 확인한다. 이게 없으면 ingress 규칙이 그 role에
아예 적용되지 않게 되어도 약해진 단언이 통과해버린다.

## 검증

- `bun run typecheck` 통과, `bun run privacy:scan` 통과.
- 포커스드 5파일 **263 pass / 0 fail**.
- `tests/service.test.ts` 192 pass / 0 fail.
- 충돌 마커 0건.

## 남은 것

T29/T30(hub role을 disconnected client state에서 배제, missing-config
부트스트랩 경쟁)과 T3/T11은 wp8에서.

## 커밋

| 범위 | 내용 |
| --- | --- |
| `149b7215a`..`f2bf97d4f` | 원본 8커밋 재적용 |
| `8bcfcaa8e` | test(deploy): assert the ingress role rule where the message is actually reachable (신규) |
