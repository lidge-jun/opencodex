# 090 — wp: 원격 PR 랜딩 라운드 2 (#575 / #652 / #711)

## 이 문서의 위치

`000_research.md`의 후보 선별을 이어받되, **라운드 1 이후 실제로 바뀐 상태**를 반영한
amendment다. 라운드 1은 #711/#646/#652를 후보로 잡았고 그 뒤 세션에서 이슈 정리
(#712/#591/#401 클로즈, #562 클로즈)와 문서화(`aa2220726`)가 끝났다. 이번 work-phase는
**머지 가능한 PR을 실제로 랜딩**한다.

DIFFLEVEL-ROADMAP-01 stale check 결과 라운드 1 대비 달라진 점:

| 항목 | 라운드 1 | 지금 (실측) | 영향 |
|------|----------|-------------|------|
| #575 | 후보 아님 | `CLEAN`, 체크 12/12 green, 오너 PR | **1순위로 승격** |
| #711 | windows `cancelled` | 재실행 걸어둠, `pending` | CI 대기 후 랜딩 |
| #646 | 2순위 (draft, CHANGES_REQUESTED) | 변동 없음 | 이번 라운드 제외 |
| #652 | 3순위 | 변동 없음 (`CLEAN`+`APPROVED`) | 2순위로 |
| #710 | 계획 존재 (050) | **사용자가 직접 작업 중** | 범위에서 제외 |

## 작업 범위 경계 (STRICT)

사용자가 `#710`을 직접 구현 중이며 워크트리에 미커밋 변경이 있다:

```
M src/cli/interactive-confirm.ts   M src/oauth/kiro-credentials.ts
M src/oauth/kiro.ts                M src/service.ts
M tests/interactive-confirm.test.ts  M tests/kiro-*.test.ts
M tests/oauth-refresh.test.ts        M tests/startup-prompt.test.ts
```

**이 파일들은 읽기조차 최소화하고 절대 수정하지 않는다.** 머지 커밋이 이들을 스테이징에
끌어들이면 안 되므로, 각 머지 전후로 `git status --porcelain`을 확인해 미커밋 변경이
그대로 unstaged로 남아 있는지 검증한다. 이것이 이 work-phase의 실패 조건 1번이다.

## wp 목표

`dev`에 두 PR을 랜딩하고, 세 번째는 CI 결과에 따라 처리한다.

### 1. #575 — TLS 호스트명 불일치 구분 (오너 PR, 보안 부수효과)

변경 규모: 3파일 +145/-7.

```
src/server/responses/core.ts            +11 -7   (3개 catch 사이트 → 헬퍼 위임)
src/server/responses/upstream-error.ts  +48      (NEW: describeUpstreamConnectFailure)
tests/upstream-connect-error.test.ts    +93      (NEW: 8 케이스)
```

왜 지금 넣는가 — 단순 메시지 개선이 아니라 **자격증명 유출 수정**을 포함한다. provider
base URL이 `https://user:token@host/` 형태일 때 기존 코드가 오류 메시지에 URL을 그대로
되돌려줬다. PR 본문의 수정 전 측정값: `FULL OUTPUT CONTAINS SECRET? true`. 양쪽 분기가
userinfo를 `<redacted>@host`로 마스킹한다.

검증 완료 (로컬):

- `bun x tsc --noEmit` → 통과
- `bun test tests/upstream-connect-error.test.ts` → 8 pass (userinfo 리다ekt 케이스 포함)
- 관련 광범위: `tests/responses*.test.ts` 등 10파일 → 138 pass
- **`dev` 최신과 시험 머지** → 자동 병합 성공, 충돌 없음
- **병합 상태에서** tsc + 대상 테스트 재실행 → 통과 (머지 후 `dev` green 직접 증거)

`core.ts`가 이 PR 작성 후 8건 이상 변경됐으나(`#599`, `#602`, `#593`, `#588` 등) 자동
병합된다. `git merge-tree`의 "changed in both"는 양쪽 수정 표시일 뿐 충돌이 아님을
실제 `git merge --no-commit`으로 확인했다.

**#553을 닫지 않는다.** PR 본문 첫 줄과 오너의 #553 코멘트가 명시: 오류 표시만 개선하고
TLS 가로채기(Shadowrocket TUN + 사내 VPN이 `198.18.0.17`로 해석) 자체는 프록시 밖이다.
머지 후에도 #553은 열어둔다.

### 2. #652 — bounded model discovery contract

변경 규모: 23파일 +1332/-124. `CLEAN` + Wibias `APPROVED` + 체크 전항목 green.

지적 3건 모두 작성자가 `4e8e7d5`에서 항목별로 대응 완료:

| 파일 | 지적 | 대응 |
|------|------|------|
| `src/codex/catalog/provider-fetch.ts` | 소수/범위초과 값이 카탈로그 진입 | positive safe integer만 유지, 회귀 커버 |
| `src/providers/model-discovery.ts` | OAuth 고정 preset의 baseUrl 신뢰 | 레지스트리 adapter/baseUrl로 핀 고정 |
| `src/server/management/provider-routes.ts` | 프로브 카운트가 필터 미적용 | `extractProviderModelItems` 경유 |

보안 경계: OAuth·자격증명 경로를 건드리므로 MAINTAINERS.md 기준 명시적 보안 리뷰 대상.
Wibias가 이미 그 리뷰를 수행(`redirect: "error"`, destination-policy 선행 검사, OAuth
host pinning 확인). 형식 요건 충족.

CodeRabbit이 남긴 `safeConfigDTO`의 `provider.note` 누락 지적은 **이 PR의 회귀가 아니다**:
현재 `dev`의 `src/server/auth-cors.ts:421`도 레지스트리 노트만 복사한다. 별도 이슈 사안.

선행 관계: #653(Baseten)이 이 PR에 의존한다. 이걸 먼저 넣어야 프로바이더 배치가 풀린다.

### 3. #711 — data-only Responses SSE 수용 (CI 대기)

라운드 1의 1순위. `windows-latest`의 `fail`이 실제로는 `cancelled`임을 확인하고
`gh run rerun 30480687886 --failed`로 재실행을 걸어둔 상태. 현재 `pending`.

green 전환 시 랜딩하고 #700을 닫는다. 재실행에서 진짜 실패가 나오면 이번 라운드 제외하고
로그 기반으로 별도 판단한다(라운드 1이 #610에서 확인한 `EEXIST: epoll_ctl` 계열
Bun 러너 크래시일 가능성 — Luna 레인 조사에서 대응 Bun 이슈를 찾지 못했으므로 알려진
회귀로 단정하지 않는다).

## 성공 기준

| # | 기준 | 기대 증거 |
|---|------|-----------|
| 1 | 사용자 #710 작업분 무손상 | 머지 전후 `git status --porcelain`에 동일한 10개 unstaged 유지 |
| 2 | #575 머지 | `gh pr view 575 --json state` = MERGED |
| 3 | #652 머지 | `gh pr view 652 --json state` = MERGED |
| 4 | 머지 후 `dev` 건전성 | `bun x tsc --noEmit` 통과 + 대상 테스트 통과 + `privacy:scan` green |
| 5 | #553 미클로즈 | `gh issue view 553 --json state` = OPEN |
| 6 | #711 처리 | green이면 MERGED, 아니면 근거 기록 후 보류 |

## 범위 밖 (명시)

- `git push` — LOOP-GIT-01 / DEV-GIT-PUSH-01: 사용자 명시 승인 없이 푸시 금지.
  로컬 머지 커밋까지만.
- #710 관련 모든 파일 (사용자 작업 중)
- #646 — draft + CHANGES_REQUESTED 미해소. `modelDefaultReasoningEfforts` 보강 필요.
- #610 / #653 — CI 실패 잔존
- draft 7건 (#707, #671, #635, #633, #630, #629, #557)
