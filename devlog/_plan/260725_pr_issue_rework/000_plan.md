# 260725 PR/이슈 rework 통합 — 로드맵

## 목표

열린 PR 중 **우리가 직접 결함을 고쳐 통합할 수 있는 8건**을 dev에 올리고, 대응 이슈와 PR을
근거 코멘트와 함께 닫는다. 보안 경계 PR과 분할이 필요한 대형 PR은 병합하지 않고 구체적인
리뷰 코멘트만 남긴다.

## 착수 시점 사실

- 작업 워크트리: `/Users/jun/.codex/worktrees/ebcd/opencodex` (브랜치 `dev`)
- **소스 기준점(source baseline)** = `origin/dev` = `037e8f5e4fa32a82e4149acc509554f157656dad`
  - **갱신 (WP1 A-gate residual 반영):** `origin/dev`는 이후 `faaaf98f8306ee50d4b4a7ee64d95140c371812c`
    (README 문서 커밋)로 이동했다. 우리 대상 소스 파일(`src/adapters/google.ts`,
    `src/responses/parser.ts`, `src/adapters/kiro.ts`, `src/codex/auth-api.ts`)에는 변동이 없음을
    `git diff --stat 037e8f5e origin/dev -- <대상파일>` 빈 출력으로 확인했다.
    작업 브랜치는 `faaaf98f` 위로 rebase되었다.
  - `origin/dev`는 이 유닛 진행 중에도 움직일 수 있다. 각 WP 착수 시 `git fetch`로 재확인하고,
    대상 파일에 변동이 없으면 rebase만 하고 계약은 유지한다. 변동이 있으면 해당 문서를 amend한다.
- 작업 브랜치: `codex/260725-pr-rework`. 이 유닛의 모든 커밋이 여기에 쌓인다.
  WP0 문서 커밋 이후 `HEAD != origin/dev`인 것은 **정상**이다.
- **실행 기준점 규칙 (A-gate blocker 1 반영):** 각 구현 work-phase의 착수 assertion은
  `HEAD == 037e8f5e`가 아니라 다음 두 가지다.
  1. `git merge-base HEAD origin/dev` == `037e8f5e` (소스 기준점이 이동하지 않았다)
  2. `git diff --name-status origin/dev...HEAD`가 이 유닛이 의도한 파일만 보여준다
     (WP0 직후에는 `devlog/_plan/260725_pr_issue_rework/` 9개 문서만)
  각 WP는 직전 WP가 남긴 누적 브랜치 HEAD를 입력으로 받는다. `010`~`070`의
  "dev HEAD == 037e8f5e" 문구는 이 규칙으로 대체해 읽는다.
- **PRE_APPLY_HEAD 규칙 (WP1 A-gate residual 반영):** 각 WP의 changed-file 수용 기준은
  소스 기준점이 아니라 **그 WP 착수 직전 HEAD**를 기준으로 검사한다.
  1. 적용 전 `PRE_APPLY_HEAD=$(git rev-parse HEAD)`를 기록한다
  2. 적용·수정·커밋 후 `git diff --name-status $PRE_APPLY_HEAD..HEAD`가 그 WP의 대상 파일만
     보여야 한다
  `git diff --name-status 037e8f5e --`로 검사하면 앞선 WP의 산출물이 섞여 나오므로
  "대상 파일만" 기준을 절대 충족할 수 없다. `010`~`070`의 changed-file 수용 기준은
  모두 이 `PRE_APPLY_HEAD` 규칙으로 대체해 읽는다.

### 작업 점유 마커 (게시 완료)

다른 메인테이너의 중복·경합 작업을 막기 위해 2026-07-26 KST에 마커를 게시했다.

| 대상 | 건수 | 내용 |
|---|---|---|
| 통합 대상 PR | 8건 (#430 #436 #439 #370 #389 #449 #427 #385) | merge/rebase/force-push/close 보류 요청, 통합 브랜치와 검증 절차 안내, 원저작자 보존 명시 |
| 대응 이슈 | 3건 (#420 #435 #448) | 경합 PR 생성 보류 요청, 수정 진행 중 안내 |
| 리뷰 보류 PR | 11건 (#408 #424 #447 #445 #355 #434 #405 #429 #391 #426 #431) | merge/close 보류 요청, 상세 리뷰 예고, dev 통합 배치로 인한 rebase 예고 |

#403과 #437은 `NO_ACTION`이므로 마커도 게시하지 않았다.
- 직전 버그 스윕(`260725_bug_sweep`)이 13:24에 종료되어 #433/#432/#422/#404와 PR #376이 closed.
- 로컬 게이트 기준선(`a5ec15e3`, 소스 동일): `bun run typecheck` exit 0,
  `bun run test` 4151 pass / 0 fail (324 파일), `bun run privacy:scan` 통과,
  `bun run lint:gui` exit 0.
- 이 워크트리는 처음에 의존성이 없었다. `bun install`(루트)과 `gui`에서의 `bun install`을
  먼저 실행해야 게이트가 돌아간다.

## 제약

- 브랜치 정책: feature 작업은 `dev`를 향한다. `main` 승격과 릴리스 자동화는 이 유닛의 범위 밖이다.
- 런타임은 Bun 네이티브다. Node 전용 API나 컴파일 단계 가정은 금지.
- `src/` 동작 변경에는 해당 서브시스템 근처의 회귀 테스트가 필요하다.
- `bun run privacy:scan`은 항상 통과해야 하고, 요청 본문·API 키·계정 식별자 로깅을 추가하지 않는다.
- 보안 경계(인증, credential/token, OAuth, GitHub Actions, 릴리스 자동화, 의존성 설치)는
  `MAINTAINERS.md`상 명시적 보안 리뷰 대상이다.
- `devlog/`는 gitignore 대상이므로 문서 추가는 `git add -f`가 필요하다.

### 보안 경계 정책 (A-gate blocker 2 반영)

"보안 PR을 병합하지 않는다"는 표현은 부정확했다. 정확한 정책은 다음과 같다.

- **review-only (통합하지 않음):** #408, #424, #447, #445, #355, #426.
  이들은 권한 상승, SSRF, OAuth/credential 신규 경로, canonical 재활성화 우회를 포함한다.
- **승인된 통합 예외:** PR #370. 사용자가 이 유닛의 범위로 명시 승인했다.
  다만 auth/credential/account identity를 다루므로 `MAINTAINERS.md` 보안 리뷰 대상이며,
  WP4는 다음을 추가 조건으로 갖는다.
  1. credential·token·계정 식별자를 로깅하지 않음을 `privacy:scan`과 diff 검토로 확인
  2. 상태 purge가 `MAIN_CODEX_ACCOUNT_ID`에만 한정됨을 코드로 확인
  3. `origin/dev` push 전 사용자에게 auth 변경 포함 사실을 명시 보고
- WP8의 push는 사용자가 명시 승인했으나, #370이 포함된 병합은 위 3개 조건 충족 후에만 진행한다.

## 조사 근거

이 로드맵은 열린 PR 22건과 이슈 27건에 대한 병렬 코드 감사에서 나왔다. 판정 요약:

| 분류 | PR | 근거 |
|---|---|---|
| 결함 없음, 즉시 통합 | #430, #439 | 리뷰에서 merge-blocking 결함 미발견 |
| 우리가 고쳐서 통합 | #436, #370, #449, #427 | 각 1~2개의 구체적 결함 확인 |
| rebase + 게이트만 | #389, #385 | 기존 리뷰 지적 전부 해결됨 |
| 보안 리뷰 필요, 병합 보류 | #408, #424, #447, #445, #355 | 권한 상승, SSRF, OAuth/credential 경계 |
| 분할/재작업 요청 | #434, #405, #429, #391 | 96파일 혼재, 포함 관계, stale, fire-and-forget |
| 이미 종료 | #376 | dev `28066934`가 #373을 더 완전하게 해결 |

### 열린 PR 전량 disposition manifest (A-gate blocker 3 반영)

스냅샷 시각: `2026-07-25T23:40+09:00`. `gh pr list --state open`로 확인한 21건 전량.

| PR | disposition | 관련 WP | overlap 파일 |
|---|---|---|---|
| #430 | INTEGRATE | WP1 | `src/adapters/google.ts` |
| #436 | INTEGRATE + 우리 수정 | WP2 | `src/responses/parser.ts` |
| #439 | INTEGRATE | WP3 | `src/adapters/kiro.ts`, `src/bridge.ts`, `src/types.ts` |
| #370 | INTEGRATE + 우리 수정 (보안 조건부) | WP4 | `src/codex/auth-api.ts` 외 3 |
| #389 | INTEGRATE (rebase) | WP5 | `src/server/management/model-routes.ts`, `src/router.ts` |
| #449 | INTEGRATE + 우리 수정 | WP6 | `gui/src/provider-workspace/report.ts` |
| #427 | INTEGRATE + 우리 수정 (Dashboard rebase) | WP7 | `gui/src/pages/Dashboard.tsx`, `src/responses/state.ts` |
| #385 | INTEGRATE + 테스트 보강 | WP7 | `src/providers/registry.ts` |
| #408 | REVIEW_ONLY (권한 상승) | — | `src/lib/windows-elevation.ts`, `src/service.ts` |
| #424 | REVIEW_ONLY (SSRF) | — | `src/images/artifacts.ts`, `src/server/responses/core.ts` |
| #447 | REVIEW_ONLY (OAuth) | — | `src/oauth/kiro.ts`, `src/adapters/kiro.ts` — **WP3와 겹침** |
| #445 | REVIEW_ONLY (canonical 우회) | — | `gui/src/pages/CodexAuth.tsx` |
| #355 | REVIEW_ONLY (OAuth 이미지) | — | `src/images/artifacts.ts` — #424와 시그니처 충돌 |
| #426 | REVIEW_ONLY (C4 auth, 46파일, head `37431320`) | — | `src/codex/auth-api.ts`, `auth-context.ts`, `account-lifecycle.ts` (∩#370), `src/router.ts` (∩#389), `src/types.ts` (∩#439) — **WP3/WP4/WP5와 정면 충돌** |
| #434 | SPLIT_REQUEST (96파일) | — | provider/GUI 전역 |
| #405 | REWORK (#434에 포함됨) | — | `src/providers/registry.ts` — **WP7과 겹침** |
| #429 | REBASE_REQUEST (draft, stale) | — | `src/adapters/cursor/*` |
| #391 | REWORK (fire-and-forget) | — | `src/codex/subagent-model-fallback.ts`, `src/server/responses/core.ts` |
| #431 | REVIEW_ONLY (draft, head `d25eba5b`) | — | `src/providers/registry.ts`, `src/router.ts`, `src/types.ts` — **WP3/WP5/WP7과 겹침** |
| #403 | OUT_OF_SCOPE / NO_ACTION (maintainer 본인 PR, 별도 blocker 잔존, head `fcd3d682`) | — | `src/bridge.ts`, `tests/bridge.test.ts`, `src/server/responses/core.ts` — WP3와 겹치지만 이 유닛은 코멘트도 게시하지 않는다 |
| #437 | DEFER / OUT_OF_SCOPE (docs-only, head `86e963c6`) | — | `CONTRIBUTING.md`, `README.md`, `docs-site/.../contributing.md` — 충돌 없음 |

**충돌 의존에서 나오는 결론:** #426은 46파일 규모로 WP4(#370)와 같은 auth 파일을 고친다.
#370을 먼저 통합하면 #426은 대형 rebase 대상이 된다. 이는 예상된 결과이며, WP8의 #426
리뷰 코멘트에 "dev가 #370을 통합했으므로 rebase가 필요하다"는 사실을 반드시 포함한다.
같은 이유로 #447(WP3 이후), #405/#431(WP7 이후), #403(WP3 이후)의 rebase 필요성도
각 코멘트에 기록한다.

**정확한 코멘트 게시 대상 (A-gate 라운드2 blocker 1 반영):** WP8이 코멘트를 게시하는 PR은
정확히 **11건**이다 — #408, #424, #447, #445, #355, #434, #405, #429, #391, #426, #431.
#403과 #437은 `NO_ACTION`이므로 코멘트를 게시하지 않는다. #426과 #431의 리뷰 본문은
`080_review_only_prs.md`에 추가되어야 하며, 본문 없이 "rebase 필요"만 남기는 것은 금지한다.

**#437 확정 (A-gate 라운드2 blocker 2 반영):** docs-only이고 clean apply되지만, 이번 유닛의
통합 대상은 8건으로 고정한다. #437은 `DEFER`이며 WP7에 편승하지 않는다. 통합 PR 개수를
흐리지 않기 위한 결정이다.

열린 이슈 22건 중 이 유닛이 직접 닫는 것은 #420(WP1), #435(WP2), #448(WP6) 세 건이다.
나머지는 다음과 같이 분류한다.

- 대응 PR이 review-only여서 닫지 않음: #443(→#445), #425(→#426), #374(→#391)
- upstream-tracking으로 코드 수정 대상 아님: #417, #241, #92
- enhancement/roadmap으로 이 유닛 범위 밖(`OUT_OF_SCOPE`): #415, #414, #401, #386, #357,
  #330, #294, #201, #178, #177, #95, #42
- 증거 대기: #418(matching raw trace 필요)

dev에 **실제로 살아있는** 버그로 코드 확인된 것은 두 건이다.

- #435 — `src/responses/parser.ts:30`, `:59`가 raw block을 무검증 cast한다. `[null]` 입력 시
  `block.type` 접근에서 throw한다.
- #420 — `src/adapters/google.ts:103`이 text를 검증하지 않고 전송하고, `:123`이 빈 assistant
  `parts`를 전송한다.

## work-phase 맵 (dependency-ordered)

순서는 일정이 아니라 의존 구조다. 앞 단계의 검증된 출력이 다음 단계의 입력이 된다.

```
WP0 (docs)
 └─ WP1 #430 google parts ──┐
                            ├─ WP2 #436 parser (WP1의 빈 parts 방어에 의존)
 WP3 #439 kiro ─────────────┘
 WP4 #370 auth ── WP5 #389 model visibility ── WP6 #449 gui workspace ── WP7 #427/#385
                                                                              └─ WP8 병합/CI/close
```

| WP | 대상 | 문서 | 우리가 고칠 결함 |
|---|---|---|---|
| WP0 | 로드맵 | `000`~`080` | — (docs-only) |
| WP1 | PR #430 (#420) | `010` | 없음. 테스트 2케이스 보강 |
| WP2 | PR #436 (#435) | `020` | parser 가짜 콘텐츠 마커 |
| WP3 | PR #439 | `030` | 없음 |
| WP4 | PR #370 | `040` | auth-api transient null 캐시 파괴 |
| WP5 | PR #389 | `050` | 없음. rebase + 게이트 |
| WP6 | PR #449 (#448) | `060` | provenance 추론 오분류, Add 영구 비활성 |
| WP7 | PR #427 + #385 | `070` | 단위 표기(KB→KiB), discovery 테스트 부재 |
| WP8 | 병합·CI·close | `090` (영수증) | — |

**WP1 → WP2 순서는 강제다.** #436을 단독 적용하면 malformed content가 `[]`로 정규화되는데,
현재 dev의 Google adapter는 빈 배열을 그대로 빈 `parts`로 전송하므로 #420이 재발한다.
#430이 먼저 들어가야 이 경로가 막힌다.

## 알려진 상호 충돌

- **#447 ↔ #439**: `src/adapters/kiro.ts`와 `src/types.ts`의 `createKiroAdapter` 영역이 겹친다.
  포함 관계는 없다. WP3에서 #439가 먼저 들어가므로 #447은 이후 rebase 대상이 된다.
- **#434 ⊃ #405**: `derive.ts`, `free-directory.ts`, `registry.ts`, parity test의 최종 blob이 동일하다.
- **#424 ↔ #355**: 둘 다 `src/images/artifacts.ts`를 신규 생성하며 `materializeInlineImage`
  시그니처가 호환되지 않는다. 포함 관계 없음.
- **#385 ↔ #405/#434**: `src/providers/registry.ts`와 parity test가 겹친다. 어느 쪽이 먼저 들어가도
  작은 rebase가 필요하다.
- **#445 ↔ #449**: 공유 파일 0개. 상호 충돌 없다.
- **#426 ↔ #370/#389/#439**: `src/codex/auth-api.ts`, `auth-context.ts`,
  `account-lifecycle.ts`가 #370과, `src/router.ts`가 #389와, `src/types.ts`가 **#439(WP3)와**
  겹친다. #426은 review-only이므로 이 유닛은 진행하지만, 코멘트에 세 WP 모두에 대한 rebase
  필요를 기록한다.
- **#431 ↔ WP3/WP5/WP7**: `src/providers/registry.ts`, `src/router.ts`, `src/types.ts`.
  draft이므로 이 유닛은 진행한다.
- **#403 ↔ WP3**: `src/bridge.ts`, `tests/bridge.test.ts`, `src/server/responses/core.ts`.
  maintainer 본인 PR로 별도 blocker가 남아 있어 `NO_ACTION`(코멘트도 게시하지 않음).

## Verifier

각 구현 work-phase의 C는 다음을 실제로 실행하고 출력을 영수증에 남긴다.

```bash
bun run typecheck        # exit 0
bun run test             # 0 fail
bun run privacy:scan     # 통과
bun run lint:gui         # exit 0
```

GUI가 바뀐 work-phase는 추가로:

```bash
cd gui && bun test tests && bun run build
```

WP8은 exact-SHA hosted `Cross-platform CI`와 `Service lifecycle`이 둘 다 success여야 닫힌다.
선행 SHA의 성공은 후행 커밋의 증거가 아니다.

## Stop condition

통합 대상 **8개 PR**(#430 #436 #439 #370 #389 #449 #427 #385)의 변경이 `dev`에 병합되어
로컬과 `origin/dev` SHA가 일치하고, 병합 SHA의 두 hosted 게이트가 success이며,
병합된 8개 PR과 대응 이슈 3건(#420, #435, #448)이 근거 코멘트와 함께 closed이고,
보류 대상 **11건**(#408 #424 #447 #445 #355 #434 #405 #429 #391 #426 #431)에 구체적
리뷰 코멘트가 게시된 상태. #403과 #437은 `NO_ACTION`이므로 게시 대상이 아니다.

## Terminal outcomes

- `DONE` — 위 Stop condition 충족.
- `NOOP` — 해당 PR이 이미 dev에 반영되어 코멘트 후 close만 남은 경우.
- `BLOCKED` — 원격 거부, 같은 실패의 CI 3회 연속, 또는 원저자 의도 없이 해석 불가한 conflict.
- `UNSAFE` — 진행에 보안 경계 PR 병합이 필요해진 경우. 중단하고 사용자 승인을 받는다.
- `NEEDS_HUMAN` — 결함 수정 방향이 원저자 설계 의도와 충돌해 판단이 필요한 경우.

## Escalation

통합 충돌이나 신규 회귀는 main session이 회수한다. 보안 경계 판단과 provider 신뢰 표현
(#385 BizRouter 등록 등)은 자동 결정하지 않고 사용자에게 되돌린다.

## 실행 영수증 (WP8)

### 병합

- `origin/dev`: `faaaf98f` → **`ebc62d1f`** (fast-forward, force push 없음)
- 커밋 23개 = 구현 7 + devlog 16
- `bun run prepush` exit 0 (내부 테스트 4222 pass / 0 fail)

### hosted CI — exact SHA `ebc62d1f`

`Cross-platform CI` run `30167215384`: **6/6 job success**

| job | 결과 |
|---|---|
| ubuntu-latest | success |
| macos-latest | success |
| windows-latest | success |
| npm-global ubuntu-latest | success |
| npm-global macos-latest | success |
| npm-global windows-latest | success |

`Service lifecycle`은 path filter(`src/service.ts`, `src/cli.ts`, `src/cli/index.ts`,
`src/lib/bun-runtime.ts`, `package.json`) 대상 파일을 이 배치가 변경하지 않아 트리거되지 않았다.
`git diff --name-only faaaf98f..ebc62d1f`로 확인했다.

### 통합 PR 8건 — 영수증 코멘트 후 closed

| PR | 통합 커밋 | 원저자 |
|---|---|---|
| #430 | `74795ad6` | snowyukitty |
| #436 | `4cc7f692` | snowyukitty |
| #439 | `fc517004` | coseung2 |
| #370 | `03e3f1b4` | duansy123 |
| #389 | `323bb93f` | csa906 |
| #449 | `121a3512` | apple-ouyang |
| #427 | `15dfa270` | dev-shinyu |
| #385 | `15dfa270` | latemonk |

모든 커밋에 `Co-authored-by`로 원저작자를 보존했다.

### 이슈 3건 — 근거 코멘트 후 closed

`#420`(WP1), `#435`(WP2), `#448`(WP6). 각 코멘트에 통합 커밋 SHA, 활성화 증거,
전체 게이트 결과, hosted CI 결과를 포함했다.

### 리뷰 코멘트 11건 게시

- 보류 10건: #408 #424 #447 #445 #355 #434 #405 #429 #391 #431
  각 코멘트에 구체적 결함(파일:라인)과 게시 시점 rebase 완료 사실을 포함했다.
- #426: head가 `37431320` → `2ff3e24b`로 이동해 **STALE**. 기존 초안을 게시하지 않고
  재감사 예고와 함께 privacy finding 및 rebase 필요 사실만 전달했다.
- #403 / #437: `NO_ACTION`, 코멘트 없음.

### Terminal outcome

`DONE`. 계획한 통합 8건, 이슈 close 3건, 리뷰 게시가 모두 완료됐고 exact-SHA hosted CI가 통과했다.
잔여 후속 후보(범위 밖으로 이관): Cursor malformed-only 첫 turn `resumeAction`,
`contentPartsToText([])`의 `[image]` 허위 마커, `file_url` 스키마 부재, Kiro 빈 assistant history,
tool-result remote image representable 불일치, #426 재감사.
