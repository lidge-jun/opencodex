# 050 — WP4: `enforce-pr-target.yml` 권한 결함

발견: WP0 트리아지(`002`), 원인 확정: WP3 감사
대상 파일: `.github/workflows/enforce-pr-target.yml`

## 증상

잘못된 base를 겨냥한 **ready 상태** PR에서 `enforce-target` 잡이 실패한다.

```
run 30240509333 (feat/glm-provider)
GraphqlResponseError: Request failed due to following response errors:
 - Resource not accessible by integration
##[error]Unhandled error: GraphqlResponseError
response: { data: { convertPullRequestToDraft: null }, errors: [ [Object] ] }
```

## 원인

### 먼저: 어느 파일이 실제로 실행되는가 (A단계 감사 블로커 2)

`pull_request_target`은 워크플로를 **base 브랜치**에서 로드한다. 따라서 실패한 실행이
돌린 코드는 `dev`의 파일이 아니다.

| 브랜치 | 26행 | 판정식 |
|--------|------|--------|
| `origin/dev` | `ALLOWED_BASES = ["dev", "dev2-go"]` | `!ALLOWED_BASES.includes(...)` |
| `origin/main` | `EXPECTED_BASE = "dev"` | `pr.base.ref !== EXPECTED_BASE` |
| `origin/dev2-go` | `EXPECTED_BASE = "dev"` | `pr.base.ref !== EXPECTED_BASE` |

실패한 두 실행의 base를 보면:

- **#536** base=`main` → `origin/main`의 구버전 스크립트가 실행됐다
- **#527** base=`codex/catalog-written-signal` → 그 브랜치의 스크립트가 실행됐다

즉 **`dev`에만 수정을 넣으면 정작 결함이 발화하는 모집단에는 닿지 않는다.** 잘못된
타깃 PR은 정의상 base가 `dev`가 아니므로, `dev`의 워크플로는 그들에게 실행되지 않는다.
이건 인용 오류가 아니라 **수정 범위 오류**다.

수정은 `dev`뿐 아니라 `main`, `dev2-go`, 그리고 스택 PR의 base가 될 수 있는 브랜치에도
전파되어야 실효가 있다. `main` 변경은 릴리스 승격 경로이므로 별도 결정이 필요하다.

`d761e880`(ALLOWED_BASES 확대)이 `dev`에만 있다는 사실도 같은 이유로 중요하다.
`main`을 겨냥한 PR은 여전히 `dev2-go`를 허용하지 않는 구버전 판정을 받는다.

워크플로는 잘못된 base를 발견하면 세 가지를 한다.

1. 설명 코멘트를 upsert (REST) — 성공
2. 제목에 `[WRONG BRANCH] ` 접두사 (REST `pulls.update`) — 성공
3. `convertPullRequestToDraft` (GraphQL) — **실패**

`permissions:`는 `pull-requests: write`만 부여하는데 draft 전환에는 부족하다. 그리고
워크플로에 `try`/`catch`도 `core.setFailed`도 없어서 **처리되지 않은 예외가 잡 전체를
죽인다.**

실측 확증(WP0 시점):

| PR | 제목 접두사 | draft 전환 |
|----|-------------|------------|
| #527 | 붙음 | 실패 (`isDraft: false`) |
| #536 | 붙음 | 실패 (`isDraft: false`) |

REST는 되고 GraphQL만 안 되는 비대칭이 원인을 그대로 보여준다.

### fork 여부는 원인이 아니다

`pull_request_target`에서 fork PR의 토큰 제약을 의심할 수 있으나, 두 실패의 head
저장소가 다르다:

| PR | head 저장소 소유자 | fork? | enforce-target |
|----|--------------------|-------|----------------|
| #536 | `Lucinegogo` | 예 | 실패 (run 30240509333, 30240464022) |
| #527 | `lidge-jun` | **아니오** (같은 저장소 브랜치) | 실패 (run 30230447266) |

#527의 실패 로그도 동일하다:

```
convertPullRequestToDraft(
GraphqlResponseError: Request failed due to following response errors:
##[error]Unhandled error: GraphqlResponseError
 - Resource not accessible by integration
```

같은 저장소 브랜치에서도 같은 지점에서 죽으므로 fork 격리가 아니라 **토큰 권한 자체**가
원인이다. 이 구분은 수정 방향을 가른다 — fork 문제였다면 권한 확대로 해결되지 않는다.

감사 확인: #527의 실패 로그(run 30230447266)도 동일한 `Metadata: read / PullRequests: write`
스코프 블록과 `FORBIDDEN`, 동일한 스택 프레임 `at async convertToDraft`를 보인다.

용어 정정: `pull_request_target`은 fork의 컨텍스트가 아니라 **base 저장소 컨텍스트**에서
돈다. 그래서 fork PR이 열등한 케이스가 아니며, 동시에 그래서 위험하다. 초안의
"fork PR의 컨텍스트에서 돈다"는 서술은 틀렸다.

## 발화 조건 (WP3 감사에서 좁힘)

"잘못된 타깃 전부"가 아니다. **`!pr.draft`일 때만** `convertToDraft()`가 호출된다
(`enforce-pr-target.yml`, wrongBase 분기 말미). 따라서:

| 상태 | 결과 |
|------|------|
| ready + 허용 안 된 base | **실패** |
| draft + 허용 안 된 base | 통과 (뮤테이션 스킵) |
| 허용된 base | 통과 (분기 자체 미진입) |

실측: #536이 `dev`로 리타깃된 뒤 `feat/glm-provider` 실행(`30250881926`,
`30250880040`)이 **success**다.

## 2차 결함: 상태 손상으로 복원이 영구 차단된다

더 심각한 문제가 있다. 워크플로는 PR을 바꾸기 **전에** 상태를 코멘트에 저장한다:

```js
if (!pr.draft) {
  state.autoDraftedByBot = true;     // "내가 draft로 만들었다"고 기록
}
...
await upsertComment([... stateMarker(state) ...]);   // 먼저 저장
...
if (!pr.draft) {
  await convertToDraft();            // 그 다음 실행 — 여기서 죽는다
}
```

주석은 "API 요청이 중간에 실패해도 재실행으로 복구할 수 있게" 먼저 저장한다고 설명한다.
의도는 옳지만 결과는 반대다. `autoDraftedByBot: true`가 기록됐는데 전환은 실패했으므로,
**기록된 상태와 실제 PR 상태가 어긋난다.**

나중에 작성자가 base를 고치면 복원 경로가 이렇게 판단한다:

```js
if (storedState.autoDraftedByBot && pr.draft) {
  await markReadyForReview();
}
```

`autoDraftedByBot`은 `true`지만 `pr.draft`는 `false`(전환이 실패했으니)이므로 조건이
거짓이다. 다행히 이 경우엔 아무 일도 안 일어나고 PR은 이미 ready이므로 실질 피해가 없다.

**실측으로 확인.** #536 타임라인(감사에서 정밀화):

```
07:53:54Z  Ingwannu가 종결
08:41:43Z  lidge-jun이 재개
08:41:46Z  base main -> dev 변경
08:41:52Z  github-actions가 제목 접두사 제거
```

(초안이 적은 08:52Z는 리타깃 시각이 아니라 무관한 `updatedAt`이다.)

리타깃 후 상태 코멘트:

```
state: {"version":1,"active":false,"autoDraftedByBot":false,"titlePrefixedByBot":false}
"✅ Target branch corrected" / 제목 접두사 제거됨 / draft=false
```

이 경로에서는 복원이 정상 동작했다. 하지만 그것이 "자기 치유"를 뜻하지는 않는다 —
아래를 볼 것.

### 자기 치유가 아니다 — 거짓 상태가 지금 축적되고 있다 (감사 블로커 4)

초안은 위험한 방향이 가설일 뿐이라고 적었다. **틀렸다.** 지금 이 순간에도 거짓 상태가
쌓이고 있고, 권한 문제가 어떤 방식으로든 해결되는 순간 오발한다.

제목 접두사는 성공하고 전환은 실패하므로, 저장된 상태에는 `autoDraftedByBot: true`가
**영구히 남는다** — PR은 한 번도 draft가 된 적이 없는데도. 이 거짓말은 코멘트 마커에
저장되어 무기한 살아남는다.

구체적 피해 시나리오:

1. 결함기에 어떤 PR이 접두사를 받고 `autoDraftedByBot: true`를 기록한다(실제로는 draft 아님).
2. 작성자가 **스스로** 그 PR을 draft로 내린다.
3. 작성자가 base를 고친다.
4. 복원 경로가 `autoDraftedByBot(true) && pr.draft(true)` → 참이므로
   `markReadyForReview()`를 호출해 **작성자가 의도적으로 내린 draft를 되돌린다.**

이는 워크플로가 244-245행 주석에서 명시적으로 약속한 "의도적으로 draft인 PR은 draft로
유지된다"를 정면으로 위반한다. 낡은 `true`가 가드를 무력화한다.

### 제목 접두사가 영구히 남을 수 있다 (감사 블로커 5)

복원은 `storedState.titlePrefixedByBot`을 요구한다(232-235행). 봇 코멘트가 **삭제되면**
`parseState`가 `null`을 반환하고 `storedState?.active`가 거짓이 되어 222-228행에서 조기
반환한다. 그러면 `[WRONG BRANCH] ` 접두사는 **영원히 제거되지 않는다.**

코멘트 삭제는 권한 없는 일상적 행위다. 복구 경로는 수동 편집뿐이다. 초안의 4단계
검증 체크리스트는 이 경우를 커버하지 않는다.

## 수정 방향

### A. 권한을 넓힌다 — **선택지가 아니다** (A단계 감사 블로커 1)

초안은 이를 살아있는 대안으로 제시했으나 틀렸다. `convertPullRequestToDraft`는
**GitHub Actions 설치 토큰(`GITHUB_TOKEN`) 자체를 거부한다.** 어떤 `permissions:`
스코프를 붙여도 해결되지 않는다. 근거: fork(#536)와 같은 저장소(#527) 양쪽에서
동일하게 `Resource not accessible by integration`이 나며, 실패 로그의 스코프 블록은
`PullRequests: write`가 이미 부여됐음을 보여준다. 권한이 부족한 게 아니라 **토큰 종류가
거부되는 것**이다.

따라서 "필요한 스코프를 추가한다"는 실행 불가능하다. 그대로 두면 메인테이너가 존재하지
않는 스코프를 찾아 보안 검토를 잡거나, 근거 없는 `contents: write` 민간요법을 도입해
`pull_request_target` 워크플로에 아무 기능적 이득 없이 콘텐츠 쓰기 권한을 주게 된다.

실제 대안은 PAT 또는 GitHub App 토큰이며, 그건 권한 확대보다 훨씬 큰 보안 결정이다.
또는 draft 전환을 포기한다.

`tests/ci-workflows.test.ts:466`이 `permissions`를 `{ "pull-requests": "write" }`로
정확히 단언하고 `:134-138`이 `contents` 속성을 금지한다. 이 단언들은 바로 이 종류의
권한 확대를 막으려고 존재한다 — A에 대한 반대 증거다.

### B. 실패를 우아하게 처리한다 — **단독으로는 불충분**

draft 전환을 `try`/`catch`로 감싸고, 실패해도 잡을 죽이지 않는다.

```js
let drafted = false;
if (!pr.draft) {
  try {
    await convertToDraft();
    drafted = true;
  } catch (error) {
    core.warning(`Could not convert to draft: ${error.message}`);
  }
}
state.autoDraftedByBot = drafted;   // 실제 결과를 기록
```

상태를 **실제 결과로** 기록하려면 코멘트 저장을 전환 뒤로 옮겨야 한다. 그러면 주석이
말하는 "부분 실패 복구" 의도가 깨지므로, 대안은 두 번 저장하는 것이다: 먼저 보수적으로
저장하고, 전환 결과가 나오면 갱신한다.

- 장점: 권한 상승 없음. 제목 접두사와 안내 코멘트는 계속 동작하므로 워크플로의
  주된 목적(작성자에게 알리기)은 유지된다. 체크가 녹색이 되어 진짜 실패와 구분된다.
- 단점 (감사 블로커 3): 초안은 "지금도 ready로 남으므로 동작상 차이가 없다"고 적었다.
  PR 관점에서는 맞지만 **신호 관점에서는 틀렸다.** 지금 빨간 체크는 이 결함을 발견
  가능하게 만드는 유일한 산출물이다 — WP0 트리아지가 이걸 잡은 것도 그 덕이다. B만
  적용하면 잘못된 타깃 PR마다 영원히 초록불이 뜨고, `core.warning`은 아무도 안 읽는
  로그로 흘러간다. "타깃 강제가 동작하나?"라고 묻는 다음 사람은 초록불을 보고 넘어간다.

  거버넌스 통제에서는 **조용한 미집행이 시끄러운 고장보다 위험하다.** 빨간 체크는 적어도
  고장났다는 사실에 정직하다. B 단독은 수리가 아니라 은폐다.

### C. 집행 수단을 교체한다 — **권장**

draft 전환 없이 원래 목적(잘못된 타깃 PR을 리뷰 대기열에서 빼기)을 달성한다.

1. **실패 상태 체크로 집행한다.** 잘못된 타깃일 때 `core.setFailed`로 명시적으로 실패
   시킨다. 지금과 겉보기는 같지만 의미가 다르다 — 처리되지 않은 예외가 아니라 의도된
   실패이고, 메시지가 원인을 말한다. 추가 권한이 필요 없다.
2. **라벨로 표시한다.** `issues: write`로 `wrong-target` 라벨을 붙인다. 리뷰 대기열
   필터링이 가능해지고, draft 전환보다 되돌리기 쉽다.

두 방식 다 권한 상승 없이 집행 의도를 유지한다. B의 오류 처리(예외로 잡을 죽이지 않기)는
어느 쪽을 택하든 함께 들어가야 한다.

## 권고

**C(1) + B의 오류 처리를 권장한다.** 초안의 A/B 이분법은 거짓 선택이었다 — A는 실행
불가능하고 B는 은폐다. 의도된 실패 + 명확한 메시지가 권한 상승 없이 정직한 신호를 준다.

**단, 수정은 `dev`만으로 부족하다.** 위에서 확인했듯 `pull_request_target`은 base
브랜치의 워크플로를 실행하므로, 잘못된 타깃 PR에는 `main`/`dev2-go`/스택 base의 파일이
돈다. 전파 범위를 정하는 것 자체가 별도 결정이다.

## 이번 루프에서 구현하지 않는 이유

`.github/workflows/` 변경은 `AGENTS.md`가 명시적 보안 검토를 요구하는 범주다
(릴리스 자동화·워크플로 권한). 사용자가 승인한 범위는 `dev` 푸시(#539 수정)였고
워크플로 수정은 별도 결정이다. 판정과 수정 방향까지 문서화하고 실행은 보류한다.

감사 정정 두 가지. 첫째, `AGENTS.md:83-89`는 워크플로 변경 **전반**에 보안 검토를
요구하므로 수정 B나 C도 그 경계 안이다 — A만 검토 대상이라고 읽은 것은 부정확했다.
결론(둘 다 보류)은 그대로다. 둘째, `MAINTAINERS.md:60-64`가 CODEOWNERS는 "리뷰를
요청할 뿐 강제하지 않으며 브랜치 보호가 없어 게이트가 아니다"라고 밝힌다. 즉 이 보류는
자동화가 아니라 사람의 규율에 의존한다.

여기에 더해, 이번 감사가 밝힌 전파 범위 문제(`main`/`dev2-go`에도 수정이 필요) 때문에
구현은 더더욱 단독 결정이 아니다. `main` 워크플로 변경은 릴리스 승격 경로를 건드린다.

## 검증 (구현 시)

### 로컬 검증이 가능하다

`tests/helpers/enforce-pr-target-harness.ts`가 워크플로 스크립트를 실제로 실행하는
하네스를 제공한다. `failOn` 집합에 메서드명을 넣으면 그 호출이 `octokitError`로
거부되므로, **GraphQL 실패를 주입해 이 결함을 로컬에서 재현할 수 있다.**

즉 이 결함은 처음부터 테스트로 잡을 수 있었다. 하네스 주석이 "이 워크플로는 기여자의
PR을 변형하는 유일한 워크플로이고 `pull_request_target`으로 base 저장소 쓰기 토큰을
들고 돈다"고 명시하면서도, 정작 **뮤테이션이 실패하는 경로는 커버하지 않았다.** 성공
경로만 특성화한 것이다.

구현 시 추가할 케이스:

```ts
test("a draft conversion the token cannot perform does not kill the job", async () => {
  // failOn: convertPullRequestToDraft (또는 graphql)
  // 단언: 스크립트가 예외로 죽지 않는다
  //       제목 접두사와 안내 코멘트는 정상 적용된다
  //       저장된 상태의 autoDraftedByBot이 실제 결과(false)를 반영한다
});

test("a PR already in draft never attempts the conversion", async () => {
  // 단언: calls 기록에 convertPullRequestToDraft가 없다 (발화 조건 증명)
});
```

두 번째 케이스가 특히 중요하다. 발화 조건(`!pr.draft`)을 코드가 아니라 호출 기록으로
증명하므로, 나중에 조건이 바뀌면 바로 드러난다.

### 실제 실행 검증

로컬 하네스는 스크립트 로직을 증명하지만 실제 토큰 권한은 증명하지 못한다. 권한 관련
최종 확인은 실행으로만 얻는다.

1. ready 상태 + 허용 안 된 base인 테스트 PR을 만든다.
2. `enforce-target`이 **success**이고 제목 접두사와 안내 코멘트가 정상인지 확인한다.
3. base를 고친 뒤 접두사 제거와 상태 코멘트 갱신이 동작하는지 확인한다.
4. draft 상태 PR에서도 기존 동작이 유지되는지 확인한다.

`tests/ci-workflows.test.ts`가 워크플로 파일의 구조를 검증하므로, 경로 허용 목록과
권한 블록에 대한 단언이 있으면 함께 갱신한다.

`ci-workflows.test.ts:134`가 `workflow.permissions`를 정확히 단언하므로, 수정 A(권한
확대)를 택하면 이 단언도 함께 바뀌어야 한다. 그 단언이 존재한다는 사실 자체가 권한
변경을 의도적 결정으로 만든다 — 조용히 넓힐 수 없다.
