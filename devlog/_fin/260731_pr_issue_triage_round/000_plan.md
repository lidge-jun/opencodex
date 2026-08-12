# 000 — PR·이슈 트리아지 라운드 계획

`260731_pr_merge_round`가 끝난 자리에서 이어간다. 그 라운드는 PR 13건과 이슈
11건을 정리하고 `7132828b3`으로 dev에 들어갔다. 남은 것들은 "나중에"가 아니라
**왜 안 태웠는지**가 기록된 채로 남았다. 이 유닛은 그 기록을 현재 트리 기준으로
다시 검증하고, 다음 라운드에서 실제로 손댈 수 있는 목록을 뽑는다.

## 기준점 — 동결 인벤토리

| 항목 | 값 |
|---|---|
| 인벤토리 동결 시각 | 2026-07-31T05:05Z |
| dev HEAD | `7132828b3 merge: the 260731 PR round into dev` |
| dev CI | Cross-platform CI `success`, Service lifecycle `success` (2026-07-31T04:40:05Z) |
| 열린 PR | 27건 (전부 base=`dev`, 위반 0건. draft 5건: #557 #569 #644 #747 #750) |
| 열린 이슈 | 41건 |
| 직전 유닛 | `devlog/_plan/260731_pr_merge_round/` (`000`~`050`) |

숫자는 이번 실행에서 `gh pr list --state open --limit 100`과
`gh issue list --state open --limit 200`로 직접 세었다. 직전 라운드 문서의
"43건"은 그 시점 값이고 지금은 다르다 — 그래서 문서 숫자를 인용하지 않고 다시 셌다.
직전 라운드가 정리했다는 "PR 13건·이슈 11건"도 이 유닛에서 재대조하지 않은
집계값이므로 근거로 쓰지 않는다. 필요한 건 `010`/`020`이 각 항목을 직접 확인한다.

**인벤토리는 동결값이다.** 트리아지 도중 새 PR·이슈가 열려도 이 라운드의 매트릭스는
위 시각 기준으로 닫는다. 그렇지 않으면 `010`과 `020`이 서로 다른 스냅샷을 보게 되고,
이슈↔PR 상호참조가 어긋난다. 라운드 종료 시 `gh`를 다시 돌려 그 사이 생긴 항목만
`040`에 이월 목록으로 남긴다.

행마다 기록하는 필드: PR은 번호·head SHA·base·draft 여부·**메인테이너 승인 상태**·
필수 CI 결과·변경 경로·연결 이슈, 이슈는 번호·라벨·중복/업스트림 여부·
보고자 증거 유무·덮는 PR.

## 이 유닛이 답해야 하는 것

1. 열린 PR 27건 각각: 지금 dev에서도 결함이 살아 있나, 이미 대체됐나, 무엇이 막고 있나.
2. 열린 이슈 41건 각각: 재현되나, 랜딩된 커밋이 이미 고쳤나, 어느 PR이 덮나.
3. 그중 **우리가 직접 고쳐서 머지할 수 있는 것**은 무엇인가. 의존 순서는.
4. 다음 구현 라운드의 decade 문서 지도.

3번이 이 유닛의 목적이다. 1·2번은 3번의 근거일 뿐이다.

## 방법

**증거 기준.** 각 행은 이번 실행에서 읽은 앵커를 하나 이상 갖는다 — `path:line`,
커밋 SHA, 또는 PR/CI 상태. 직전 라운드 문서에서 옮겨 적은 판단은 근거로 치지 않는다.
같은 파일을 건드린 커밋이 있다는 사실도 근거가 아니다. 보고된 실패 모드가 실제로
해소되는지까지 본다 (`260730_issue_triage_dev_head/000`에서 세운 기준을 유지한다).

**서브에이전트.** `gpt-5.6-luna`, reasoning effort max. 읽기 구획을 겹치지 않게
나눠 파견하고, 쓰기 권한은 주지 않는다. 판단과 통합은 메인 세션이 한다.

**보안 경계.** `AGENTS.md`가 정한 대로, 미공개 취약점 분석·심각도 평가·재현 절차는
`devlog/`에 쓰지 않는다. 트리아지 중 미수정 보안 결함이 나오면 추적 문서에는
중립적 포인터만 남기고 분석은 `.tmp/`로 보낸다.

## 먼저 확인한 것: Windows CI 적색의 정체

열린 PR 27건 중 11건이 `windows-latest:FAILURE`다(동결 시각 기준). 이걸 PR별 결함으로
읽으면 매트릭스가 왜곡되므로 먼저 확인했다.

PR #776(`+18/-2`, provider 프리셋에 baseUrl 선택지 하나 추가)의 실패 로그
**발췌**(run `30594436278`, 실제로는 12건 실패):

```
(fail) release helper > preflight runs typecheck, test suite, and privacy scan before version bump on main dry-runs
(fail) release helper > dispatch pins the audited release SHA via expected-sha
(fail) server local API auth > missing or non-string detail never authorizes a pool retry
error: ENOENT: no such file or directory, uv_spawn 'C:\Users\runneradmin\.bun\bin\bun.exe'
```

18줄짜리 provider 프리셋 변경이 릴리스 헬퍼와 로컬 API 인증을 깨뜨릴 수는 없다.
그리고 dev HEAD의 같은 워크플로는 초록이다. 원인은 dev에 나중에 들어간 두 커밋이
PR 브랜치에 없는 것이다:

- `371aa579d fix(windows): resolve PATH whatever casing the child was handed`
  (`src/lib/win-exec.ts`, `tests/release-helper.test.ts`, `tests/win-exec.test.ts`)
- `0af17fbfd fix(windows): route every gh and release command through the shared launcher`
  (`scripts/release.ts` 외 launcher 경로)

### stale-base 판정 절차 (PR마다 개별 적용)

"윈도우가 빨가면 stale-base"로 뭉뚱그리면 PR 고유 결함을 놓친다. #793(run
`30596144266`)은 release-helper 4건만 실패하고 `uv_spawn`은 없다 — #776과 실패
집합이 다르다. 공유되는 건 **실패 클래스**지 실패 목록이 아니다. 그래서 행마다
아래를 밟고, 결과를 `010`의 CI READING 칸에 적는다.

1. 실패한 테스트 파일 이름을 뽑는다.
2. PR이 바꾼 경로와 대조한다(`gh pr diff <n> --name-only`).
3. 실패가 전부 알려진 인프라 클래스(`tests/release-helper.test.ts`,
   `tests/win-exec.test.ts`, `bun.exe` `uv_spawn` ENOENT, 그리고 이들에
   딸린 `server-local-api-auth` 파생)에 속하고 PR 변경 경로와 무관하면
   → `stale-base`.
4. 하나라도 PR이 건드린 표면과 겹치면 → `real failure`로 분류하고 그 테스트
   이름을 근거로 남긴다.
5. 판단이 갈리면 `stale-base`로 내리지 않는다. `UNVERIFIED — 리베이스 후 재확인`
   으로 남긴다. 안전한 쪽은 의심하는 쪽이다.

## 작업 단계 지도

선형 의존이다. WP2는 WP1에 의존한다 — 이슈 판정에 `COVERED-BY-PR`이 있고, 어느 PR이
어느 이슈를 덮는지는 `010`이 확정해야 알 수 있다. 처음엔 둘을 독립으로 뒀는데
감사가 이 교차 의존을 잡아냈다. 병렬로 돌리면 두 문서가 서로 다른 PR 상태를 보고
상호참조가 어긋난다.

| 단계 | 문서 | 산출물 | 선행 |
|---|---|---|---|
| WP1 | `010_pr_triage_matrix.md` | 열린 PR 27건 전체 처분 | 동결 인벤토리 |
| WP2 | `020_issue_triage_matrix.md` | 열린 이슈 41건 전체 처분 | WP1 (PR 커버리지) |
| WP3 | `030_mergeable_bug_list.md` | 다음 라운드에 태울 수 있는 것, 의존 순서 | WP1, WP2 |
| WP4 | `040_next_round_roadmap.md` | 구현 라운드 decade 지도 + 게이트 | WP3 |

`cxc-pabcd`의 one-work-phase-one-cycle 불변식에 따라 각 단계는 온전한 PABCD
사이클로 돈다. 한 B에서 두 문서를 쓰지 않는다.

## 판정 어휘

PR:

| 판정 | 뜻 |
|---|---|
| `MERGE-NOW` | 아래 머지 게이트를 **전부** 통과한 것 |
| `NEEDS-REBASE` | 내용은 괜찮으나 충돌 또는 stale base |
| `NEEDS-CHANGES` | 결함은 진짜지만 구현·테스트·증거가 미달 |
| `SUPERSEDED` | dev가 이미 같은 문제를 해결함 |
| `CLOSE` | 더 이상 유효하지 않음 |
| `DEFER` | 유효하나 자체 사이클 또는 오너 판단 필요 |

### `MERGE-NOW`의 실제 조건

`MAINTAINERS.md:30-31`은 **메인테이너 1인 이상의 승인**과 **필수 CI 통과**를
머지 전제로 요구한다. 처음 판정 정의에는 이게 빠져 있었고 감사가 잡았다. 기술적으로
깨끗한 PR을 "지금 머지 가능"으로 적으면 통과하지 않은 게이트를 통과한 것처럼 만든다.

`MERGE-NOW`는 다음이 전부 참일 때만 쓴다:

1. 결함이 dev HEAD에 살아 있다(코드 앵커로 확인).
2. 결함 없이는 실패하는 회귀 테스트가 있다.
3. base가 `dev`다(스택 PR 예외는 아래).
4. 필수 CI가 초록이거나, 적색이 stale-base로 **개별 입증**됐고 리베이스로 해소된다.
5. 보안 리뷰 표면(`AGENTS.md`)을 건드리지 않는다. 건드리면 최대 `DEFER`다.
6. 메인테이너 승인이 남아 있다면 그 사실을 행에 명시한다.

6번이 미충족이면 `MERGE-NOW (승인 대기)`로 적는다. 승인은 우리가 대신할 수 없다.

### base 브랜치 게이트

`AGENTS.md` 브랜치 정책상 모든 PR은 `dev`를 타깃해야 한다. 동결 시각 기준 27건
전부 `base=dev`다(위반 0건). 다만 **열린 PR의 head를 타깃하는 스택 자식 PR은
의도된 워크플로**이고 `enforce-target`이 그 경우 wrong-base 게이트를 건너뛴다.
따라서 base가 `dev`가 아닌 PR을 발견하면 자동으로 위반 처리하지 않고, 부모 PR이
아직 열려 있는지부터 확인한 뒤 `010`에 스택 관계를 적는다.

이슈:

| 판정 | 뜻 |
|---|---|
| `FIXED-ON-DEV` | 랜딩된 커밋이 실제로 실패 모드를 해소 |
| `OPEN` | 현재 코드에서 재현 |
| `PARTIAL` | 일부만 해소, 잔여 있음 |
| `COVERED-BY-PR` | 열린 PR이 덮음 |
| `NEEDS-DECISION` | 제품 판단 필요 |
| `UPSTREAM` | 업스트림 추적 목적 |

이슈 행에는 라벨, 중복 대상, 덮는 PR, 보고자 재현 증거 유무를 함께 적는다.
`upstream-tracking` 라벨(#417 #241 #92 #418)은 오래됐다는 이유로 닫지 않는다 —
추적 목적이 살아 있는 한 유효하다.

## 종료 게이트

문서만 바꾸지만 게이트는 돈다. `privacy:scan`은 `devlog/`를 실제로 읽으므로
(`AGENTS.md:47-50`) 공개 devlog에서는 형식적 절차가 아니다.

- `bun run typecheck` — 소스 미변경 회귀 가드
- `bun run test tests/repo-hygiene.test.ts` — gitlink·제외 경로 재유입 차단
- `bun run privacy:scan` — 공개 devlog 내용 스캔
- `bun run test` — `AGENTS.md:105-106`이 비자명 변경에 요구하는 전체 스위트.
  이 유닛은 소스를 안 건드리므로 통과가 기대값이고, 실패하면 그건 우리 변경이
  아니라 트리 상태 문제다. 그 사실 자체가 `030`에 들어갈 정보다.
- `git status`로 이 유닛 파일만 스테이징됐는지 확인

## 종료 처리

`devlog/README.md:26-28`대로, 터미널 결과가 기록되면 유닛은 `_fin/`으로 옮긴다.
다만 이 유닛의 산출물은 **다음 구현 라운드의 입력**이다. 그 라운드가 `030`/`040`을
소비하기 전에는 `_plan/`에 남는다. 이월 조건: `040`의 모든 단계가 후속 유닛에
반영되면 그때 `_fin/`으로 옮기고 터미널 결과(`DONE`/`NOOP`/`BLOCKED`/`NEEDS_HUMAN`)를
적는다.

## 범위 밖

`src/`, `tests/`, `gui/`, `docs-site/`, `scripts/`, `.github/` 수정. push.
머지·리베이스·브랜치 변경. GitHub 코멘트·라벨·클로즈·머지. 릴리스와 배포.

이 유닛은 문서만 만든다. 고치는 건 다음 라운드다.
