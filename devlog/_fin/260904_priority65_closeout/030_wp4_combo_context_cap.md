# wp4 — PR #3461 provider-specific context-cap failover 스쿼시 머지

대상: PR [#3461](https://github.com/lidge-jun/opencodex/pull/3461) (@RHODIZSECURITY),
head `4e16f889b`, +46/-0, 3파일.

## 결함

`src/lib/errors.ts:183-189`가 `"maximum context"` 문자열을 무조건
`context_length_exceeded`로 remap하고, `src/combos/failover.ts`의 stop 리스트가
그 코드를 잡는다. 그래서 vendor code 5059를 쓰는 프로바이더가
`Prompt 346030 > 262144 maximum context length`를 돌려주면, 뒤에 더 큰 컨텍스트
타깃이 남아 있어도 combo 체인이 첫 타깃에서 끝난다.

## 왜 이 PR이 맞는가

매처가 좁다. `isProviderTargetContextOverflow`는 status 400 **그리고**
(`invalid_request_prompt_too_long` 문자열 **또는** 코드 5059 **및**
`Prompt N > M maximum context length` 정규식)을 요구한다. 5059 단독은 여전히 stop이다.
PR의 테스트가 이 두 방향을 모두 단언한다.

삽입 위치도 옳다. `isCyberPolicyCode` 뒤, stop 리스트 앞이라 정책 코드가 우선한다.

`options.code`의 출처는 업스트림 응답 JSON이다 —
`normalizeUpstreamErrorText`(`src/server/responses/core.ts:770`)가 error 객체에서
뽑는다. 최종 사용자가 주입하는 값은 아니지만, **업스트림 프로바이더는 이 코드를
의도적으로 세울 수 있다.** 저장소는 이미 그 사실을 알고 판정을 내려 두었다 —
`src/combos/failover.ts:337`의 주석이 "an upstream can still SET this code
deliberately, since both extractors read the upstream error object. That is bounded
rather than dangerous"라고 적는다.

이 판정을 그대로 승계한다. 최악의 경우가 "다음 combo 타깃으로 한 번 더 넘어간다"이고,
순회는 `pick.attempted`로 유한하므로(`src/combos/resolve.ts:224`) 무한 루프가 없다.

## 기존 단정 보존 확인

`tests/combos.test.ts`의 다음 단정이 그대로 통과해야 한다. 셋 다 구조화 코드가
없으므로 새 매처가 발화하지 않는다.

- `comboFailureDecision(400, "context_length_exceeded")` → `stop`
- `comboFailureDecision(413, "request too large")` → `stop`
- `comboFailureDecision(400, "ordinary invalid request", { code: "5059" })` → `stop`

이것이 #3348과 결정적으로 다른 점이다. #3348은 같은 문제를 풀면서 generic 410/413을
통째로 hop 리스트에 넣어 위 단정 셋을 뒤집는다.

## 스코프

- IN: PR을 있는 그대로 스쿼시 머지.
- OUT: 코드 수정, 리베이스, 추가 매처 확장.

## 실행 절차 (P-phase 개정 — 직접 스쿼시에서 carry로)

**개정 사유.** 계획 수립 시점에는 `gh pr merge 3461 --squash --admin`을 예정했다.
실행 직전 확인에서 전제 하나가 무너졌다: #3461은 **fork PR**이고
(`head.repo.fork = true`, author `RHODIZSECURITY`), 그 head `4e16f889b`에는
게이트 4개(enforce-target/hygiene/label/resolve-pr)만 돌았을 뿐
**Cross-platform CI가 한 번도 실행되지 않았다.** `gh run list --commit 4e16f889b`가
빈 출력이고, fork PR의 워크플로는 `action_required` 승인 대기로 걸린다.

AGENTS.md가 적은 그대로다 — "fork contributors cannot start repository CI; a
maintainer has to". 게이트 4개만 초록인 상태를 "CI green"이라고 부르고 머지하면
이 유닛의 criterion c-2(각 PR이 exact head에서 required CI green)를 위반한다.

**개정안: 이 유닛의 stacked PR 체인에 carry한다.**

1. `git fetch origin dev` — dev head를 다시 읽는다(이미 `2421e44ce` → `1a5c9ab23`으로 움직였다).
2. `git fetch origin pull/3461/head` 로 원 커밋을 가져와 `codex/priority65-closeout`
   위에 cherry-pick한다. 코드는 한 줄도 바꾸지 않는다 — 감사에서 그대로 머지 가능 판정이 났다.
3. cherry-pick은 원 author를 보존하지만, 스쿼시 머지에서 살아남는 것은 **트레일러**다.
   `--no-commit` 후 트레일러를 붙여 커밋하거나 `git commit --amend`로 본문에 추가한다:
   `Co-authored-by: RHODIZ IT <조회한 이메일>` — 이메일은
   `gh api repos/lidge-jun/opencodex/pulls/3461/commits --jq '.[].commit.author'`로
   구현 시점에 조회한다. `privacy:scan`이 devlog를 읽으므로 여기에 평문으로 적지 않는다.
4. 이 브랜치의 PR에서 Cross-platform CI가 실제로 돌고 green인지 확인한다.
5. 머지 후 `git fetch origin dev && git merge-base --is-ancestor <merge-sha> FETCH_HEAD`.
6. `git log -1 --format=%B <merge-sha> | rg Co-authored-by` — 스쿼시 후 트레일러 생존 확인.
7. #3461은 `landed-via-maintainer` 라벨과 함께 close하고, 랜딩 SHA를 코멘트로 남긴다.

## Accept criteria

- 머지 SHA가 `origin/dev`의 조상이다.
- 스쿼시 커밋 본문에 `Co-authored-by: RHODIZ IT`가 남아 있다.
- 머지 후 `bun test tests/combos.test.ts`가 green (focused, 전체 스위트 아님).

## Activation scenario

새 분기 `isProviderTargetContextOverflow`는 조건 분기다. 발화 방법:
PR이 이미 넣은 e2e가 400 + 5059 + 정규식 일치 본문을 내는 가짜 업스트림을 세우고,
두 번째 타깃이 정확히 1회 히트(`backupHits === 1`)하며 200이 나오는 것을 관측한다.
반대로 코드 없는 generic 400은 hop하지 않고 stop한다는 것이 같은 테스트에서 단언된다.

## Verifier 사전 확인

| 커맨드 | exit | 변경 대상을 읽는가 |
|--------|------|--------------------|
| `bun test tests/combos.test.ts` | 0 (머지 전 dev 기준) | 예 — `src/combos/failover.ts`를 import |
| `gh pr checks 3461` | 0 | 예 — head `4e16f889b`의 체크 롤업 |
