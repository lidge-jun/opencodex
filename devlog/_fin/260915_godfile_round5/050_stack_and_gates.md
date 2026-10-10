# 050 스택 체인과 게이트 체크리스트

라운드5 는 브랜치 네 개를 수동으로 쌓아 origin/dev 로 접는다. 이 문서는 그 순서와,
각 PR 이 통과해야 하는 게이트, 그리고 분해 때문에 조용히 망가질 수 있는 검사 목록을 고정한다.
모든 수치는 aa91958e3b 시점에서 실측했다.

## 브랜치 체인

| 순서 | 브랜치 | base | 담는 작업 |
| --- | --- | --- | --- |
| a | codex/godfile-r5-a-openai-responses | origin/dev | wp1 로드맵 문서 + wp2 openai-responses.ts 분해 |
| b | codex/godfile-r5-b-bridge | a | wp3 bridge.ts 분해 |
| c | codex/godfile-r5-c-activation-guard | b | wp4 동기 activation 가드 전수 검사 |
| d | codex/godfile-r5-d-server-index | c | wp5 server/index.ts 분해 |

머지는 가장 깊은 자식부터 부모로 접는다. d -> c, c -> b, b -> a, 마지막에 a -> dev.
dev 기반은 a 하나뿐이므로 trunk 에 닿는 PR 도 a 하나다.

AGENTS.md 는 열린 PR 의 head 브랜치를 base 로 삼는 자식 PR 을 의도된 리뷰 방식으로 인정하고,
enforce-target 이 그런 자식에 대해 wrong-base 게이트를 건너뛴다고 적고 있다. 부모가 머지되거나
닫히면 자식을 dev 로 retarget 한다. 이 라운드는 자식을 부모로 접어 없애므로 retarget 이 필요 없다.

## PR 본문

.github/PULL_REQUEST_TEMPLATE.md 는 세 절을 요구한다: `## Summary`, `## Verification`, `## Checklist`.
enforce-target 이 비거나 얄팍하거나 형식이 깨진 설명을 거절하므로 네 PR 모두 세 절을 채운다.
제목이나 본문에 `gui` 가 들어가면 UI 스크린샷을 요구하므로 그 단어를 쓰지 않는다.

## PR 에 붙는 워크플로

`.github/workflows/` 15개 중 `pull_request` 를 트리거로 가진 것은 9개다.

| 파일 | name |
| --- | --- |
| ci.yml | Cross-platform CI |
| enforce-pr-target.yml | Enforce PR target branch |
| pr-hygiene.yml | PR hygiene |
| pr-labeler.yml | PR Labeler |
| react-doctor.yml | React Doctor |
| service-lifecycle.yml | Service lifecycle |
| enforce-issue-quality.yml | Enforce issue quality |
| issue-quality-tests.yml | Issue quality tests |
| issue-triage.yml | Issue Triage (Deduplicate) |

Cross-platform CI 가 Linux/Windows/macOS 에서 typecheck 와 전체 스위트를 돌린다. 로컬에는
node_modules 가 없어 스위트를 돌릴 수 없으므로, 판정은 정적 감사 + exact-head 호스티드 CI 로 한다.

## hygiene 게이트: missing_regression_test

`.github/scripts/pr-hygiene.cjs:155-159` 의 조건은 이렇다.

```
behaviorChanged && !testsChanged && !labelSet.has("test-exception-approved")
  -> failures.push({ code: "missing_regression_test" })
```

순수 리팩터는 `src/` 를 건드리면서 테스트를 안 건드리기 때문에 기본적으로 여기서 걸린다.
빠져나가는 길은 둘이다. 같은 PR 이 `tests/` 를 함께 수정하거나, `test-exception-approved` 라벨을 붙인다.

라운드5 는 네 PR 모두 `tests/` 를 실제로 건드리지만, 근거는 PR 마다 다르다. `TEST_PREFIXES` 는
`["tests/"]` 하나뿐이고 `isTestPath` 가 접두사 일치만 보므로(`.github/scripts/pr-hygiene.cjs:14,77-79`),
래칫 기준선 `tests/fixtures/file-size-baseline.json` 의 캡을 내리는 것만으로 `testsChanged` 가 참이 된다.
분해 PR 은 캡 갱신이 필수이므로 a·b·d 는 이 경로 하나로 게이트를 충족한다. c 는 가드 자체가
`tests/lab/core-lab-boundary.test.ts` 라 본체가 테스트 변경이고, d 는 추가로 오라클 8개를 재지정한다.
따라서 라벨은 쓰지 않는다. 필요해지면 `gh pr edit <n> --add-label test-exception-approved` 로 붙인다.

a 와 b 가 재지정할 텍스트 소스 오라클은 없다. 그 두 파일에는 애초에 텍스트 오라클이 없기 때문이고,
아래 목록이 그 근거다. 이 문서의 초안은 a·b 도 오라클을 재지정한다고 적었는데, 같은 문서의
"텍스트 오라클 0건" 결론과 모순이어서 독립 감사에서 지적받아 고쳤다.

## file-size ratchet

`scripts/file-size-ratchet.ts` 를 읽고 확인한 규칙이다.

- `THRESHOLD = 2000`. 기준선은 `tests/fixtures/file-size-baseline.json`, 현재 캡 45개.
- `evaluate()` 판정: 캡이 없는 새 파일이 2,000줄 이상이면 `NEW_OVERSIZED`, 캡보다 커지면 `GREW`.
  이 둘만 위반이다. `SHRANK` 와 `NEW_OK` 는 통과한다.
- `updateBaseline()` 은 `files[path] = Math.min(cap, lines)` 다. 캡은 내려가기만 하고 절대 올라가지 않는다.
  트리에서 사라진 경로는 캡에서 빠진다.
- 갱신 커맨드는 `bun run ratchet:update` (`bun scripts/file-size-ratchet.ts --update`).
- `--update` 는 기준선 파일이 **없을 때만** seed 모드로 새 2,000줄 이상 파일에 캡을 새로 심는다.
  기준선이 이미 있으면 새 파일에 캡을 추가하지 않는다. 즉 새 리프가 2,000줄을 넘으면 캡이 아니라
  `NEW_OVERSIZED` 로 떨어진다. 모든 리프를 2,000줄 아래로 잘라야 하는 실질적 이유가 이것이다.

대상 3파일의 현재 캡은 현재 줄 수와 정확히 같다.

```
"src/adapters/openai-responses.ts": 2627,
"src/bridge.ts": 2206,
"src/server/index.ts": 3400,
```

분해하면 세 줄 모두 새 값으로 내려가야 한다. 재시딩 시점은 각 브랜치의 구현 커밋 직전이 아니라
**직후**다. 구현 후 `bun run ratchet:update` 를 돌려 캡이 내려간 것만 확인하고, 최종적으로 a 를 dev 로
접기 전에 머지된 트리에서 한 번 더 돌린다. dev 가 그 사이 움직였으면 다른 파일의 캡도 같이 내려갈 수 있다.

## 소스 오라클 재지정 목록

이게 이 문서의 핵심이다. `tests/` 의 일부 테스트는 소스 파일을 **텍스트로 읽어** 문자열을 찾는다.
내용이 다른 파일로 옮겨가면 그 검사는 실패하지 않고 조용히 아무것도 검사하지 않게 된다.

### src/server/index.ts 를 텍스트로 읽는 오라클 (wp5 의 실질 작업량)

| 파일:라인 | 읽는 방식 | 분해 후 위험 |
| --- | --- | --- |
| tests/lib/workflow-budget.test.ts:474 | `Bun.file(repoPath("src/server/index.ts")).text()` | 찾는 패턴이 fetch 핸들러 안이면 vacuous |
| tests/windows/windows-deploy-close-regressions.test.ts:81 | `read("src/server/index.ts")` | 같음 |
| tests/codex-integration/codex-retained-root-serialization.test.ts:295 | `readFileSync(join(repoRoot, "src/server/index.ts"))` | 같음. 267행은 동적 import 라 무해 |
| tests/responses/ws-endpoint.test.ts:40 | `readFileSync(new URL("../../src/server/index.ts"))` | WS 라우트 등록이 fetch 핸들러 안 -> 거의 확실히 vacuous |
| tests/server/loopback-listener-admission.test.ts:64, 92 | 같은 방식 2회 | loopback admission 이 fetch 핸들러 안 -> vacuous |
| tests/codex-integration/model-visibility-management-api.test.ts:72 | `Bun.file(new URL("../../src/server/index.ts")).text()` | 관리 API 라우트가 fetch 핸들러 안 -> vacuous |
| tests/lab/core-lab-boundary.test.ts:354 | `resolve(repoRoot, "src/server/index.ts")` | 동기 창(3222-3399)은 파사드 잔류라 유지. wp4 에서 같이 손댄다 |
| tests/usage/quota-reset-core-boundary.test.ts:80-82 | import 그래프 체인 단언 | 체인 문자열 `src/server/index.ts -> src/server/background-lifecycle.ts -> src/quota/reset-poller.ts` 가 리프 경유로 바뀌면 깨진다 |

규칙: 옮긴 코드를 검사하던 오라클은 **같은 커밋에서** 새 리프 경로로 재지정한다. 단언 문자열 자체는
바꾸지 않는다. 읽는 파일만 바꾼다. 문자열까지 바꾸면 검사 내용이 달라져 순수 이동이 아니게 된다.
한 오라클이 두 리프에 걸친 내용을 찾으면 두 파일을 읽어 이어 붙인다 (라운드3 에서 codex-inject-history-wording 에 쓴 방법).

### src/bridge.ts 와 src/adapters/openai-responses.ts

`rg -n 'src/bridge\.ts|adapters/openai-responses\.ts' tests/` 결과에서 텍스트 오라클은 **하나도 없다**.
나온 것은 주석 참조 2건(responses-undeclared-tool-guard.test.ts:5,
routing-compatibility-model-matching.test.ts:146)과 ratchet 기준선 2행뿐이다. 초안은 여기에
responses-forward-incomplete-quota.test.ts:202 를 포함했는데 그 줄은 "the bridge inspects" 라는
산문일 뿐 이 패턴에 매칭되지 않아 독립 감사에서 제외됐다. 주석은 게이트가 아니므로
라인 번호가 낡아도 red 가 되지 않는다. 그래도 :146 은 `src/adapters/openai-responses.ts:1001` 이라는
구체적 라인을 인용하므로 분해 후 실제 위치로 고친다.

이 차이가 라운드5 의 위험 분포를 설명한다. wp2 와 wp3 은 오라클 위험이 없고, wp5 가 전부 진다.

## structure/ SSOT

`bun run structure:check` (`bun scripts/structure-ssot.ts`) 가 게이트다. 이 트리에서 실행 가능하다.
문서가 이름을 대는 경로가 트리에 없으면 실패하고, 주인 없는 새 `src/` 영역이 생기면 실패한다.
`structure/manifest.json:390-391` 에 `src/bridge.ts` grace 항목이 있다.

```
"path": "src/bridge.ts",
"reason": "no doc names this file; it is the legacy adapter bridge entry and its behavior is described under the adapter registry without a path reference"
```

`src/bridge/` 리프가 생기면 이 grace 를 리프 경로로 확장하거나 소유 문서를 지정해야 한다.
`bun run structure:index` 로 `structure/INDEX.md` 를 재생성한다.

## dev 통합 기록 의무

MAINTAINERS.md:59-64 가 정한다. `maintain` 또는 `admin` 권한 메인테이너는 다른 메인테이너 승인 없이
자기 PR 을 포함해 `dev` 에 통합할 수 있지만, **그 선택과 exact-head 검증을 PR 설명이나 코멘트에 기록**해야 한다.
이건 self-approval 이 아니라 maintainer integration 이고, 기술 리뷰·귀속·문서·보안 리뷰 의무는 그대로다.
같은 절은 이 예외가 `dev` 에만 적용되며 direct push, force-push, 브랜치 삭제를 허용하지 않는다고 못 박는다.

따라서 각 PR 을 접기 전에 (1) 머지 대상 head SHA, (2) 그 SHA 에서 돌아간 CI run 링크와 결론,
(3) maintainer integration 을 선택한 사실을 코멘트로 남긴다. 이 순서를 지키지 않은 머지는 정책 위반이다.

## 로컬에서 돌 수 있는 것과 못 돌리는 것

이 워크트리에는 `node_modules` 가 없고 `bun install` 은 하지 않는다. 그래서:

- 돈다: `bun scripts/structure-ssot.ts`, `bun scripts/file-size-ratchet.ts`, 의존성 없는 개별 `bun test <file>`.
- 안 돈다: 전체 스위트, `bun run typecheck`, `bun run build:gui`.
- 대체 수단: `bun x tsc --noEmit` 을 개별 파일에 걸고 노이즈 코드를 걸러 본다. 실제 오류로 취급할 것은
  TS2304/2305/2459/2724 (전역 이름 process/Buffer/NodeJS/Bun 제외)와, 상대 지정자에 대한 TS2307 뿐이다.
  라운드3 에서 서브에이전트 하나가 자기 검증 스크립트에서 TS2307 을 노이즈로 제외해 실제 미해결 import 를
  숨겼다. 그 필터를 서브에이전트가 정하게 두지 않는다.

## 이 라운드가 쓴 기계 검증 (재현 절차)

분해를 손으로 하지 않았다. `.tmp/r5/` (gitignore 대상, 보안 노트가 아닌 순수 스크래치) 에 도구 여섯 개를
두고 돌렸다. `.tmp/` 는 휘발성이므로 다음 라운드가 다시 만들 수 있도록 각 도구가 무엇을 증명하는지 적는다.

| 도구 | 증명하는 것 |
| --- | --- |
| `spans.ts <file> <from>` | 최상위 선언마다 선행 주석을 흡수한 라인 스팬을 산출한다. 스팬 합계와 파일 줄 수의 차이가 전부 빈 줄이어야 한다 |
| `gen-spec.ts` | 심볼 -> 리프 매핑 표를 받아 split spec 을 생성한다. 매핑에 없는 심볼이 하나라도 있으면 실패하므로 계약서 누락이 드러난다 |
| `verify-spans.ts <file> <spec>` | 주석·문자열을 지운 뒤 각 이동 범위의 괄호 깊이가 0 에서 시작해 0 으로 끝나고 중간에 음수가 되지 않음을 확인한다 |
| `split.ts <spec> [--apply]` | 라인 범위를 통째로 옮기고, 원본 import 를 리프 깊이에 맞게 `./x -> ../x`, `../y -> ../../y` 로 바꾸고, 리프에서 안 쓰는 import 를 잘라내고, 리프 간 참조 심볼에 `export` 를 붙이고, 리프 사이 순환을 검출하고, 파사드 재노출을 생성한다 |
| `audit-imports.ts` | `src` 와 `gui/src` 전체에서 상대 지정자를 뽑아 실제 해석 여부를 확인한다. 기준선 대비 새 미해결이 생기면 실패한다 |
| `verify-surface.ts <paths...>` | `Bun.Transpiler().scan().exports` 로 파사드 export 집합을 `git show origin/dev:<path>` 기준과 비교한다 |

`verify-spans.ts` 가 vacuous 하지 않다는 증거는 이 라운드 안에 있다. 040 초안이 route-guards 리프 범위를
`1191-1329` 로 적었는데 `runAdmittedHttpTurn` 의 닫는 중괄호는 1330 이다. 검증기는 그 범위를
`INCOMPLETE ... 끝깊이=1` 로 거부하고 정정된 `1191-1330` 을 통과시켰다. 사람이 표를 읽어서는 잡기 어려운
유형이고, 그대로 옮겼으면 함수의 닫는 `}` 가 잘린 채 커밋됐다.

기준선 수치: `audit-imports.ts` 는 aa91958e3b 에서 상대 지정자 8,285개를 검사해 미해결 2건을 낸다. 둘 다
기존 상태다. 하나는 정규식 오탐(`src/adapters/cursor/protobuf-events.ts:665` 의 문자열 조각), 하나는 실제
미해결(`src/adapters/devin/cloud-direct/index.ts:29 -> ./cloud-direct/index.js`)이고 이 라운드 범위 밖이다.
