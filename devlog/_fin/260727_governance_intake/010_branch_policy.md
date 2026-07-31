# 010 — dev2-go 통합선 문서화 + 포팅/리베이스 PR 환영 (rev4, 문서 전용)

WP2 · 근거: `000_survey.md`
감사 이력: rev1 FAIL(`011`) → rev2 FAIL(`012`) → rev3 FAIL(`013`)

## 치명적 제약: 지금은 dev2-go PR을 머지할 수 없다

5차 검토에서 확인된 사실이다. 현재 워크플로는 base가 `dev`가 아닌 PR을
draft로 강등하고(`convertPullRequestToDraft`), `ready_for_review` 이벤트를
구독하므로 **ready로 되돌리면 즉시 다시 draft가 된다.**

    .github/workflows/enforce-pr-target.yml:5-9   types: [..., ready_for_review]
    .github/workflows/enforce-pr-target.yml:156   wrongBase = pr.base.ref !== EXPECTED_BASE
    .github/workflows/enforce-pr-target.yml:214   await convertToDraft();

그리고 **GitHub은 draft PR의 머지를 차단한다.** 두 사실을 합치면:

> 워크플로를 고치기 전까지 dev2-go 대상 PR은 정상 리뷰 흐름을 탈 수 없다.

실제 상태가 그 증거다 — PR #455는 `draft=true`, 제목은
`[WRONG BRANCH] chore: ...`로 자동 수정된 상태다.

**단서 (실증, `050_live_evidence.md`):** draft 강등이 항상 성공하는 것은
아니다. PR #527에서는 `convertPullRequestToDraft` mutation이 실패해 PR이
ready로 남았고, 대신 워크플로가 `failure`로 끝나 빨간 체크를 남겼다.
제목 오염과 retarget 요구는 두 경우 모두 발생한다. 어느 쪽이든 정상
리뷰 흐름이 아니라는 결론은 같다.

따라서 "그 상태로 리뷰하고 머지하라"는 안내는 쓸 수 없다. 실행 불가능한
지시다. 정직한 문구는 이것뿐이다:

> dev2-go는 정식 통합선이지만, 타깃 검사 자동화가 아직 이를 모른다.
> 그 자동화가 갱신될 때까지 dev2-go 대상 PR은 draft에 묶여 머지할 수 없다.
> 자동화 갱신은 `040_pr_target_gate.md`가 다룬다.

이 제약 때문에 WP2는 **"지금부터 dev2-go로 PR을 보내라"가 아니라
"dev2-go는 정식 통합선이며 곧 열린다"를 선언하는 것**이 된다. 그 차이를
문서가 흐리면 기여자가 머지되지 않는 PR을 열게 된다.

## 이 문서의 범위 (rev4에서 축소됨)

세 번의 감사가 전부 `enforce-pr-target.yml` 재설계에서 막혔다. 그래서
요구사항을 두 층으로 분리했다 (`013_audit_round3_and_scope_split.md`):

- **층 1 — 정책 선언.** 이 문서. 문서 3개만 고친다.
- **층 2 — 자동화 게이트.** `020_pr_target_gate.md`(WP5)로 분리. 보안 경계
  변경이고 main 승격이 필요하며 사용자 승인 대기 상태다.

**따라서 이 work-phase를 완료해도 dev2-go PR은 여전히 `[WRONG BRANCH]`
접두사와 강제 draft를 받는다.** 이건 숨길 사실이 아니라 문서에 적을
사실이다 — 정책이 자동화보다 먼저 서는 것은 정상 순서다.

## 채택 모델

"동등한 두 통합 브랜치"가 아니라 **주 통합선 + 범위가 정해진 병렬 통합선**.

- `dev` — 기본값. 별도 이유가 없는 모든 PR.
- `dev2-go` — Go 네이티브 포트 범위 작업 (`go/`, 네이티브 런타임 진입점,
  Go 릴리스 자산 도구).

근거: `origin/dev`는 `origin/dev2-go`의 조상이고(역방향 커밋 0), dev2-go는
334커밋 앞서 있으며 전용 추가 파일 901개 중 810개가 `go/` 아래다. 임시
브랜치가 아니라 장기 병렬 개발선이다.

## 변경 1 — `AGENTS.md`

### 1-1. Branch policy (41행 부근)

현재:

    - `dev` — integration branch. All normal pull requests target `dev`.
    - `main` — release branch. ...
    - `preview` — prerelease train (`x.y.z-preview.*` versions).

변경 후:

    - `dev` — integration branch and the default target. A pull request goes
      here unless it belongs to a scoped line below.
    - `dev2-go` — parallel integration line for the Go native port: `go/`,
      `bin/native-runtime.mjs`, `src/lib/runtime-entry.ts`, and the Go
      release-asset tooling. Pull requests confined to that surface may target
      it directly **once the target-branch check recognises the line**. It does
      not yet: it prefixes any non-`dev` pull request with `[WRONG BRANCH]`,
      converts it to a draft, and re-applies both whenever the pull request is
      edited or marked ready for review. Because GitHub blocks merging a draft,
      a `dev2-go` pull request cannot be merged until that check is updated.
      Until then, open Go native-port work against `dev` or coordinate with a
      maintainer.
    - `main` — release branch. It only moves by maintainer-controlled promotion
      from `dev` (releases, docs deploys). Do not open feature PRs against `main`.
    - `preview` — prerelease train (`x.y.z-preview.*` versions).

claudedesktop 문단 뒤에 추가:

    Porting and rebase pull requests are welcome. Forward-porting a fix from
    one integration line to another, or rebasing a stale branch onto the
    current head, is ordinary maintenance rather than noise — open it as a
    normal pull request and name the source commits in the description.

### 1-2. Review guidelines / Branch targeting (63행 부근)

현재:

    - **Branch targeting:** flag any pull request that targets `main` instead of
      `dev` (releases and maintainer promotions are the only exceptions).

변경 후:

    - **Branch targeting:** flag any pull request that targets `main` instead of
      an integration branch (releases and maintainer promotions are the only
      exceptions). `dev` is the default; `dev2-go` is legitimate for work
      confined to the Go native-port surface. Do not flag a `dev2-go` pull
      request merely for not targeting `dev`, and do not treat the automated
      `[WRONG BRANCH]` prefix on such a PR as the author's mistake.

마지막 절이 중요하다. 자동화가 제목을 고쳐 쓰기 때문에, 그걸 본 리뷰어가
작성자를 탓하는 일이 실제로 있었다 (PR #455).

## 변경 2 — `CONTRIBUTING.md` (13-16행)

현재:

    - `dev` — integration target for all normal pull requests.
    - `main` — releases only; moves by maintainer-controlled promotion from `dev`.
    - `preview` — prerelease train.

변경 후:

    - `dev` — default integration target for pull requests.
    - `dev2-go` — parallel integration line for the Go native port. Target it
      when your change is confined to `go/`, the native runtime entrypoint, or
      the Go release-asset tooling. **Not yet open for pull requests:** the
      automated target-branch check does not know about this line, so it
      prefixes such a PR with `[WRONG BRANCH]`, forces it to draft, and does so
      again every time you edit the title or mark it ready. GitHub will not
      merge a draft, so the PR cannot land. Until the check is updated, send
      Go native-port work to `dev` or ask a maintainer first.
    - `main` — releases only; moves by maintainer-controlled promotion from `dev`.
    - `preview` — prerelease train.

    Porting and rebase pull requests are welcome: carrying a fix across
    integration lines, or rebasing a stale branch onto the current head, is
    normal contribution. Note the source commits in the description.

기여자 대상 문서이므로 "무슨 일이 벌어지고 어떻게 되는지"를 가장 구체적으로
쓴다. 놀라지 않게 하는 것이 목적이다.

## 변경 3 — `MAINTAINERS.md` (18행)

현재:

    - Normal pull requests target `dev`.

변경 후:

    - Pull requests target `dev` by default. `dev2-go` is a parallel
      integration line reserved for Go native-port work; it converges back
      through maintainer-controlled merges, and promotion to `main` still
      happens only from `dev`. The target-branch check does not recognise that
      line yet: it forces such pull requests to draft and re-applies that on
      every `edited` / `ready_for_review` event, which blocks merging entirely.
      Until the check is updated, `dev2-go` accepts direct pushes from
      maintainers but not pull requests.

## 범위 밖

- **워크플로 변경 전부** — `020_pr_target_gate.md`(WP5). 사용자 승인 대기.
- `ci.yml` / `service-lifecycle.yml`의 `dev2-go` 추가 — 층 2에 포함.
  (dev에 넣어도 base=dev2-go PR에는 적용되지 않는다. 그쪽 브랜치 작업이다.)
- `docs-site/` 5개 로케일 기여 페이지 — branch policy 섹션 자체가 없어
  모순이 생기지 않는다.

## 수용 기준

1. `rg -n "dev2-go" AGENTS.md CONTRIBUTING.md MAINTAINERS.md` — 각 파일 1건 이상.
2. `rg -n -i "porting|rebase" AGENTS.md CONTRIBUTING.md` — 환영 문구 매치.
3. `rg -n "WRONG BRANCH" AGENTS.md CONTRIBUTING.md MAINTAINERS.md` — 세 파일
   모두 현재 자동화 동작을 명시한다 (사실을 숨기지 않았다는 반증).
3b. 세 파일 어디에도 "그 상태로 머지하라"에 해당하는 안내가 없다. draft는
   머지가 차단되므로 실행 불가능한 지시다.
4. `git diff --name-only` 에 `.github/` 경로가 **없다** (층 분리 반증).
5. 최종 보고에 **"자동화 갱신 전까지 dev2-go 대상 PR은 draft에 묶여 머지
   불가"**가 명시된다. "허용했다"고만 보고하면 사실과 다르다.
