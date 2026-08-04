# 011 — 1차 감사 FAIL 및 계획 재작성

감사자: 독립 서브에이전트 (gpt-5.6-terra medium) · 판정 `VERDICT: FAIL`
근거 문서: `000_survey.md`, `010_branch_policy.md`, `020_pr_split.md`, `030_maintainer_wibias.md`

FAIL은 A 게이트를 통과하지 못한다(AUDIT-LOOP-01). 아래는 각 지적에 대한
수용/반박 판단과, 그에 따라 010/020이 어떻게 바뀌는지다.

## CRITICAL 1 — enforce 워크플로를 dev에서 고쳐도 발효되지 않는다

**수용.** 이게 계획 전체를 무효로 만드는 지적이었다.

    gh repo view lidge-jun/opencodex --json defaultBranchRef
    # main

`pull_request_target`은 **기본 브랜치(main)의 워크플로**를 실행한다.
`dev`의 `enforce-pr-target.yml`을 아무리 고쳐도 PR 판정에는 영향이 없다.
main의 파일에는 여전히 `EXPECTED_BASE = "dev"`가 있다 (26행 실측).

    git show origin/main:.github/workflows/enforce-pr-target.yml | grep -n EXPECTED_BASE
    # 26:            const EXPECTED_BASE = "dev";

### 결론

`dev`에 워크플로 변경을 커밋하는 것은 **필요하지만 충분하지 않다.**
실제 발효는 `main` 승격 시점에 일어난다. 그리고 main 승격은 이 goal의
명시적 범위 밖(사용자 승인 필요)이다.

따라서 WP2의 산출물은 두 부분으로 나뉜다:

1. **지금 할 수 있는 것** — 문서(AGENTS.md / CONTRIBUTING.md /
   MAINTAINERS.md)와 dev의 워크플로 변경을 dev에 커밋.
2. **사용자 승인이 필요한 것** — main 승격. 승격 전까지 dev2-go PR은
   계속 `[WRONG BRANCH]` 처리된다는 사실을 **문서와 보고에 명시**한다.

이 한계를 숨기고 "허용했다"고 보고하는 것이 가장 나쁜 결과다.

## CRITICAL 2 — dev2-go PR에 CI가 안 돈다는 설계도 같은 이유로 성립 안 함

**수용.** `pull_request` 트리거의 워크플로는 **PR의 base 브랜치 버전**이
실행된다. `dev`의 `ci.yml`에 `dev2-go`를 추가해도, base가 dev2-go인 PR은
`dev2-go`의 `ci.yml`을 쓴다. 그쪽은 여전히 `[main, dev]`다.

    git show origin/dev2-go:.github/workflows/ci.yml | sed -n 3,5p
    #   pull_request:
    #     branches: [main, dev]

게다가 `go-ci.yml`은 `push`만 받고 `pull_request` 트리거가 아예 없다.

### 결론

CI 커버리지는 **dev2-go 브랜치 자체에 커밋해야** 생긴다. 이건 dev 작업이
아니라 dev2-go 작업이며, 별도 PR(또는 별도 work-phase)이다.
010에서 "ci.yml에 dev2-go 추가"를 dev 변경으로 적은 것은 틀렸다.

## CRITICAL 3 — #518 추가 라인 수 오류

**수용.** `+1192`로 적었으나 실측은 `+1193`이다.

    gh api repos/lidge-jun/opencodex/pulls/518 --jq '{additions,deletions,changed_files,commits}'
    # {"additions":1193,"changed_files":21,"commits":10,"deletions":34}

내가 `gh pr view --json files`의 파일별 additions를 눈으로 더한 값이라
1 차이가 났다. 000과 020의 수치를 API 값으로 교체한다.

## MAJOR 1 — `some()` 판정은 우회 가능

**수용.** `go/x.go` 1개 + `src/oauth/token.ts` 대량 변경이 통과한다.
범위 제한이라는 목적과 정반대다.

`some` → **모든 변경 파일이 허용 집합에 속하는지**로 바꾼다. 다만 공유
파일(예: `package.json`, `devlog/`)까지 금지하면 실용성이 없으므로
허용 집합 = Go 전용 경로 + 명시적 공유 경로로 정의하고, 그 밖의 파일이
하나라도 있으면 wrong-base로 판정한다.

또한 `synchronize` 트리거가 없어 **최초 통과 후 파일을 추가하면
재판정되지 않는다.** 이것도 수용해서 트리거에 추가한다.

## MAJOR 2 — SCOPED_BASES 정규식이 실제 파일 4개를 누락

**수용.** 실측으로 확인했다:

    src/lib/runtime-entry.ts
    tests/prebridge-runtime-rebake.test.ts
    tests/prepare-release-assets.test.ts
    tests/reconcile-release-assets.test.ts

특히 `src/lib/runtime-entry.ts`는 네이티브 런타임 선택 코드라, 이 파일만
고치는 정당한 dev2-go PR이 wrong-branch로 찍힌다. 목록에 추가한다.

## MAJOR 3 — "ready PR 3개"는 틀림

**수용.** #355는 draft다. ready는 #518과 #522 둘뿐이다. 020을 고친다.
(분할 대상이 #518이라는 결론 자체는 영향 없음.)

## MINOR 1 — A/B 분할과 catalogWritten 의존성은 맞음

**확인됨.** 감사도 같은 결론이다. 020의 혼재 분석(이미 감사 전에
`src/cli/index.ts` 혼재를 발견해 수정함)이 유효하다.

## MINOR 2 — CODEOWNERS 우선순위 주장은 맞으나 브랜치 보호가 없음

**부분 수용.** "마지막 매치가 우선"은 맞다고 확인됐다. 다만:

    gh api repos/lidge-jun/opencodex/branches/dev/protection
    # HTTP 404 (Branch not protected)
    gh api repos/lidge-jun/opencodex/branches/main/protection
    # HTTP 404

브랜치 보호가 없으므로 CODEOWNERS는 **리뷰 요청 자동화일 뿐 승인 강제가
아니다.** 030에 이 사실을 명시한다 — "CODEOWNERS에 넣으면 보안 경로가
지켜진다"는 인상을 주면 안 된다.

`pull-requests: write`가 listFiles에 충분하다는 확인은 유용하다(권한
확대 불필요).

## 반박 없음

이번 라운드는 반박할 지적이 없다. 다섯 건 전부 실측으로 재확인했다.

## 계획 변경 요약

| 문서 | 변경 |
| --- | --- |
| 000 | #518 수치를 API 실측값으로 교체 |
| 010 | 워크플로 변경의 **발효 조건(main 승격)** 명시, `some`→전량 검사, `synchronize` 추가, 누락 경로 4개 추가, CI 변경을 dev2-go 브랜치 작업으로 분리 |
| 020 | ready PR 2개로 정정, 수치 정정 |
| 030 | 브랜치 보호 부재 사실 추가 |

## 재감사 필요

010이 실질적으로 다시 쓰이므로 2차 감사를 돌린다.
