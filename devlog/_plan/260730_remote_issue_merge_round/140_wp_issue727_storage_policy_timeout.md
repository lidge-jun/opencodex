# 140 — wp: #727 storage-policy 하네스 타임아웃 (계획)

PABCD 사이클 진행 중. 목표: `tests/storage-policy.test.ts`의 5초 기본 예산을 없애고
`dev`에 머지, #727 클로즈.

## 문제 재확인 (dev 현재 코드)

`git show origin/dev:tests/storage-policy.test.ts | rg timeout` 결과는 264행 주석
한 줄뿐이다. 즉 이 파일에는 **명시적 예산이 전혀 없다** — bun 기본 5초를 그대로 상속한다.
NOOP 아님.

형제 스위트 `tests/storage-cleanup.test.ts`는 같은 종류의 FS 시딩을 하면서
`{ timeout: 20_000 }` 14곳, `{ timeout: 30_000 }` 5곳을 이미 달고 있다. 같은 원인
("seeding trips bun's default 5s harness timeout")이 그 주석에 적혀 있다.

run 30507689929(`ef805c3cf`)에서 실패한 5건은 모두 6~8초 구간이고, `--failed` 재실행에서
같은 집합이 다시 실패했다. 어서션 실패가 아니라 타임아웃이며 러너 속도에 결정되는
잠재 실패다. 로컬은 같은 파일이 22 pass / 144ms.

## 변경 (diff 수준)

`tests/storage-policy.test.ts` 1파일.

1. `import { afterEach, describe, expect, test } from "bun:test";`
   → `setDefaultTimeout`을 추가한 알파벳 순 임포트.
2. 임포트 블록 뒤, 상수 선언 앞에 파일 수준 예산 + 근거 주석:

```ts
// seedHome() writes real files and a sqlite fixture per case. On a slow
// windows-latest runner those cases land at 6-8s against bun's 5s default and
// fail deterministically (issue #727, run 30507689929) while a fast runner
// passes the same code. The sibling storage-cleanup suite already carries
// { timeout: 20_000 } / { timeout: 30_000 } per case for this reason; one
// file-level budget covers all 15 seedHome sites here.
setDefaultTimeout(30_000);
```

`setDefaultTimeout`은 이 저장소에 이미 있는 관용구다 — `grok-management-api`,
`codex-history-provider`, `claude-management-api`, `server-combo-failover-e2e`,
`subagent-fallback-handle-responses` 다섯 파일이 `30_000`으로 쓴다. 케이스마다
옵션 인자를 붙이는 대신 파일 하나에 한 줄이면 15개 시딩 사이트가 모두 덮인다.

범위 밖: `src/storage/*` 무변경(로직 버그가 아니다), `ci.yml` 무변경(잡 천장은
#717에서 이미 20분으로 올렸다), `seedHome` 자체를 싸게 고치는 작업은 별도 유닛.

## 검증 계획

- `bun x tsc --noEmit` → exit 0
- `bun test tests/storage-policy.test.ts` → 26 케이스 green (파일에 test 26개)
- `bun test --isolate tests/storage-policy.test.ts` → CI와 동일 모드로 재확인
- 브랜치 `codex/260730-issue727-storage-policy-timeout`, PR base `dev`
- 6개 잡 전부 green (windows-latest 포함) 확인 후 머지, #727 클로즈

## 기존 브랜치 처리

현재 워킹트리는 `codex/260730-ci-windows-timeout`에 있고 `origin/dev`의 조상이다
(`git merge-base --is-ancestor HEAD origin/dev` 통과, dev가 5커밋 앞섬). 120 문서가
말한 `ci.yml` 상향은 이미 dev에 반영됐다. 그래서 이 작업은 새 브랜치를 dev 최신
헤드에서 딴다.

## 실행 결과

### 메커니즘 증명을 먼저 했다 (A)

예산 상향은 "이러면 되겠지"로 넘어가기 쉬운 변경이라, 격리된 임시 디렉터리에서
CI와 같은 `--isolate` 모드로 실패 모드를 직접 재현했다.

```
예산 없음  → (fail) slow case without a budget [5000.44ms]
             ^ this test timed out after 5000ms.
예산 9초   → (pass) slow case inherits the file budget [6005.37ms]
```

6초 케이스가 정확히 5000ms에서 죽는다 — #727이 보고한 6~8초 실패와 동일한 모양이다.
`setDefaultTimeout`이 `--isolate` 하에서도 파일 전체에 먹는다는 것까지 같은 프로브로
확인했다. 프로브 디렉터리는 검증 후 치웠다.

### 변경과 로컬 검증 (B/C)

`tests/storage-policy.test.ts` +10/-1. `bun x tsc --noEmit` exit 0,
`bun test --isolate tests/storage-policy.test.ts` **22 pass / 0 fail / 91 expect**.

로컬 통과는 "빠른 FS에서 이 변경이 무해하다"만 증명한다. Windows 동작은 CI가 판정한다.

### git push가 세 번 매달렸다 — API로 우회

`git push`가 HTTPS에서 응답 없이 멈췄다. 3분, 2분, 2분 — 세 번 모두 같은 지점이다.

진단 결과 읽기 경로는 정상이다: `git ls-remote`, `git fetch`는 즉시 돌아온다.
`gh auth status`도 유효(scopes: repo, workflow). 프록시 설정 없음. SSH는
`Permission denied (publickey)`로 대안이 아니다. 즉 업로드 경로만 막혔다.
`http.version=HTTP/1.1` + low-speed 타임아웃 조합도 같이 매달렸다.

같은 명령을 네 번째로 재시도하는 대신 전송을 바꿨다 — GitHub API로 직접:

1. `gh api -X POST git/refs` — dev 헤드 `67c731e65`에서 브랜치 생성
2. `gh api -X PUT contents/tests/storage-policy.test.ts` — 커밋 `e220753ac`

**동일성 검증:** 원격 blob `30931083ac`와 로컬 `git hash-object`가 일치한다. API
경로로 올려도 내용은 로컬 커밋 `ae6ab453c`와 바이트 단위로 같다. 원격 커밋의
`files[]`도 `tests/storage-policy.test.ts +10/-1` 한 파일뿐이다.

### PR #732

base `dev`, draft 아님, `enforce-target` 7초에 pass. 9개 잡 실행 중.

### CI 판정과 머지 (D)

run [30512174098](https://github.com/lidge-jun/opencodex/actions/runs/30512174098) 10개 체크 전부 pass.

| job | 소요 |
|-----|------|
| windows-latest | 10m45s |
| ubuntu-latest | 4m27s |
| macos-latest | 3m57s |
| npm-global windows-latest | 1m43s |

conclusion보다 windows 로그가 중요하다. 30507689929에서 실패했던 5건이 이번엔:

```
(pass) selectPolicyPreview backfills percent past pending oldest archive [290.82ms]
(pass) selectPolicyPreview reduceToBytes skips pending oldest and keeps backfilling [74.17ms]
(pass) selectPolicyPreview honors removeOldestPercent [156.85ms]
(pass) selectPolicyPreview honors reduceToBytes via oldest files [290.18ms]
```

**300ms 미만이다.** 즉 이번 러너는 빠른 쪽이어서 수정 없이도 통과했을 것이다. 이걸
"수정이 검증됐다"로 읽으면 과장이다 — 여유를 없앤 것이지 느린 러너가 사라졌다는 증명이
아니다. 이슈 코멘트에도 이 한계를 그대로 적었다.

머지 `60e1004846f632930ee269cd52d93e1367c2a330` (squash), `dev` 헤드가 이 커밋.
#727 클로즈, 코멘트 5126270651.

`gh pr merge --delete-branch`가 로컬 fast-forward 경고를 냈는데, 워킹트리가 아직 기능
브랜치에 있어서 나온 것이고 원격 머지는 정상이다.

## 성공 기준 판정

| # | 기준 | 결과 | 증거 |
|---|------|------|------|
| 1 | NOOP 아님 확인 | PASS | dev 사본에 예산 0개, 격리 프로브로 5000ms 사망 재현 |
| 2 | typecheck | PASS | exit 0, CI 3플랫폼 Typecheck 스텝 |
| 3 | 로컬 스위트 | PASS | 22 pass / 0 fail / 91 expect |
| 4 | PR base dev | PASS | #732, enforce-target pass |
| 5 | 6잡 green | PASS | 10/10 체크, windows-latest 10m45s |
| 6 | 머지 + 이슈 클로즈 | PASS | 60e100484, #727 CLOSED |

터미널 결과 **DONE**.

## 남긴 것

Windows 2.5배 격차는 그대로다(10m45s vs 4m27s). 120 문서가 지목한 `--isolate`가 여전히
유력 후보이고 오너 판단 사안이라 손대지 않았다. `seedHome`을 싸게 만드는 쪽도 열려 있다.
예산 상향은 여유를 되찾은 것일 뿐 격차를 좁힌 게 아니라는 걸 이슈 코멘트에 명시했다.
