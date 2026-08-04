# 060 — enforce-pr-target.yml 특성화 테스트 (WP6)

## 왜 이 테스트가 필요했나

`.github/workflows/enforce-pr-target.yml`은 이 저장소에서 유일하게 **기여자의 PR을
직접 변경**하는 워크플로다. 제목에 `[WRONG BRANCH] ` 접두사를 붙이고 PR을 draft로
강등한다. 게다가 `pull_request_target`으로 돌아 그 작업을 base 저장소의 write 토큰을
쥔 채 수행한다. 그런데 테스트가 하나도 없었다.

040(게이트 재설계)이 감사 6회 중 5회 FAIL을 받은 이유도 여기에 있다. 현재 동작이
어디까지 보장되는지 아무도 고정해두지 않은 상태에서 재설계 안을 세 번 썼고, 세 번 다
무너졌다. 재설계 전에 현재 동작을 먼저 못 박는다.

이 테스트는 **바람직한 동작이 아니라 현재 동작**을 고정한다. 게이트를 고칠 때 무엇이
깨지는지 보이게 하는 것이 목적이다.

## 무엇을 고정했나

`tests/ci-workflows.test.ts`에 4개 테스트를 추가했다.

| 테스트 | 고정하는 성질 |
| --- | --- |
| stays least-privilege and never runs PR code | 트리거는 `pull_request_target` 하나뿐, `permissions`는 `{pull-requests: write}` 정확히 일치, 모든 step에 `run` 없음, 모든 `uses`가 40자리 SHA 핀, `actions/checkout` 없음, concurrency group이 PR 번호 단위 |
| reacts to the events that can change the verdict | `types`가 정확히 `opened/reopened/edited/ready_for_review`, `pulls.get`으로 라이브 재조회, `wrongBase`가 `pr.base.ref !== EXPECTED_BASE`에서 파생 |
| records what it changed so it can undo it | 상태 마커 저장/복원, 봇이 draft로 만든 경우에만 되돌림 |
| (기존 3개 워크플로 테스트) | 회귀 없음 |

## 문자열 매칭에서 파싱으로 — 감사가 밀어붙인 변경

1차 구현은 워크플로 텍스트를 grep했다. 감사 2라운드가 이걸 네 가지로 뚫었다.

- `- run : echo pwn` — 콜론 앞 공백. 유효한 YAML이고, `/- run:/` 정규식은 못 잡는다.
- `- 'uses': owner/action@feature` — 인용된 키. 역시 유효한 YAML이고 SHA 핀 검사를 우회한다.
- `// await convertToDraft();` — 주석 처리. "이 문자열을 포함한다" 검사는 그대로 만족한다.
- `const wrongBase = false;` — 상수는 남기고 판정만 하드코딩.

그래서 `Bun.YAML.parse()`로 전면 교체했다. 파서는 철자가 아니라 키를 본다.
스크립트 본문은 `//` 주석을 제거한 뒤 검사하되, 제거기가 인용 상태를 추적한다 —
스크립트가 메시지에 `https://…`를 담고 있어서 순진한 `line.replace(/\/\/.*$/, "")`는
문자열 리터럴을 잘라먹고 그 뒤 검사를 조용히 무력화한다.

## 변이 검증 실측

교체 후 감사가 찾은 네 가지를 직접 주입해 재실행했다. 각 변이 후 즉시
`git checkout -- .github/workflows/enforce-pr-target.yml`로 원복했다.

```
MUTATION[run-with-space]      => 13 pass  1 fail
MUTATION[quoted-uses-key]     => 13 pass  1 fail
MUTATION[commented-out-draft] => 13 pass  1 fail
MUTATION[hardcoded-wrongBase] => 13 pass  1 fail
--- restored, baseline: git status --short .github/ → (empty)
```

기준선:

```
bun test tests/ci-workflows.test.ts
 14 pass  0 fail  282 expect() calls  (감사 2라운드 이전 기준선)
```

네 가지 모두 잡힌다.

## 감사 2라운드 — 새 우회 6가지

파싱 교체본을 독립 서브에이전트(gpt-5.6-terra, medium)에 넘겨 "이 테스트를 통과하면서
워크플로를 약화시켜 보라"고 요구했다. FAIL이 나왔고, 여섯 개가 살아남았다.

| 변이 | 무엇이 뚫렸나 |
| --- | --- |
| 두 번째 잡 추가 | 헬퍼가 `jobs["enforce-target"]`만 읽어서, PR-write 토큰을 상속받는 `sidecar:` 잡을 붙여 PR을 un-draft해도 통과 |
| 잡 레벨 권한 | 워크플로 레벨 `permissions`만 검사. 잡에 `contents: write`를 얹으면 무사통과 |
| 스텝 추가 | 스텝 개수를 안 봤다. PR을 변조하는 `github-script` 스텝을 하나 더 붙여도 통과 |
| `/* ... */` 블록 주석 | 주석 제거기가 `//`만 처리. 블록 형태로 `convertToDraft()`를 죽이면 통과 |
| `|| true` 복원 무력화 | `if (!storedState?.active \|\| true)` — 복원 경로가 도달 불가가 되어도 호출과 필드는 텍스트로 남아 있어 통과 |
| PR 제목을 대상 번호로 | `pull_number`를 `Number(pr.title)`로 바꿔도 통과. 작성자가 제어하는 값이므로 봇이 임의 PR에 대한 쓰기 프리미티브가 된다 |

마지막 것이 가장 나쁘다. 봇은 `pull_number` 하나로만 PR을 지목하는데, 그게 작성자
제어 값이 되면 게이트가 아니라 무기가 된다.

## 대응

- 헬퍼가 **모든 잡의 모든 스텝**을 모아 반환한다. `enforce-target`은 특별한 잡이 아니라
  스크립트 본문을 읽을 대상일 뿐이다.
- 잡 목록이 정확히 `["enforce-target"]`, 스텝 수가 정확히 1.
- 어떤 잡도 자체 `permissions`를 선언할 수 없다.
- 주석 제거기가 라인 주석과 블록 주석을 모두 처리한다. 인용 추적은 유지하고 줄바꿈을
  보존해 실패 출력이 엉뚱한 줄을 가리키지 않게 했다.
- `pull_number`는 `context.payload.pull_request.number`에 고정하고, 재대입이 없음을
  대입 횟수로 확인한다.
- 두 분기 조건(`if (wrongBase)`, `if (!storedState?.active)`)을 문자 그대로 고정한다.
  호출이 존재한다는 사실은 그 호출에 도달할 수 있다는 증명이 아니다.

## 변이 검증 실측 (10/10)

```
MUTATION[run-with-space        ] => CAUGHT
MUTATION[quoted-uses-key       ] => CAUGHT
MUTATION[line-comment-draft    ] => CAUGHT
MUTATION[block-comment-draft   ] => CAUGHT
MUTATION[hardcoded-wrongBase   ] => CAUGHT
MUTATION[second-job            ] => CAUGHT
MUTATION[job-level-perms       ] => CAUGHT
MUTATION[extra-script-step     ] => CAUGHT
MUTATION[unreachable-restore   ] => CAUGHT
MUTATION[pr-controlled-target  ] => CAUGHT

restored OK; survived = none
```

기준선: `14 pass  0 fail  292 expect() calls`, `bun run typecheck` 오류 0.

## 감사 3라운드 — 열거 게임의 종료

봉쇄본을 다시 독립 감사에 넘겼다. 또 FAIL, 이번엔 14가지가 살아남았다.

`if: false`(잡/스텝 양쪽), `runs-on: self-hosted`, `container: node:22`,
`strategy.matrix`, `outputs.leaked: ${{ github.token }}`, `<<:` 병합 키로 `if: false`
주입, `github-token: ${{ secrets.SOME_PAT }}`, `result-encoding`, 잡 레벨 `env:`에
PR 제목 주입, `cancel-in-progress`, 그리고 스크립트 안쪽으로 `${{ ... }}` 보간,
`pr.base.ref = EXPECTED_BASE` 되쓰기, `issue_number: 1`, `base: "main"` 추가.

여기서 패턴이 보인다. **살아남은 것은 전부 "원래 없던 키"다.** 세 라운드 내내 우리는
"이 키는 없어야 한다"를 하나씩 늘려왔는데, 그건 감사자가 생각해낸 것만 덮는다.
다음 라운드에는 다음 키가 나온다. 끝나지 않는다.

### 설계 반전 — 부정 목록에서 허용 목록으로

무엇이 없어야 하는지가 아니라 **무엇인지**를 열거한다.

- 최상위 키 집합이 정확히 `[concurrency, jobs, name, on, permissions]`
- `concurrency` 객체 전체가 `{group: ...}` 하나 (`cancel-in-progress` 자동 차단)
- 잡 키 집합이 정확히 `[runs-on, steps]`, `runs-on`은 `ubuntu-latest` 고정
  → `if`, `permissions`, `container`, `strategy`, `outputs`, `env`, `defaults`, `<<`
  전부 한 어설션에 걸린다
- 스텝 키 집합이 정확히 `[name, uses, with]`, `with` 키가 정확히 `[script]`
  → `github-token`, `result-encoding`, 스텝 `if` 전부 차단
- `uses`는 `^actions/github-script@[0-9a-f]{40}$`

이 방식의 값어치는 **아직 발명되지 않은 키도 걸린다**는 것이다. 새 키가 추가되면
어떤 키든 여기서 실패하고 사람이 읽게 된다. 권한 있는 워크플로의 특성화 테스트에
필요한 성질이 바로 그거다.

### 스크립트 쪽 — 보간 금지와 인자 화이트리스트

`${{ }}`는 Actions가 node 실행 **전에** 스크립트 텍스트로 치환한다. 그래서 백틱이
들어간 PR 제목은 데이터가 아니라 코드다. `pull_request_target`의 교과서적 주입 지점.
스크립트 원문에 `${{`가 하나도 없어야 한다 — 필요한 값은 이미 런타임에 `context`에서
읽고 있다.

`pr` 객체에 대한 필드 대입도 전면 금지한다. 감사는 요구 비교문을 글자 그대로 남겨둔
채 한 줄 위에서 `pr.base.ref = EXPECTED_BASE;`로 판정을 죽였다. 리터럴은 그대로,
결과는 항상 false.

쓰기 호출은 인자 이름까지 고정한다. `pulls.update`는 `base`, `state`, `body`를 받는다.
인자 목록이 열려 있으면 write 토큰을 쥔 봇이 PR을 리타깃하거나 닫을 수 있다는 뜻이다.
`issue_number`는 리터럴 금지, `pull_number` 바인딩만 허용. 변조 REST 호출은 정확히
세 개(`pulls.update`, `issues.createComment`, `issues.updateComment`)여야 한다.

## 변이 검증 실측 (27/27)

3개 라운드가 찾은 모든 우회 + 파생 2건을 재주입했다. 각 변이 후 즉시
`git checkout -- .github/workflows/enforce-pr-target.yml`.

```
run-with-space CAUGHT      quoted-uses-key CAUGHT     line-comment-draft CAUGHT
hardcoded-wrongBase CAUGHT block-comment-draft CAUGHT second-job CAUGHT
job-level-perms CAUGHT     extra-script-step CAUGHT   unreachable-restore CAUGHT
pr-controlled-target CAUGHT pat-override CAUGHT       job-env-pr-title CAUGHT
job-if-false CAUGHT        step-if-false CAUGHT       self-hosted-runner CAUGHT
unpinned-container CAUGHT  script-injection CAUGHT    pr-field-writeback CAUGHT
comment-other-issue CAUGHT constant-concurrency CAUGHT cancel-in-progress CAUGHT
merge-key-disable CAUGHT   extra-with-input CAUGHT    nul-title-prefix CAUGHT
matrix-and-outputs CAUGHT  update-retargets-main CAUGHT update-closes-pr CAUGHT

survived = none
```

기준선: `16 pass  0 fail  303 expect() calls`, `bun run typecheck` 오류 0.

한 가지 실측 정정: 계획은 `pulls.update`가 1회 호출된다고 봤는데 실제로는 2회다
(접두사 부착, 그리고 리타깃 후 제거). 어설션을 실제 트리에 맞췄다.

## 감사 4라운드 — 정적 고정의 한계, 그리고 실행 하네스

허용 목록 버전을 다시 감사에 넘겼다. YAML 쪽은 버텼다. `True:`(YAML 1.1 불린 강제),
flow 스타일 `{group: ...}`, `runs-on: [ubuntu-latest]`, 다중 문서 `---` 전부 잡혔다.
인용 키·순서 변경·앵커·스텝 이름 변경은 살아남았지만 파싱 결과가 동일하므로
행위 우회가 아니다.

무너진 건 전부 스크립트 안쪽이었다. 12가지.

```
const github = {}                              // 클라이언트 자체를 가림
const upd = github.rest.pulls.update; upd({base:"main"})
github.rest["pulls"]["update"]({base:"main"})   // 계산된 멤버 접근
github.request("PATCH /repos/.../pulls/...")    // github.rest.* 를 아예 우회
{ ...{base:"main"}, owner, ... }                // 스프레드로 인자 주입
graphql에 updatePullRequest 추가
Object.assign(pr.base, {ref: EXPECTED_BASE})    // 점 대입이 아님
const b = pr.base; b.ref = ...                  // 별칭
const { base } = pr; base.ref = ...             // 구조분해
if (false) { ...전체... }
try { ...전체... } catch {}                      // 실패를 삼킴
return;                                         // 조기 반환
```

### 인정할 것은 인정한다

감사 결론이 맞다. **JavaScript를 텍스트로 고정하는 건 이길 수 없다.** 같은 효과를
내는 철자가 무한히 많고, 정규식이 찾는 문자열은 전부 그대로 남는다. 정적 고정을
더 정교하게 만드는 방향은 5라운드에서 또 뚫린다.

그래서 읽기를 그만두고 **실행**한다.

### tests/helpers/enforce-pr-target-harness.ts

워크플로의 인라인 스크립트를 뽑아내 `actions/github-script`와 같은 자유 변수
(`github`, `context`, `core`, …)로 컴파일하고, 기록하는 가짜 클라이언트를 넘긴다.
`github-script`가 본문을 async 함수로 감싸므로 하네스도 똑같이 감싼다 — 스크립트가
최상위 `return`을 쓰기 때문에 이게 맞아야 조기 반환 경로가 재현된다.

`github.rest.*`뿐 아니라 `github.request`, `github.graphql`, `github.paginate`도
전부 같은 `record()`를 통과한다. 그래서 `github.rest.*`를 버린 재작성도 기록에 남는다.
`exec`/`io`/`fetch`/`require`는 접근만 해도 던지는 프록시로 막았다.

### 무엇을 검증하나

시나리오 7개를 실제로 돌린다.

| 시나리오 | 관찰하는 것 |
| --- | --- |
| dev 대상 PR | 읽기 2회뿐. 쓰기가 하나라도 생기면 목록에 나타난다 |
| main 대상 PR | 코멘트 → 제목 → draft 순서, `pulls.update` 인자가 정확히 4개, GraphQL은 `convertPullRequestToDraft` 하나 |
| 이미 draft인 PR | draft 변환 없음, 상태에 `autoDraftedByBot:false`, 리타깃 후에도 draft 유지 |
| 리타깃된 PR | 접두사 제거 + ready 복귀 + 코멘트 상태 `active:false` |
| 기여자가 제목을 더 고친 경우 | 접두사만 떼고 나머지 편집 보존 |
| 재실행 | 접두사 중복 부착 없음, 재-draft 없음 |
| GraphQL 실패 | 예외가 전파된다 (`try/catch` 삼킴 탐지), 상태 코멘트는 이미 나감 |

호출이 어떤 철자로 쓰였는지는 상관없다. 나온 호출을 본다.

## 변이 검증 실측 (39/39)

4라운드 스크립트 변이 12가지:

```
shadow-github CAUGHT     shadow-context CAUGHT    alias-update CAUGHT
spread-injection CAUGHT  computed-member CAUGHT   github-request CAUGHT
graphql-retarget CAUGHT  object-assign-pr CAUGHT  alias-pr-base CAUGHT
destructure-pr CAUGHT    early-return CAUGHT      if-false-wrap CAUGHT
try-catch-wrap CAUGHT
```

이전 27가지 회귀 재확인: 전부 CAUGHT, survived = none.

기준선: `23 pass  0 fail  344 expect() calls`, `bun run typecheck` 오류 0.

## 감사 5라운드 — 하네스 자체가 공격면이 된다

실행 하네스를 감사에 넘겼다. 또 FAIL. 이번 지적은 성격이 다르다. 스크립트를 뚫은 게
아니라 **가짜가 진짜와 다른 지점**을 찾았다.

| 변이 | 하네스의 어떤 거짓말을 이용했나 |
| --- | --- |
| `if (typeof exec === "function") return;` | `exec`을 Proxy 객체로 줬다. 진짜는 함수다 |
| `if (!process.versions.bun) return;` | 테스트는 Bun, `github-script`는 Node |
| `Object.assign(pr, context.payload.pull_request)` | `context.payload.pull_request`가 `pr`의 얕은 복사라 `base`가 **같은 객체**였다. 실제로는 이벤트 페이로드가 stale하다 |
| `paginate` → 단일 `listComments` | 가짜 paginate가 한 페이지만 읽었다 |
| `const u = await update(...); if (u) return;` | 가짜 쓰기가 `undefined`를 반환했다. Octokit은 응답 객체를 준다 |
| `if (botComment && !storedState) return;` | 손상된 JSON 상태 분기를 커버하는 시나리오가 없었다 |

전부 프로덕션에서는 동작이 달라지고 테스트에서는 초록인 변이다. 오라클이 거짓말하면
그 위에 쌓은 증거는 값어치가 없다.

### 하네스 수정

- `exec`/`glob`/`io`/`fetch`/`require`를 **호출 가능한** Proxy로 바꿨다. 진짜처럼
  함수지만 실제로 호출하면 던진다 — 이 워크플로는 서브프로세스를 돌릴 이유가 없다.
- `process`를 Node로 보이게 섀도잉했다. `versions.node`, `GITHUB_ACTIONS=true`,
  runner 경로까지. 런타임 탐지가 두 환경을 구분하지 못한다.
- `context.payload.pull_request`를 `pr`과 **깊은 수준까지 독립**시키고,
  `eventPayload` 옵션으로 실제로 stale하게 만들 수 있게 했다.
- `paginate`가 모든 페이지를 순회하고, `listComments`가 `page` 인자를 존중한다.
  `commentPages`로 다중 페이지를 구성할 수 있다.
- 모든 쓰기가 Octokit 모양의 `{status, url, headers, data}`를 반환한다.

### 시나리오 3개 추가

- **stale 이벤트 페이로드**: 이벤트는 dev, 실제 PR은 main → 강제 적용된다.
  반대 방향(이벤트 main, 실제 dev)은 쓰기 0회.
- **봇 코멘트가 2페이지로 밀린 경우**: `listComments` 2회 호출, 기존 코멘트를
  찾아서 편집(중복 생성 0회).
- **손상된 상태 JSON**: 강제 적용은 그대로 진행되고, 코멘트는 제자리에서 복구되며,
  `core.warning`이 남는다.

## 변이 검증 실측 (46/46)

5라운드 7가지(파생 1건 포함):

```
detect-exec-fn CAUGHT        detect-bun-runtime CAUGHT   detect-node-runtime CAUGHT
stale-payload-overwrite CAUGHT drop-pagination CAUGHT    branch-on-response CAUGHT
bail-on-bad-state CAUGHT
```

이전 39가지 회귀 재확인: 전부 CAUGHT, survived = none.

기준선: `26 pass  0 fail  359 expect() calls`, `bun run typecheck` 오류 0.
전체 스위트(푸시 훅): `4907 pass  0 fail`.

## 감사 6라운드 — 전역 탈출, 에러 모양, 미커버 분기

5라운드 수정본을 다시 넘겼다. FAIL, 6건.

**전역 탈출 3건.** `compileScript`가 `new Function`을 쓰므로 컴파일된 본문이 전역
스코프를 본다. `process`를 파라미터로 넘겨 가려도 `globalThis.process`,
`Function("return process")()`, 그리고 `typeof Bun`은 진짜 런타임에 닿는다.
감사는 `if (typeof Bun === "undefined") return;`으로 프로덕션에서만 죽는 워크플로를
만들었다. 5라운드에서 `!process.versions.bun`을 막았더니 부정 방향으로 되받은 것이다.

**Octokit 에러 모양 1건.** `failOn`이 평범한 `Error`를 던졌다. 진짜는 `.status`를
가진 `RequestError`다. `catch (error) { if (error.status === 404) return; throw error; }`
— 404 하나만 삼키면 draft 변환 실패가 초록 워크플로가 된다.

**미커버 분기 2건.** `{active: true, titlePrefixedByBot: false, autoDraftedByBot: false}`은
도달 가능한 상태다(이미 접두사가 붙어 있고 이미 draft인 PR이 남긴다). 시나리오가
없어서, 이 조합에서 조기 반환하도록 양쪽 분기를 죽여도 초록이었다.

**느슨한 어설션 1건.** stale 페이로드 시나리오만 `toContain`을 썼다. 감사는 정확히
그 경로에 `github.request("POST /repos/attacker/other/issues")`를 매달았다.

### 대응

- 렉시컬 섀도잉 대상을 `RUNTIME_SHADOWS`로 확장했다: `process`, `globalThis`,
  `global`, `Bun`, `Deno`, `Function`, `eval`, `module`. `globalThis`는 자기 자신을
  가리키는 가짜 전역 객체로, 그 안의 `process`도 Node 모양이고 `Bun`은 undefined다.
  `Function`과 `eval`은 호출하면 던진다 — write 토큰을 쥔 워크플로가 런타임에 코드를
  컴파일할 이유는 없다.
- `failOn`이 `HttpError`(`.status`, `.response.status`)를 던진다. `failStatus`로
  코드를 지정할 수 있고, 테스트가 403/404/422/500을 순회한다.
- 시나리오 2개 추가: 변경 기록이 없는 활성 상태에서 (a) 여전히 잘못된 대상,
  (b) 리타깃 완료 — 양쪽 다 상태가 정리돼야 한다.
- stale 경로 어설션을 정확한 동등 비교로 바꿨다.

## 변이 검증 실측 (53/53)

6라운드 7가지:

```
detect-bun-absent CAUGHT   globalthis-process CAUGHT  function-escape CAUGHT
swallow-404 CAUGHT         noop-active-wrong CAUGHT   noop-active-correct CAUGHT
cross-repo-on-stale CAUGHT
```

이전 46가지 회귀 재확인: 전부 CAUGHT, survived = none.

기준선: `28 pass  0 fail  376 expect() calls`, `bun run typecheck` 오류 0.

## 감사 7라운드 — 지연 실행과 이미 손댄 PR

6라운드 수정본을 다시 넘겼다. FAIL, 8건 중 실질 2건.

**지연 실행 2건.** 하네스가 기다린 것은 스크립트 본문뿐이었다. 감사는
`setTimeout(() => github.request("POST /repos/attacker/other/issues"), 0)`와
`queueMicrotask(...)`를 본문 끝에 매달았다. 어설션이 끝난 뒤에 write가 떨어지니
기록에 남지 않았고 12개 시나리오가 전부 초록이었다. 진짜 Node에서는 그 콜백이
write 토큰을 쥔 클라이언트를 그대로 들고 실행된다.

**미커버 분기 2건.** `{autoDraftedByBot: true, pr.draft: false}`는 도달 가능하다 —
봇이 draft로 내렸고 작성자가 손으로 ready로 되돌린 뒤 대상을 고친 경우다.
`{titlePrefixedByBot: true, title이 접두사로 시작하지 않음}`도 마찬가지다 —
작성자가 접두사를 직접 지운 경우. 두 조합 모두 시나리오가 없어서, 앞쪽에서
조기 반환하거나 조건 없이 `slice`하도록 바꿔도 초록이었다. 후자는 프로덕션에서
작성자 제목의 앞 15자를 먹는다.

나머지 4건(스택 추적으로 하네스 탐지, 동적 `import`, 생성자 체인 탈출, `permissions`
키 중복)은 이미 잡히고 있었다. 감사가 초록을 확인하지 않고 올린 추정이었다.

### 대응

- `RUNTIME_SHADOWS`에 `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask`를
  추가했다. **차단이 아니라 캡처**다 — Node도 그 콜백을 돌리므로, 돌린 결과가
  기록에 남아야 시나리오의 정확한 호출 목록 비교가 그것을 본다. 스크립트 본문이
  resolve된 뒤 `for (const callback of deferred.splice(0)) await callback();`로
  드레인한다.
- 시나리오 2개 추가: 손으로 ready가 된 PR도 상태가 정리되는가, 작성자가 이미 고친
  제목을 두 번 자르지 않는가.

## 변이 검증 실측 (61/61)

7라운드 8가지:

```
stack-detect CAUGHT     dynamic-import CAUGHT   ctor-chain CAUGHT
floating-timer CAUGHT   floating-micro CAUGHT   dup-permissions CAUGHT
skip-undrafted CAUGHT   slice-unconditional CAUGHT

total=8 survived=none
```

이전 53가지 회귀 재확인:

```
mut6 (6라운드 7종)  total=7  survived=none
mut5 (5라운드 7종)  total=7  survived=none
mut4 (4라운드 13종) total=13 survived=['graphql-retarget(noop)']
mut3 (3라운드 26종) total=26 survived=['update-retargets-main(noop)']
```

NO-OP 2건은 들여쓰기 불일치로 치환 자체가 적용되지 않은 것이며, 개별 재확인 시
CAUGHT다. 워크플로는 매 실행 후 `git checkout --`로 원복되고 스크립트가 복원을
검증한다.

기준선: `30 pass  0 fail  384 expect() calls`, `bun run typecheck` 오류 0.

## 감사 8라운드 — 가짜의 표면이 곧 탐지 신호

7라운드 수정본을 넘겼다. FAIL, 3건. 셋 다 워크플로가 아니라 **하네스**를 쳤고,
셋 다 같은 문장이었다.

```
if (core.getInput?.("github-token")) return;
if (core.setOutput) return;
if (typeof getOctokit === "function") return;
```

메커니즘은 하나다. **러너에서 참인 것이 하네스에서 거짓이면, 그 차이가 곧 스위치다.**
`getOctokit`은 핀 고정된 액션이 스크립트 스코프에 실제로 주입하는 이름인데
하네스에는 없었다. `core.setOutput`과 `core.getInput`은 `@actions/core`가 내보내는데
하네스의 가짜 `core`에는 `info`/`warning`/`setFailed`/`notice`/`debug` 다섯 개뿐이었다.
게다가 `github-token` 입력은 `${{ github.token }}`을 기본값으로 갖는다 — 프로덕션에서
항상 비어있지 않다. 세 변이 모두 프로덕션에서는 게이트를 완전히 죽이고 여기서는
30개 시나리오가 전부 초록이었다.

### 세 개를 고치면 네 번째가 온다

지적된 이름만 추가하는 것은 1~3라운드의 부정 목록으로 되돌아가는 것이다. 문제는
`getOctokit`이 아니라 **하네스의 바인딩 목록이 손으로 고른 부분집합**이라는 사실이다.

그래서 핀 고정된 커밋의 소스에서 직접 옮겨왔다.
`actions/github-script@3a2844b7`의 `src/main.ts`는 `callAsyncFunction`에 객체를
넘기고 그 키가 곧 스크립트의 파라미터가 된다:

```
{ require, __original_require__, github, octokit, getOctokit,
  context, core, exec, glob, io }
```

`octokit`(같은 클라이언트의 두 번째 이름), `getOctokit`(똑같이 write 가능한 두 번째
클라이언트를 만드는 팩토리), `__original_require__` — 셋 다 없었다. `getOctokit`은
호출 가능해야 하고 **기록하는 클라이언트를 돌려줘야** 한다. 그러지 않으면
`getOctokit(token).rest.pulls.update(...)`가 여기서는 기록되지 않는 write이고
러너에서는 진짜 write다.

`core`도 같은 원리로 `@actions/core`의 export 목록 전체를 채웠다. 다만 write 토큰을
쥔 PR 위생 워크플로가 부를 이유가 없는 넷 — `exportVariable`, `setSecret`, `addPath`,
`getIDToken` — 은 **존재하되 호출하면 던진다**. 탐지에는 프로덕션과 같은 모양을
보여주고, 호출은 여전히 거부한다.

### 드리프트를 시끄럽게 만들기

바인딩 목록을 맞추는 것만으로는 액션을 재핀할 때 다시 벌어진다. 그래서 두 개를 추가했다.

- 목록 자체를 고정하는 테스트. `SCRIPT_BINDINGS`와 `core` 표면을 액션 소스에서 옮긴
  목록과 정확히 비교한다. 액션이 다른 스코프를 가진 버전으로 재핀되면 구멍이 조용히
  다시 열리는 대신 이 테스트가 깨지고 이유를 말한다.
- `runProbe(body)` — 워크플로 스크립트와 **같은 스코프에서** 임의의 본문을 돌리고
  반환값을 받는다. "저 안에서 변이가 무엇을 보는가"를 추측이 아니라 실측으로 묻는
  방법이다. 주입된 모든 이름이 `undefined`가 아님을, `core.getInput("github-token")`이
  비어있지 않음을, `core.isDebug()`가 false임을 확인한다.

하네스가 스크립트 반환값을 잡도록 `compileScript`를 고쳤다. 진짜 액션도
`const result = await callAsyncFunction(...)` 후 `core.setOutput`으로 내보내므로,
모델링 비용은 0이고 프로브가 보고할 통로가 생긴다.

## 변이 검증 실측 (71/71)

8라운드 지적 3건 + 같은 부류의 새 철자 7건:

```
getinput-token CAUGHT     setoutput-exists CAUGHT   getoctokit-typeof CAUGHT
octokit-alias CAUGHT      summary-probe CAUGHT      isdebug-probe CAUGHT
origreq-probe CAUGHT      platform-probe CAUGHT     getoctokit-write CAUGHT
octokit-write CAUGHT

total=10 survived=none
```

감사가 제안하지 않은 7가지가 함께 잡힌 것이 요점이다. 세 인스턴스가 아니라 부류가
닫혔다.

이전 61가지 회귀 재확인:

```
mut7 total=8  survived=none      mut6 total=7  survived=none
mut5 total=7  survived=none      mut4 total=13 survived=['graphql-retarget(noop)']
mut3 total=26 survived=['update-retargets-main(noop)']
```

기준선: `32 pass  0 fail  397 expect() calls`, `bun run typecheck` 오류 0,
`git status --short .github/` 클린.

## 감사 9라운드 — 이름은 맞췄으나 모양은 아니었다

9라운드는 서브에이전트가 돌리지 못했다. 적대적 변이라는 프레이밍이 콘텐츠 필터에
걸려 `errored`로 돌아왔다(`.codexclaw/friction.jsonl`에 기록). 같은 프롬프트를 다시
넣는 대신 세션에서 직접 배터리를 돌렸다 — 8라운드 수정이 **부류를 닫았는지**를
검증하는 것이 목적이었으므로, 검증자가 누구인지보다 변이가 실측으로 잡히는지가 중요했다.

25가지를 주입했다. **18가지가 살아남았다.** 8라운드 수정은 부류의 절반만 닫았다.

### 무엇을 놓쳤나

8라운드는 **주입되는 이름의 목록**을 액션 소스에서 옮겨왔다. 옳았지만 한 겹이었다.
각 바인딩의 **모양**은 여전히 손으로 고른 부분집합이었다.

- `context`는 `@actions/github`의 클래스다. 생성자가 `sha`, `ref`, `workflow`,
  `action`, `actor`, `job`, `runAttempt`, `runNumber`, `runId`, `apiUrl`,
  `serverUrl`, `graphqlUrl`를 환경에서 채우고 `issue`/`repo`는 getter다.
  하네스에는 4개뿐이었다. `typeof context.sha === "string"`은 모든 러너에서 참이고
  여기서는 거짓이었다 — 8라운드와 정확히 같은 메커니즘이 한 단계 아래에서 반복됐다.
- `process.env`는 5개뿐이었다. 러너는 `RUNNER_TEMP`, `GITHUB_SHA`,
  `GITHUB_WORKSPACE`, `ACTIONS_RUNTIME_TOKEN`을 포함해 30개 가까이 내보낸다.
- `github`은 객체 리터럴이었다. 프로덕션에서는 `Octokit` 인스턴스이므로
  `Object.getPrototypeOf(github) !== Object.prototype`이 참이다. 이 한 줄로
  하네스를 식별할 수 있었다.
- `github.hook`/`auth`/`log`/`paginate.iterator`가 없었다. `hook`이 특히 문제다 —
  `github.hook.before("request", …)`는 이름을 대지 않고 모든 나가는 호출을 다시 쓸 수
  있다.

### 대응

- `context`를 클래스로 만들고 실제 생성자가 채우는 필드를 전부 채웠다. `issue`와
  `repo`는 프로덕션처럼 getter다.
- `process.env`에 ubuntu-latest 러너가 실제로 내보내는 변수 목록을 채웠다.
- `github`을 `class Octokit`의 인스턴스로 바꿨다. `rest` 모양은 그대로다 — 문제는
  래퍼의 정체성뿐이었다.
- `hook`/`auth`/`log`/`paginate.iterator`를 추가했다. 전부 프로덕션의 `typeof`
  질문에 같은 답을 주고, `hook` 계열은 **호출하면 기록하고 던진다**. write 토큰을 쥔
  워크플로가 요청 훅을 다는 것은 특성화할 동작이 아니다. `paginate.iterator`는
  기록하는 비동기 이터레이터다 — `for await`로 페이징하는 재작성이 기록 밖으로
  걸어나가지 않도록.

### 살아남은 4가지는 실측으로 무해함을 확인했다

`context-eventname`, `core-tostring`, `promise-identity`, `err-tostringtag`.
프로브를 스크립트 스코프에서 돌려 값을 직접 읽었다:

```
{ "ctxEvent": "pull_request_target", "eventNameMismatch": false,
  "coreInfoNative": false, "promiseIdentity": false,
  "toStringTagInObject": false }
```

넷 다 하네스에서 `false`이고 프로덕션에서도 `false`다. `if (...) return;`이 양쪽
모두에서 발화하지 않는다. 즉 우회가 아니라 무해한 변이다 — 잡히지 않는 것이 정상이다.
"살아남았다"와 "우회다"는 다르며, 그 구분은 추측이 아니라 값을 읽어서 지었다.

## 변이 검증 실측 (92/92)

9라운드 25가지 중 21가지 CAUGHT, 4가지는 위와 같이 무해함 확인:

```
context-sha CAUGHT       context-actor CAUGHT     context-workflow CAUGHT
context-apiurl CAUGHT    context-issue CAUGHT     env-runner-temp CAUGHT
env-github-sha CAUGHT    env-workspace CAUGHT     env-actions-token CAUGHT
global-crypto CAUGHT     global-sclone CAUGHT     global-abort CAUGHT
global-textenc CAUGHT    global-url CAUGHT        global-buffer CAUGHT
github-hook CAUGHT       github-auth CAUGHT       github-log CAUGHT
paginate-iterator CAUGHT rest-meta CAUGHT         proto-identity CAUGHT
```

이전 71가지 회귀 재확인:

```
mut8b total=10 survived=none    mut7 total=8  survived=none
mut6  total=7  survived=none    mut5 total=7  survived=none
mut4  total=13 survived=['graphql-retarget(noop)']
mut3  total=26 survived=['update-retargets-main(noop)']
```

기준선: `32 pass  0 fail  397 expect() calls`, `bun run typecheck` 오류 0,
`git status --short .github/` 클린.

## 감사 10라운드 — 충실도는 재귀적이고, 계약은 호출 목록만이 아니다

9라운드가 "모양"을 맞췄으니 10라운드는 두 방향으로 밀었다. 하나는 **한 겹 더 깊이**,
다른 하나는 **탐지가 전혀 필요 없는 의미 약화**. 18가지 중 9가지가 살아남았다.

### 깊이 — 페이로드는 아직 부분집합이었다

`context`를 클래스로 만들고 필드를 채웠지만 `payload`는 여전히
`{ pull_request: eventPr }` 하나였다. 진짜 `pull_request_target` 이벤트는 `action`,
`number`, `repository`, `sender`를 함께 싣고, PR 객체 자체도 `head`, `html_url`,
`state`, `merged`, `labels`를 갖는다. `context.payload.pull_request.head.sha`
하나로 하네스를 식별할 수 있었다.

9라운드의 교훈이 한 단계 아래에서 그대로 반복된 것이다. **충실도는 목록이 아니라
재귀적 속성이다** — 어느 깊이에서 멈추든 그 아래가 다음 탐지면이 된다.

### 의미 — 초록인 채로 게이트를 무의미하게 만들기

탐지 없이도 통과하는 변이가 넷 있었다. 전부 "호출은 같은데 내용이 달라진" 경우다.

- **`per_page: 100` → `1`.** 호출 목록은 동일하다. 하지만 코멘트 많은 PR에서 봇이
  자기 코멘트를 찾으려면 100번을 왕복해야 하고, 그 중 한 번이라도 실패하면 상태를
  잃는다 — 중복 코멘트를 달고 자기가 무엇을 바꿨는지 잊는다. 성능 손잡이처럼 보이는
  것이 정확성 손잡이였다.
- **contributing 링크 삭제.** 코멘트는 이 게이트의 사용자 대면 절반 전부다. PR이
  이름이 바뀌고 draft로 내려간 이유를 말해주는 유일한 것인데, 어디를 읽으라는 안내가
  사라져도 아무 테스트도 깨지지 않았다.
- **`version: 1` → `2`.** 쓰는 쪽만 올리고 읽는 쪽은 그대로면, 이전 실행이 남긴
  상태를 아무도 존중하지 않는다. 접두사가 영원히 붙어있게 된다.
- **코멘트/변경 순서.** 전체 호출 목록을 비교하는 시나리오가 있어서 결과적으로는
  잡혔지만, 순서가 **복구 이야기 그 자체**라는 사실을 말하는 어설션은 없었다.
  코멘트가 먼저 떨어져야 중간 실패 후 재실행이 상태를 읽고 마무리할 수 있다.

### 대응

- `payload`에 실제 이벤트가 싣는 필드를, `DEFAULT_PR`에 실제 PR 객체가 갖는 필드를
  채웠다. 로직에는 무관하고 충실도에는 필수다.
- 시나리오 4개 추가: 코멘트가 작성자를 멘션하고 두 브랜치 이름과 문서 링크를
  담는가, `per_page`가 100인가, 상태 버전이 양쪽에서 1인가, 코멘트가 PR 변경보다
  먼저인가.

마지막 넷은 하네스 충실도 문제가 아니다. **계약이 호출 목록만이 아니라는 것**을
말하는 어설션이 없었을 뿐이다. 9라운드까지는 "어떻게 불렀나"를 지켰고, 10라운드는
"무엇을 말했나"를 지킨다.

### 살아남은 2가지

`response-headers`(`if (false) return;` — 상수 거짓이라 어느 쪽에서도 발화 안 함)와
`comment-after-write`(주석 한 줄 삽입, 동작 변화 없음). 둘 다 무해한 변이다.

## 변이 검증 실측 (110/110)

10라운드 18가지 중 16가지 CAUGHT:

```
pr-payload-fields CAUGHT  payload-repo CAUGHT      payload-action CAUGHT
payload-sender CAUGHT     pr-html-url CAUGHT       rest-shape-deep CAUGHT
rest-issues-deep CAUGHT   rest-repos CAUGHT        expected-base-main CAUGHT
marker-changed CAUGHT     bot-login-changed CAUGHT drop-mention CAUGHT
per-page-1 CAUGHT         prefix-changed CAUGHT    state-version-bump CAUGHT
drop-contrib-link CAUGHT
```

이전 92가지 회귀 재확인:

```
mut9b total=25 survived=[무해 4]   mut8b total=10 survived=none
mut7  total=8  survived=none       mut6  total=7  survived=none
mut5  total=7  survived=none       mut4  total=13 survived=[noop 1]
mut3  total=26 survived=[noop 1]
```

기준선: `36 pass  0 fail  419 expect() calls`, `bun run typecheck` 오류 0,
`git status --short .github/` 클린.

## 감사 11라운드 — 모든 층을 정확 비교로 고정했는데 한 곳만 아니었다

10라운드까지의 YAML 층은 **정확한 키 집합 동등 비교**로 지어져 있다. 최상위 키,
`permissions`, `concurrency`, 잡 목록, 잡의 키, 스텝 수, 스텝의 키, `with`의 키 —
전부 `toEqual`이다. 딱 한 곳만 아니었다. `on`의 **키가 `pull_request_target` 하나**인
것은 확인했지만, 그 **안쪽 모양**은 확인하지 않았다.

독립 감사가 정확히 그 구멍으로 들어왔다.

```yaml
on:
  pull_request_target:
    branches:
      - main
    types: [...]
```

`branches: [main]`은 게이트를 main을 대상으로 한 PR로 좁힌다. `preview`를 향해 열린
PR은 아무 처리 없이 지나간다. 더 나쁜 것은 `paths:`다 — 특정 파일이 바뀔 때만
발화하므로 문서만 고친 PR에서는 영원히 돌지 않는다. 넷 다 diff에서는 평범한 범위
지정처럼 보이고, 넷 다 어떤 어설션도 깨지 않았다.

직접 확인한 결과 `branches`, `branches-ignore`, `paths`, `paths-ignore` **4가지가
전부 살아남았다**. 반면 `synchronize` 추가, `workflow_dispatch` 추가, `schedule`
추가는 이미 잡히고 있었다 — 트리거 **목록**과 **타입 배열**은 고정돼 있었고,
트리거의 **필터**만 비어 있었다.

### 대응

한 줄이다. 다른 모든 층과 같은 방식으로 고정했다.

```
expect(Object.keys(workflow.on?.pull_request_target ?? {})).toEqual(["types"]);
```

타입 배열 자체는 이미 별도 테스트가 정렬 비교로 고정하고 있어 중복을 만들지 않았다.

이 라운드의 교훈은 새 원리가 아니라 **일관성**이다. 정확 비교를 열한 곳에 적용하고
한 곳을 빠뜨리면, 공격은 정확히 그 한 곳으로 온다. 층을 세는 것보다 층마다 같은
규율이 적용됐는지 훑는 편이 빠르다.

## 변이 검증 실측 (117/117)

11라운드 7가지:

```
branches-filter CAUGHT   branches-ignore CAUGHT   paths-filter CAUGHT
paths-ignore CAUGHT      add-synchronize CAUGHT   extra-trigger CAUGHT
schedule-trigger CAUGHT

total=7 survived=none
```

이전 110가지 회귀 재확인:

```
mut10b total=18 survived=[무해 2]  mut9b total=25 survived=[무해 4]
mut8b  total=10 survived=none      mut7  total=8  survived=none
mut6   total=7  survived=none      mut5  total=7  survived=none
mut4   total=13 survived=[noop 1]  mut3  total=26 survived=[noop 1]
```

기준선: `36 pass  0 fail  420 expect() calls`, `bun run typecheck` 오류 0,
`git status --short .github/` 클린.

## 감사 12라운드 — 동작의 구멍, 그리고 거부의 모양

11라운드 수정을 같은 감사자에게 재감사시켰다. 트리거 수정은 **확인됐다** —
감사자가 `<<: { branches: [main] }` 병합 키까지 시도했으나 YAML 파서가 펼치면서
`["branches","types"]`로 잡혔다. 대신 다른 부류 3건을 가져왔고, 재현하며 2건을 더
찾았다.

이번 5건은 하네스 충실도 문제가 아니다. **시나리오가 없는 도달 가능한 상태**들이다.

### 제목 경계 3건

`TITLE_PREFIX`는 **기여자가 쓸 수 있는 문자열**이다. 이 사실이 세 변이의 공통
전제다.

- `pr.title === TITLE_PREFIX` — `startsWith`가 참인 값이므로, 이 등가 비교로 조기
  반환하면 제목을 `"[WRONG BRANCH] "`로 지은 PR이 통째로 면제된다.
- `!pr.title` — GitHub이 허용하지 않지만 스크립트는 확인하지 않는다. 리뷰에서
  방어적으로 보이는 한 줄이다.
- `startsWith(TITLE_PREFIX + TITLE_PREFIX)` — 가장 교묘하다. "접두사 중복 방지"처럼
  읽히지만, 접두사가 기여자 소유 텍스트이므로 **기여자가 의도적으로 만족시킬 수
  있는 조건**이다. 실측으로 확인했다: 이 가드가 있을 때
  `"[WRONG BRANCH] [WRONG BRANCH] mine"` 제목의 main 대상 PR은
  `["pulls.get","issues.listComments"]`만 남기고 끝난다 — 코멘트도 draft도 없는
  완전 면제.

### 봇 코멘트 중복 1건

`find` → `findLast`. 한 단어 차이로 정반대 상태를 고른다. 중복 봇 코멘트는 실제로
생긴다(실패한 실행이 남긴 것, 워크플로가 두 벌 돌던 시절의 잔재). 둘이 모순된
상태를 담고 있으면 **어느 쪽이 권위인가**가 제목 복원 여부를 결정한다. 페이지네이션
시나리오는 있었지만 매칭 코멘트가 둘인 경우는 없었다.

### `pulls.get` 실패 1건 — 그리고 하네스 버그

```js
}).catch(error => {
  if (error.status === 404) {
    return { data: { base: { ref: EXPECTED_BASE } } };
  }
  throw error;
});
```

권위 있는 읽기의 실패를 **"올바른 대상인 척하는 가짜 PR"** 로 바꾼다. 집행 장애가
초록 체크가 되고, 그동안 잘못된 대상의 PR은 전부 통과한다.

시나리오를 추가했는데도 잡히지 않았다. 원인은 하네스였다. 모든 클라이언트 메서드가
`Promise.resolve(record(...))` 형태였고, `record`가 **동기적으로 던지므로** 실패가
거부된 프로미스가 아니라 동기 예외로 튀어나왔다. 진짜 Octokit은 프로미스를 돌려주고
그것을 거부한다. 차이는 스크립트에서 보인다 — 동기 예외에는 `.catch()` 핸들러가
아예 실행되지 않는다. `respond()` async 헬퍼로 전부 라우팅해서 고쳤다.

**거부의 모양도 충실도의 일부다.** 6라운드에서 `RequestError`의 `.status`를 맞췄지만,
거부가 **언제** 일어나는가는 그때 맞추지 않았다.

## 변이 검증 실측 (123/123)

12라운드 6가지:

```
title-eq-prefix CAUGHT    title-empty-skip CAUGHT   title-double-pfx CAUGHT
findlast-comment CAUGHT   get-swallow-404 CAUGHT    base-case-insens CAUGHT

total=6 survived=none
```

이전 117가지 회귀 재확인:

```
mut11b total=7  survived=none      mut10b total=18 survived=[무해 2]
mut9b  total=25 survived=[무해 4]  mut8b  total=10 survived=none
mut7   total=8  survived=none      mut6   total=7  survived=none
mut5   total=7  survived=none      mut4   total=13 survived=[noop 1]
mut3   total=26 survived=[noop 1]
```

기준선: `42 pass  0 fail  455 expect() calls`, `bun run typecheck` 오류 0,
`git status --short .github/` 클린.

## 열두 라운드가 남긴 것

설계가 세 번 바뀌었고, 매번 앞 라운드가 그 방향의 한계를 증명했다.

1. **부정 목록** (1~3라운드) — "이 키는 없어야 한다". 20번 뚫렸다. 감사자가 생각해낸
   키만 덮는다.
2. **허용 목록** (4라운드) — "정확히 이 키들". YAML 골격에는 유효했고 지금도 유지된다.
   하지만 스크립트 본문에는 통하지 않았다. JavaScript는 같은 효과에 무한한 철자가 있다.
   그리고 11라운드가 보였듯, 허용 목록은 **빠짐없이 적용될 때만** 허용 목록이다 —
   열두 층 중 열한 층에 적용하면 공격은 남은 한 층으로 온다.
3. **실행 하네스** (5~10라운드) — 읽지 말고 돌려라. 철자는 무의미해졌지만, 이번엔
   **가짜의 충실도**가 새 공격면이 됐다. 여섯 라운드 연속으로 스크립트가 아니라
   하네스가 뚫렸다 — 전역 탈출, 에러 모양, 이벤트 루프, 바인딩 이름, 바인딩 모양,
   페이로드 깊이.

세 번째가 옳은 방향이다. 다만 오라클의 충실도가 곧 증거의 품질이다. 앞으로 이
하네스를 손댈 때 물어야 할 질문은 하나다 — **진짜 `github-script` + Octokit이라면
어떻게 행동하나.** 다르게 행동하는 지점이 곧 다음 우회다.

8라운드가 그 질문에 답하는 방법을 하나 더 보탰다. 추측하지 말고 **핀 고정된 커밋의
소스에서 옮겨오고, 옮겨온 목록 자체를 테스트로 고정하라.** 그러면 액션을 재핀할 때
구멍이 조용히 열리는 대신 테스트가 깨진다.

9라운드는 그 규칙이 한 겹으로는 부족함을 보였다. 이름 목록을 맞춰도 각 바인딩의
**모양**이 부분집합이면 같은 공격이 한 단계 아래에서 반복된다. `context`는 4개
필드가 아니라 클래스이고, `github`은 리터럴이 아니라 인스턴스다. 충실도는 목록이
아니라 재귀적 속성이다.

그리고 방법론 하나 — **"살아남았다"는 "우회다"가 아니다.** 9라운드의 25가지 중
4가지는 살아남았지만 프로덕션에서도 발화하지 않는 무해한 변이였다. 프로브로 값을
직접 읽어 구분했다. 이 구분을 생략하면 무해한 변이를 쫓느라 하네스를 필요 이상으로
복잡하게 만들게 된다.

10라운드는 마지막 축을 추가했다. 하네스 충실도를 아무리 올려도 **계약이 호출 목록만
이라고 믿는 한** 같은 호출로 다른 것을 말하는 변이는 통과한다. `per_page: 1`,
사라진 문서 링크, 조용히 올라간 상태 버전 — 전부 호출 순서와 이름이 동일하다.
게이트의 절반은 사용자에게 무엇을 말하는가이고, 그쪽에도 어설션이 필요하다.

## 범위 밖

게이트 자체의 재설계는 040이 다루며 사용자 승인 대기 상태다. 이 테스트는 재설계를
막지 않는다 — 재설계가 어떤 성질을 의도적으로 바꾸는지 드러낼 뿐이다.
