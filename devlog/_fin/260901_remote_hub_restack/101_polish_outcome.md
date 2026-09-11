# 폴리싱 결과 — 노출 / 요청 / 롤백

감사(`100`)가 낸 위반 3건과, 적대적 리뷰가 추가로 잡은 4건을 닫았다.
리뷰 verdict는 **FAIL**이었고 내 감사가 불완전했다는 지적이 맞았다.

## 내가 놓친 것 — 리뷰가 잡음

**연결 전 로컬 카탈로그가 복구되지 않았다.** 이게 가장 무거웠고, 사용자가
말한 "다시 로컬로 롤백"의 정확히 그 지점이다. connect는
`DEFAULT_CATALOG_PATH`에 있던 것을 덮어쓰는데, 원본 스냅샷을 메모리
(`priorCatalog`)에만 뒀다. 그건 같은 실행 안에서 실패해 롤백하는 경우만
커버한다 — disconnect는 다른 날 다른 프로세스다. 영속 상태에는 원격 카탈로그의
지문만 있어서, disconnect는 원격 카탈로그를 **지우고** "native Codex state was
restored"라고 보고했다. 사용자가 원래 갖고 있던 카탈로그는 그냥 사라진다.

토큰은 재발급되고 config는 저널에 있다. 카탈로그는 다른 어디에서도 복원할 수
없는 유일한 아티팩트다.

**부분 프로필 복구가 성공으로 위장됐다.** `restoreJournalState`가 삼켜진
unlink 뒤에 `profileRestored = true`를 무조건 세팅했다. 원본 프로필이 없던
경우 "우리가 만든 걸 지운다"가 실패해도 complete로 보고되고, 그러면 저널이
지워진다 — 남은 프로필이 우리 것이라는 유일한 기록이. 사용자는 복구됐다는
말을 듣고, 우리 프로필은 아무도 가리키지 않는 채로 디스크에 남는다.

**standalone에 두 UI가 더 남아 있었다.** 키 로테이션 컨트롤(모든 API 키에)과
"Source: local usage.jsonl" 줄. 둘 다 dev에는 없다.

## 수정

### 요청 — 서버가 롤을 말한다

서버가 이미 세션 메타를 주입하니, 같은 자리에 `opencodex-runtime-role`을
싣는다. 세션 블록과 **독립적으로** 내보낸다 — standalone은 GUI 세션을 발급하지
않으므로, 세션에 묶으면 정작 필요한 경우가 빈다.

클라이언트는 묻는 대신 읽는다. 태그가 없으면 standalone으로 읽는데, 구버전
서버·별도 호스팅 GUI·Vite 개발 서버가 전부 여기 해당하고 셋 다 요청을 보내면
안 되는 쪽이다.

### 노출 — 기본이 "아무것도 안 함"

`targetsSettled`가 standalone에서 `true`로 시작한다. 발견할 게 없으니
기다릴 것도 없다. 그리고 발견 실패는 배너지 대체가 아니다 — 느리거나 재시작
중인 프록시가 standalone 사용자의 대시보드를 앗아가지 않는다.

rotation 핸들러는 연결된 런타임에만 전달한다(없으면 섹션이 렌더되지 않는다).
usage source 행도 연결됐을 때만 — "어느 저장소가 이 숫자를 줬나"는 저장소가
둘일 때만 존재하는 질문이다.

### 롤백 — 되돌리기지 지우기가 아니다

`priorCatalog`를 연결 상태에 영속화하고 disconnect가 되돌려 쓴다.
`""`는 "정말 없었다"라서 제거가 곧 복원이다. 필드가 없는 옛 연결은 기존
동작을 유지한다 — 복원할 대상이 기록된 적이 없으니 그게 정직하다.
소유권 검사는 그대로다: connect 이후 편집된 카탈로그는 사용자 것이고
`changed`로 거절한다. 결과에 `catalogRestored`를 더해 두 결과를 구별한다.

프로필은 **확인된** 제거만 성공으로 친다. ENOENT는 성공인데, 파일이 이미
없는 것이 제거가 원한 결과이기 때문이다.

## 검증

- GUI 스위트 **1207 pass / 0 fail**.
- 포커스드: client-connect, codex-journal, config, cli-capabilities,
  management-route-registry, gui-static, server-management-auth 전부 그린.
- `bun run typecheck`, `bun run lint:gui` 클린.
- 레드-퍼스트 확인: standalone 무요청(0 fetch), 카탈로그 복구, 프로필 계약
  셋 다 수정 전 실패를 확인한 뒤 적용했다.

## 정직하게 남기는 것

프로필 unlink 실패는 **런타임으로 재현할 수 없다.** unlink를 실패시키려면 Codex
홈에 쓰기를 막아야 하는데, 그러면 같은 함수의 앞선 atomic config 쓰기가 먼저
던진다. 그래서 그 계약은 source-level로 고정하고 테스트에 이유를 적었다.
조작된 런타임 실패를 만들어내는 것보다 모양을 단언하는 쪽이 증명하는 바가 많다.

## 리뷰가 지적했으나 이번에 다루지 않은 것

- `/healthz`의 `guiPairCapability`, `/readyz`의 프로토콜 메타데이터, 관리
  CORS의 GUI-세션 헤더 광고. UI가 아니라 프로토콜 표면이고, 롤 게이팅이
  프로토콜 협상 자체를 깨뜨릴 수 있어 별도 판단이 필요하다.
- disconnect의 비트랜잭션성: 카탈로그 충돌 시 config는 복구됐는데
  `runtimeRole=client`가 남는 경로. 에러로 보고되므로 조용한 실패는 아니지만,
  복구 가능한 상태 기계로 만드는 것은 이번 스코프를 넘는다.

## 커밋

| 단계 | 커밋 | 내용 |
| --- | --- | --- |
| p3 | `c5420db86` | 카탈로그 복구 + 프로필 계약 |
| p4 | `4aad8abbf` | 롤 메타 태그, standalone 무요청, 페이지 게이트 제거 |
| p6 | `2349d39e8` | standalone rotation UI + usage source 행 제거 |

## 최종 체인

| 단계 | head |
| --- | --- |
| design | `36992baa9` |
| p1 | `07d7f1006` |
| p2 | `2b36ad496` |
| p3 | `c5420db86` |
| p4 | `4aad8abbf` |
| p5 | `072cc29c3` |
| p6 | `2349d39e8` |

6개 엣지 전부 부모가 자식의 조상이고, 오염 커밋은 없다.
