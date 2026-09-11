# wp7 결과 — p6(#2789) 재스택 + D4 계열

브랜치 `codex/remote-hub-p6`: `207254fe0` → `ff2913297`.
베이스는 재스택된 `codex/remote-hub-p5@8bcfcaa8e`. 17커밋 / 95파일로 가장 크다.

## 충돌 4건

`src/client/hub-client.ts`(2회), 터키어 관리 API 문서,
`tests/loopback-listener-admission.test.ts`.

hub-client 충돌이 본질적이었다. p6가 스키마 검증과 `x-opencodex-key-id` 에코를
추가하는데, 그 토대가 D2가 없앤 조건부 페치 경로 위에 있었다. validator 처리를
걷어내고 추가분만 살렸다.

커밋 `e7ca5bb89`("reject mismatched catalog validators")는 소스 변경 전체가
사라진 경로 전용이라 적용할 대상이 없었다. 의도는 이미 더 강하게 흡수돼 있다 —
어떤 304든 거절하는 것이 "보낸 ETag와 다른 304를 거절"보다 넓다. 그 사실을
테스트로 남겼다.

`loopback-listener-admission`은 흥미로웠다. p6가 wp6에서 내가 고친 것과
**같은 문제를 다르게** 고쳐뒀다: client role에 완전한 연결 블록을 채워 넣어
세 role 전부를 정확한 메시지로 단언한다. p6 쪽이 낫다 — 내 버전은 client에
대해 "거절된다"만 단언하고 별도 케이스로 보강했는데, p6는 한 루프로 끝낸다.
p6를 채택하고 내 중복 케이스를 제거했다.

원본 17커밋 보존, 마커 0건.

## T31 (P1) — abort 실패 시 토큰 identity

롤백 경로가 로컬 토큰을 복원한 **뒤** 허브에 abort를 요청했다. abort가
일시적으로 실패하면 로컬은 옛 키를, 허브는 새 키에 대한 pending 로테이션을
들고 있다. 양쪽이 어느 세대가 현재인지 불일치하고, 이게 "rollback was
incomplete"라는 메시지로만 드러난다.

순서를 뒤집었다. 어느 세대가 살아 있는지는 허브가 정하므로 먼저 확인하고,
동의한 뒤에만 로컬을 되감는다. 실패 시 두 후보와 pending 마커를 모두 디스크에
남긴다 — 물어보지 않고는 정말로 판정할 수 없기 때문이다.

## T32 (P2) — status가 인플라이트 백업을 삭제

orphan 정리 분기가 "백업 있음 + 토큰 있음 + pending 마커 없음"에서 발동한다.
그런데 `rotateConnectedClientKey`는 `.prev`를 쓴 **다음에**
`pendingOperation`을 저장한다. 그 사이에 `ocx connect status`가 돌면 정확히
저 조건을 보고, 진행 중인 로테이션이 의지하던 롤백 대상을 지운다.

게이트가 영속 상태를 다시 읽도록 했다 — 호출자의 스냅샷은 마커보다 앞설 수
있다 — 그리고 로테이션이 기록돼 있으면 정리하지 않는다.

## D4 — 이미 상당 부분 지켜지고 있었다

설계에서 요구한 "복구는 정지하고, 재개는 전이 권한을 가진 다음 rotate가"는
`inspectClientRotationRecoveryGate`가 이미 그렇게 동작한다. probe 없이
`recovery-required`로 멈추고 rotate를 안내한다. wp1에서 계약을 실행 가능하게
다시 쓴 것이 코드와 일치했다.

## 검증

- `bun run typecheck` 통과, `bun run privacy:scan` 통과.
- 포커스드 6파일 **302 pass / 0 fail**.
- 충돌 마커 0건.

## 커밋

| 범위 | 내용 |
| --- | --- |
| `83c57609f`..`65c1f85a7` | 원본 17커밋 재적용 |
| `ff2913297` | fix(hardening): confirm the abort before rewinding, and never delete an in-flight backup (신규) |
