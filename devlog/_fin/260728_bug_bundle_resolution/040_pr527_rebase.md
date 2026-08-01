# 040 — WP5: PR #527 리베이스 + dev 리타깃

대상: PR #527 `[WRONG BRANCH] fix(codex): warn about stale Codex app-servers after a catalog write`
작성자: `lidge-jun` (오너 본인 — 기여자 의존 없음)
계층: PR 정리 — 우리 코드 변경이 끝난 뒤에 수행

## 현재 상태 (실측)

```
base       codex/catalog-written-signal   (dev 아님)
head       a64aa5856
mergeable  CONFLICTING / DIRTY
checks     enforce-target FAIL (base가 dev/dev2-go가 아님)
           나머지(linux-systemd, macos-launchd, react-doctor, label) PASS
규모       +1248/-59, 21 files
```

커밋 2개:

| oid | 제목 | 상태 |
| --- | --- | --- |
| `1ba588eff` | fix(codex): report whether a sync actually wrote the catalog or cache | **이미 dev에 있음** — `9dd3c42da` "fix(codex): report catalog and cache write signals"로 반영 (PR #526 머지) |
| `a64aa5856` | fix(codex): warn about stale Codex app-servers after a catalog write | 이것만 남기면 됨 |

즉 DIRTY의 원인은 **선행 커밋이 이미 dev에 다른 해시로 들어갔기 때문**이다.
텍스트 충돌이 아니라 중복이다.

## 충돌 범위

21개 파일 중 충돌은 2개뿐이고 나머지 19개(i18n 6개 로케일, `src/codex/*`,
`src/cli/*`, 문서)는 자동 병합된다:

- `tests/codex-refresh.test.ts`
- `tests/injection-model-api.test.ts`

두 파일 모두 `1ba588eff`가 건드리고 `9dd3c42da`도 건드린 자리다. **dev 쪽
(`9dd3c42da`)을 정본으로 삼고**, `a64aa5856`가 추가하는 stale 경고 테스트만
그 위에 얹는다.

## 절차

### 1. 전용 worktree 확보

로컬 `dev`에 미푸시 커밋 2건(star prompt)이 있고 다른 worktree 10곳이 살아
있다. 메인 체크아웃을 건드리지 않는다.

```bash
git fetch origin dev
git worktree add /Users/jun/.codex/worktrees/260728-pr527/opencodex \
  -b codex/pr527-rebase origin/dev
```

### 2. 남길 커밋만 체리픽

```bash
cd /Users/jun/.codex/worktrees/260728-pr527/opencodex
git cherry-pick a64aa5856
```

`1ba588eff`는 **의도적으로 건너뛴다** — dev의 `9dd3c42da`가 같은 일을 한다.

> **선행 증거 필수 (A 게이트 지적).** "같은 일을 한다"는 아직 제목 대조일
> 뿐이다. 건너뛰기 전에 실제 동등성을 증명한다:
>
> ```bash
> git range-diff 9dd3c42da~1..9dd3c42da 1ba588eff~1..1ba588eff
> # 또는 파일별
> git diff 1ba588eff~1 1ba588eff -- src/codex/ | diffstat
> git diff 9dd3c42da~1 9dd3c42da -- src/codex/ | diffstat
> ```
>
> 동등하지 않으면 `a64aa5856`가 미묘하게 다른 베이스 위에 얹히고 누락된 델타가
> **조용히 사라진다.** 차이가 있으면 건너뛰지 말고 충돌로 해소한다.

### C 단계 실측 결과 — **동등하지 않다**

```
$ git diff --stat 1ba588eff~1 1ba588eff | tail -1
 6 files changed,  86 insertions(+), 14 deletions(-)

$ git diff --stat 9dd3c42da~1 9dd3c42da | tail -1
 6 files changed, 208 insertions(+), 15 deletions(-)

$ git range-diff 9dd3c42da~1..9dd3c42da 1ba588eff~1..1ba588eff | rg -c '^\s+[-+]'
150
```

파일 목록은 6개로 **동일**하다:
`src/codex/catalog/sync.ts`, `src/codex/refresh.ts`, `src/codex/sync.ts`,
`tests/codex-refresh.test.ts`, `tests/codex-sync-api.test.ts`,
`tests/injection-model-api.test.ts`.

그런데 dev의 `9dd3c42da`가 **+122줄 더 많다.** range-diff 차이 라인 150줄.
즉 `9dd3c42da`는 `1ba588eff`의 재작성본이며 그 **상위집합**으로 보인다
(리뷰 반영으로 커버리지가 늘어난 형태).

**따라서 계획의 "그냥 건너뛴다"는 그대로 실행하면 안 된다.** 수정된 절차:

1. `a64aa5856`만 체리픽하되, **충돌이 나는 것이 정상**이다 — `a64aa5856`는
   `1ba588eff` 위에 쓰였고 dev에는 그 상위집합이 있다.
2. 충돌 해소 시 **dev(`9dd3c42da`) 쪽을 무조건 정본**으로 삼는다. `1ba588eff`
   버전의 코드가 남으면 리뷰 반영분이 되돌려진다.
3. `a64aa5856`가 **새로 추가하는 것만** 얹는다 — stale app-server 경고.
4. 체리픽 후 `git diff origin/dev -- src/codex/` 로 실제 델타가 stale 경고에만
   국한되는지 확인한다. `9dd3c42da`의 라인이 사라졌으면 잘못된 해소다.

이 확인이 없었으면 dev의 리뷰 반영분 122줄이 조용히 되돌려질 수 있었다.

### 3. 충돌 해소 규칙

두 테스트 파일에서 충돌이 나면:

- dev 쪽 `9dd3c42da`의 카탈로그 write 신호 assertion을 **보존**한다
- `a64aa5856`가 추가하는 stale app-server 경고 assertion을 **덧붙인다**
- 두 assertion이 같은 헬퍼를 다르게 부르면 dev 쪽 시그니처를 따른다

삭제로 해소하지 않는다. 한쪽 assertion이 사라지면 그건 회귀다.

### 4. 검증

```bash
bun run typecheck
bun test tests/codex-refresh.test.ts tests/injection-model-api.test.ts
bun test tests/codex-*.test.ts
```

### 5. 푸시 + 리타깃

```bash
git push -u origin codex/pr527-rebase
gh pr edit 527 --base dev
```

head 브랜치가 바뀌므로 실제로는 **#527을 닫고 새 PR을 여는 편이 깔끔할 수
있다.** B 단계에서 결정한다:

| 선택 | 장점 | 단점 |
| --- | --- | --- |
| 기존 #527에 force-push + 리타깃 | 이슈 링크 보존 | force-push 필요 |
| 새 PR + #527 클로즈 | 이력이 깨끗 | 링크가 새 번호로 이동 |

오너 본인 PR이고 리뷰 코멘트가 없으므로(reviewDecision 공란) **어느 쪽이든
정보 손실이 없다.** 기존 PR 유지를 우선한다.

### 6. CI 확인

```bash
gh pr checks 527
```

`enforce-target`이 PASS로 바뀌는 것이 이 work-phase의 핵심 신호다.

## 활성화 증거

새 조건부 분기가 없다 — 순수 이력 정리다. 증거는 상태 전이 자체다:

| 항목 | 전 | 후 |
| --- | --- | --- |
| base | `codex/catalog-written-signal` | `dev` |
| enforce-target | FAIL | PASS |
| mergeable | CONFLICTING | MERGEABLE |
| 커밋 수 | 2 (1개 중복) | 1 |

## 스코프 경계

IN: 리베이스, 충돌 해소, 푸시, 리타깃, CI 확인.
OUT: `a64aa5856`가 담은 stale 경고 **기능 자체의 재설계** — 리베이스가
목적이지 재작성이 아니다.
OUT: 머지 실행 — 리뷰 상태를 보고 별도 판단한다.

## 수용 기준 (c2)

- `gh pr view 527 --json baseRefName` → `dev`
- `gh pr view 527 --json mergeable` → `MERGEABLE`
- `gh pr checks 527` → `enforce-target` PASS
- 로컬 `bun run typecheck` + 두 충돌 테스트 파일 통과
