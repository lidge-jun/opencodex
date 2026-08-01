# 000 — 현황 조사: 브랜치 정책, PR 게이트, 메인테이너 문서

작성: 2026-07-27 · docs-only 사이클 (WP1) · 코드 변경 0건

## 조사 범위

사용자 요청 4건이 건드리는 표면을 실측했다.

1. dev2-go 기반 PR 허용 + 포팅/리베이스 PR 환영
2. 대상 PR 두 개로 분할
3. MAINTAINERS에 Wibias 추가
4. (이 문서 자체가 4번 "기타 작업"의 문서화 우선 사이클)

## dev2-go의 정체

    git rev-list --count origin/dev..origin/dev2-go   # 334
    git rev-list --count origin/dev2-go..origin/dev   # 0

`origin/dev`는 `origin/dev2-go`의 조상이다. 즉 dev2-go는 dev에서
갈라져 나가 334커밋 앞서 있고, 역방향 커밋은 없다.

커밋 주제 분포 (334건):

| 종류 | 수 |
| --- | --- |
| feat | 180 |
| fix | 53 |
| docs | 48 |
| test | 33 |
| ci | 8 |
| refactor / perf | 10 |
| style / build | 2 |

전용 추가 파일 901개 중 대부분이 `go/internal`(778), `go/test`(27),
`go/cmd`(5)다. 여기에 `go/go.mod`, `go/go.sum`,
`.github/workflows/go-ci.yml`, `bin/native-runtime.mjs`,
`scripts/build-go-release.go`, `scripts/embed-gui.ts`,
`scripts/prepare-release-assets.ts`, `scripts/reconcile-release-assets.ts`가
붙는다.

즉 dev2-go는 임시 실험 브랜치가 아니라 **Go 네이티브 포트 + 릴리스 자산
파이프라인을 담은 장기 병렬 통합선**이다. 이걸 "잘못된 브랜치"로 취급하는
현재 정책이 실제와 어긋난다.

## 왜 dev2-go PR이 [WRONG BRANCH]가 되는가

원인은 문서가 아니라 워크플로다.

`.github/workflows/enforce-pr-target.yml:26`

    const EXPECTED_BASE = "dev";
    const TITLE_PREFIX = "[WRONG BRANCH] ";

base가 `dev`가 아닌 모든 PR에 대해 이 워크플로는:

1. 제목에 `[WRONG BRANCH] ` 접두사를 붙이고,
2. draft가 아니면 **강제로 draft로 강등**하고,
3. "dev로 retarget하라"는 봇 댓글을 남긴다.

PR #455가 정확히 이 상태다 (base=dev2-go, head=tmp/dev2-go-source-export,
제목이 `[WRONG BRANCH] chore: ...`). 즉 그 PR은 작성자가 실수한 게 아니라
**자동화가 제목을 고쳐 쓴 결과**다.

추가로 CI 커버리지도 비어 있다:

    .github/workflows/ci.yml:5                on.pull_request.branches: [main, dev]
    .github/workflows/service-lifecycle.yml:5 on.pull_request.branches: [main, dev]

base=dev2-go PR은 이 두 워크플로의 실행 대상이 아니다. 즉 지금 상태에서
dev2-go PR을 받으면 **강제 draft + 크로스플랫폼 CI 미실행**이라는
최악의 조합이 된다.

## 정책 문서 현황

| 파일 | 줄 | 현재 문구 |
| --- | --- | --- |
| AGENTS.md | 41 | "`dev` — integration branch. All normal pull requests target `dev`." |
| AGENTS.md | 63 | "flag any pull request that targets `main` instead of `dev`" |
| MAINTAINERS.md | 18 | "Normal pull requests target `dev`." |
| CONTRIBUTING.md | 13 | "`dev` — integration target for all normal pull requests." |
| CONTRIBUTING.md | 14 | "`main` — releases only; moves by maintainer-controlled promotion from `dev`." |

`dev2-go` 문자열은 정책 문서와 `.github` 정책 파일 어디에도 없다.
포팅 PR이나 리베이스 PR을 환영한다는 문구도 없다.

PR 템플릿(`.github/PULL_REQUEST_TEMPLATE.md`)은 Summary / Verification /
Checklist만 있고 base 브랜치 규정이 없다.

## 메인테이너 문서 현황

MAINTAINERS.md 현재 표:

| GitHub account | Project role |
| --- | --- |
| @lidge-jun | Project owner |
| @Ingwannu | Maintainer |

`.github/CODEOWNERS`:

    * @lidge-jun @Ingwannu
    /.github/ @lidge-jun @Ingwannu
    /scripts/release.ts @lidge-jun @Ingwannu
    /package.json @lidge-jun @Ingwannu
    /bun.lock @lidge-jun @Ingwannu
    /src/oauth/ @lidge-jun @Ingwannu
    /src/codex/auth-context.ts @lidge-jun @Ingwannu
    /src/server/auth-cors.ts @lidge-jun @Ingwannu
    /src/server/management-api.ts @lidge-jun @Ingwannu
    /MAINTAINERS.md @lidge-jun @Ingwannu
    /SECURITY.md @lidge-jun @Ingwannu

MAINTAINERS.md "Maintainer changes" 절차는 세 가지를 요구한다:
소유자 동의, 다른 현직 메인테이너 리뷰(가능할 때), 그리고
**MAINTAINERS.md와 CODEOWNERS 양쪽 갱신**.

## Wibias의 실적 (추가 근거)

밤샘 트리아지(`260727_overnight_triage/000_triage.md`)에서 집계한 바로,
v2.7.41 이후 dev에 들어온 21개 머지 PR 중 Wibias가 저자인 것이
압도적 다수다: Kiro 스트리밍 안정화 전체(#514/#516/#520),
UX paper cuts(#517), combo 카탈로그(#516), CI 이슈 번역
파이프라인(#510/#513/#523), GUI react-doctor 정리 다수.

## docs-site 영향

기여 가이드는 5개 로케일에 존재한다:

    docs-site/src/content/docs/contributing.md          (영어 원문)
    docs-site/src/content/docs/ja/contributing.md
    docs-site/src/content/docs/ko/contributing.md
    docs-site/src/content/docs/ru/contributing.md
    docs-site/src/content/docs/zh-cn/contributing.md

이 다섯 페이지에는 branch policy 섹션 자체가 없다. 즉 이번 변경으로
공개 문서가 영어 원문과 모순될 위험은 없다 — 다만 정책을 공개적으로
보이게 하려면 5개 전부 손대야 하므로, 이번 사이클 범위에서는 제외한다.

## 조사 결론

- dev2-go 허용은 **문서 3개 + 워크플로 3개** 문제다. 문서만 고치면
  자동화가 계속 `[WRONG BRANCH]`를 붙인다.
- 단, `EXPECTED_BASE`를 단순히 배열로 바꾸면 **모든 일반 PR이 dev2-go로
  가도 통과**한다. 허용 집합이 아니라 "어떤 PR이 dev2-go로 갈 수 있는가"의
  판정이 필요하다.
- 메인테이너 추가는 두 파일 동시 갱신이 절차상 요구사항이다.

## 분할 대상 PR 실측 (GitHub API, 2026-07-27)

    gh api repos/lidge-jun/opencodex/pulls/518 --jq '{additions,deletions,changed_files,commits}'
    # {"additions":1193,"changed_files":21,"commits":10,"deletions":34}

    gh api repos/lidge-jun/opencodex/pulls/522 --jq '{additions,deletions,changed_files}'
    # {"additions":643,"changed_files":20,"deletions":9}

열린 PR 14개 중 ready는 #518과 #522 둘뿐이고 나머지 12개는 draft다.

## 1차 감사가 추가로 밝혀낸 것 (011 참조)

위 결론에는 결정적 누락이 있었다. 감사에서 확인된 사실:

- 저장소 **기본 브랜치는 `main`**이다. `pull_request_target`은 기본 브랜치의
  워크플로를 실행하므로, `dev`에 `enforce-pr-target.yml`을 고쳐도
  **PR 판정은 바뀌지 않는다.** main 승격이 실제 발효 시점이다.
- `pull_request` 트리거 워크플로는 **PR의 base 브랜치 버전**이 실행된다.
  따라서 dev2-go PR의 CI 커버리지는 `dev2-go` 브랜치에서 고쳐야 한다.
- 브랜치 보호 규칙이 없다(`dev`/`main` 둘 다 HTTP 404). CODEOWNERS는
  리뷰 요청 자동화일 뿐 승인 강제가 아니다.
