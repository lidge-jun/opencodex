# 050 — WP6: PR #557 보안 경계 판단 + #533 정리

대상: PR #557 `fix(update): harden npm cache recovery preflight logs`
       PR #533 `fix(update): preserve proxy on npm cache failures`
계층: PR 정리 — 마지막

## 상태 (실측)

| | #557 | #533 |
| --- | --- | --- |
| 작성자 | `lidge-jun` (오너) | `WZBbiao` (기여자) |
| draft | true | true |
| mergeable | **MERGEABLE / CLEAN** | UNKNOWN |
| head | `b0434ea58` | — |
| 리뷰 | 미해결 스레드 0 | CHANGES_REQUESTED |
| CI | 8 SUCCESS + 1 null(pending/skipped) | Windows 2건 실패 이력 |
| reviewDecision | 공란 (승인 0) | CHANGES_REQUESTED |
| 파일 | 23개 | 23개 (동일) |

#557은 #533의 **메인테이너 인수본**이다. 조상 관계가 아니라 더 새 dev 위에
리베이스된 별도 작업이고, #533에 없는 두 수정을 갖고 있다:

1. npm 캐시가 same-UID이지만 실효 R/W/X 권한이 없을 때 **프록시 정지 경로 전에**
   fail-closed
2. 영속 업데이트 작업 상태에서 홈/캐시 경로와 uid/gid 제거
   (`sanitizeUpdateJobState`)

## 왜 이건 코드 작업이 아닌가

미해결 리뷰 스레드 0건, 실패 체크 0건. **기술적으로 남은 게 없다.** 남은 것은
오너만 내릴 수 있는 판단 하나다.

단, "전 매트릭스 초록"은 과장이었다(A 게이트 지적). 실제로는 8건 SUCCESS에
1건이 null — pending이거나 skip이다. c6 증거를 캡처할 때 그 null 체크가
무엇인지 명시한다. 승인은 0건이다.

## 보안 경계 사실관계

diff가 소유하는 것:

| 파일 | 하는 일 |
| --- | --- |
| `src/update/install-process.mjs` | npm install 실행 |
| `src/update/npm-cache-preflight.mjs` | `accessSync` R/W/X 게이트 |
| `src/update/job.ts` | `sanitizeUpdateJobState` — 영속 로그에서 경로·uid/gid 제거 |
| `src/config.ts` | 설정 |
| `bin/ocx.mjs` | 런처 |

AGENTS.md 기준으로 **"의존성 설치"** 경계에 정면으로 걸리고, 크리덴셜 인접
로그 편집도 포함한다. MAINTAINERS.md는 보안 민감 변경에 두 메인테이너 리뷰를
요구한다.

작성자 본인이 PR 본문에 명시했다: 설치 실패 시 nonzero 복구 정책은 메인테이너
판단으로 남겼고, draft이며 자동 머지되면 안 된다.

## 판단 구조

```
#557 머지 가능?
├─ 예 → #557 머지 → #533을 크레딧 코멘트와 함께 클로즈 → DONE
└─ 아니오 (두 번째 메인테이너 리뷰 필요) → NEEDS_HUMAN
   └─ #533은 그대로 열어둠 (대체본이 아직 안 들어갔으므로)
```

**이 work-phase의 정직한 기본 판정은 `NEEDS_HUMAN`이다.** MAINTAINERS.md가
요구하는 두 번째 메인테이너 리뷰는 에이전트가 대신할 수 없다. 최근 #491이
승인 0건·CHANGES_REQUESTED 상태로 머지된 선례가 있으나
(`260727_owner_decision_ledger/007_delta_260728.md` §7-B), **그건 반복할 선례가
아니라 기록된 문제**다.

## #533 처리

#557이 실제로 머지된 뒤에만 닫는다. 순서를 지키지 않으면 기여자 작업이 사라진
채 대체본도 없는 구간이 생긴다.

클로즈 코멘트에 담을 것:

- 인수 경위 (더 새 dev 위 리베이스 + 리뷰 지적 2건 반영)
- 대체 PR 번호와 머지 커밋
- WZBbiao 크레딧 명시
- Windows 테스트 실패가 이 PR 스택에서 왔고 인수본에서 해결됐다는 사실

지금 #533을 먼저 닫으면 알려진 Windows 결함을 남긴 채 기여자만 잃는다.

## 스코프 경계

IN: #557 상태 재확인, 보안 경계 판단 기록, 판단에 따른 머지 또는 NEEDS_HUMAN
기록, #533 클로즈(#557 머지 성사 시에만).
OUT: #557 코드 수정 — 남은 게 없다.
OUT: nonzero 설치 복구 정책 설계 — 작성자가 메인테이너 판단으로 남긴 별도 주제.
OUT: MAINTAINERS.md의 두 번째 메인테이너 요건 자체 — 거버넌스 문제다.

## 수용 기준 (c6)

둘 중 하나:

- `gh pr view 557 --json state,mergedAt` → MERGED **그리고**
  `gh pr view 533 --json state` → CLOSED (크레딧 코멘트 포함)
- 또는 보안 경계 판단이 `NEEDS_HUMAN`으로 기록되고 그 근거가 남음

두 번째 경로도 정당한 종료다. 판단을 회피한 것이 아니라 **권한 경계를 지킨
것**이며, D 요약에 실제 판정으로 명시한다.
