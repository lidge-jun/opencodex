# wp4 결과 — p3(#2777) 재스택 + T22

브랜치 `codex/remote-hub-p3`: `aa2615953` → `ad1ab25d8`.
베이스는 재스택된 `codex/remote-hub-p2@b7282858b`.

## 충돌 3건 — 전부 순수 추가

`src/cli/status.ts`, `tests/cli-dispatch.test.ts`, `src/cli/dispatch.ts`.
dev와 이 단계가 서로 다른 import와 블록을 같은 위치에 넣은 것뿐이라
양쪽을 모두 살렸다. wp3에서 정규식으로 마커를 지우다 중괄호를 잃은 전례가
있어, 이번에는 마커 줄 번호를 정확히 지정해 삭제하고 중괄호 균형을 매번
확인했다.

원본 11커밋 전부 보존.

## T22 (P1) — process 소유 journal이 연결을 가둔다

리뷰 표현은 "연결 전 기존 Codex journal 재소유 필요"였다. 코드를 따라가니
실제 증상은 더 나빴다.

`ocx start` 후 connect하는 것은 예외가 아니라 **정상 경로**다. 그 시점에
라우팅은 이미 주입돼 있고 journal 소유자는 프록시 프로세스다. connect는
소유권을 가져오지 못한다 — `writeJournal()`이 이미 주입된 config를 가진
journal을 덮어쓰지 않기 때문이다(`journal.ts:99`). 그래서 process 소유자가
연결 상태로 그대로 살아남는다.

그리고 `disconnectClient()`가 자기 키와 안 맞는 소유자를 전부 충돌로 읽고
거부했다. 결과적으로 **운영자가 disconnect할 수 없다.** 아티팩트는 보존되니
데이터를 잃지는 않지만, 연결 상태에서 나갈 방법이 없다.

수정: process 소유 journal은 같은 도구가 쓴 주입 이전 baseline이므로 우리가
되감을 대상이다. 진짜 충돌은 **다른 client 키**가 소유한 경우뿐이고, 그건
여전히 거부한다(기존 테스트도 그대로 통과).

journal 없이 라우팅만 주입된 경우는 별도 메시지로 분리했다. 기존에는 소유권
오류로 뭉뚱그려졌는데, 복원할 baseline 기록이 아예 없다는 게 실제 원인이다.

**레드-퍼스트:** 수정을 되돌려 새 테스트가 실패하는 것을 확인한 뒤 복원했다.
처음에 픽스처 조건이 `disconnect-conflict`에만 걸려 있어 새 시나리오가
codex를 선택조차 하지 않는 실수가 있었고, 그래서 "통과"가 가짜였다. 조건을
고친 뒤에야 진짜 레드가 나왔다.

## gui api-auth-memory

wp3에서 소유 단계를 p2로 재배정했으므로 여기서는 회귀만 확인했다.

## 검증

- `bun run typecheck` 통과.
- 포커스드 8파일 **324 pass / 0 fail**
  (client-connect, cli-dispatch, cli-registry, cli-status-json,
  cli-headless-parity, cli-start-journal-order, config, claude-cli).

## 남은 것

T23(신뢰할 수 없는 `Content-Length`에 대한 응답 읽기 제한)과
T24(connect 워크플로 문서화)는 wp8에서 처리한다.

## 커밋

원본 11커밋은 authorship과 메시지를 보존했고, T22 수정은
`ad1ab25d8` 한 커밋으로 분리했다. 앞선 단계들과 같은 원칙이다.

| 범위 | 내용 |
| --- | --- |
| `859bc17aa`..`232ad4e4b` | 원본 11커밋 재적용 |
| `ad1ab25d8` | fix(connect): a process-owned journal is ours to unwind, not a conflict (신규) |
