# 010 — PR 처분과 머지 실행 순서

> 증거 스냅샷: `2026-07-25T01:10:40Z` (UTC)  
> 기준 브랜치/커밋: `dev` = `3fac781f`  
> 처분 정의, 전순서 first-match 규칙, 증거 행 스키마, C1–C6는 `000_plan.md`를 따른다.  
> 이 문서는 PR 쪽 절반만 다룬다. Issue 쪽 절반은 `020_issues.md`에 있다.

축 1은 각 항목의 배타적 주 처분이다. 축 2의 사용자 요청 6개 보기는 축 1에서 파생한다. 이 문서에서는 보기 2의 Wibias 완료선언 5건, 보기 4의 스냅샷 `REBUILD_ON_DEV` 7건과 최신 8건, PR 리뷰 큐를 다룬다. Issue 전체 처분과 보기 3·5·6의 Issue 항목은 `020_issues.md`가 맡는다.

## 스냅샷 이후 상태 변화

아래 변화는 `2026-07-25T01:10:40Z` 스냅샷이 잘못됐다는 뜻이 아니라, 시각을 고정한 분석 뒤 GitHub 상태가 정상적으로 이동한 결과다. 원래 head·CI·처분은 다음 표와 각 상세 행에 남기고, 후속 시점의 처분만 명시적으로 덮어쓴다.

| PR | `01:10:40Z` 원래 스냅샷 | `01:35Z` 검증 델타 | `01:40Z` 재확인 (`01:46Z` 동일) 및 최신 추가 델타 |
|---|---|---|---|
| #402 | head `c7908f9ab1`, Windows 취소로 CI 대기 | `windows-latest`가 `01:29:26Z` 성공, `01:32:12Z` 머지, merge SHA `6f4cd1d6bf`; `ALREADY_MERGED` | 동일 |
| #430 | head `8704ab7bd3`, 3플랫폼 작업 진행 중으로 CI 대기 | `MERGEABLE/CLEAN`, 세 플랫폼 모두 성공(`windows-latest` `01:18:01Z` 완료); `AWAIT_REVIEW` | 동일 |
| #428 | head `2161fbcbb3`, 3플랫폼 GUI lint 실패로 `AWAIT_FIX` | `01:27:54Z`, `01:29:55Z` 새 커밋; head `5ff127f3f5`, `MERGEABLE/UNSTABLE`, Windows 진행 중으로 `AWAIT_CI` | `01:40Z`: run `30138616581`의 세 플랫폼이 모두 성공해 `MERGEABLE/CLEAN`; 사람 리뷰가 없어 `AWAIT_REVIEW` → `02:01Z`: head `e691b76efd`, `MERGEABLE/UNSTABLE`; run `30139502262`의 Ubuntu/macOS 성공, Windows 진행 중이므로 `AWAIT_CI` |
| #429 | head `f408f3485d`, 필수 CI 미실행으로 CI 대기 | `UNKNOWN/UNKNOWN`; #402 머지 뒤 GitHub 재계산 중이며 rebase 필요가 확정됨 | `CONFLICTING/DIRTY`; 전순서에 따라 `REBUILD_ON_DEV` |
| #406 #407 #409 #410 #411 #413 | non-draft, `CONFLICTING/DIRTY`; `REBUILD_ON_DEV` | 각각 `01:19:43Z`, `01:20:03Z`, `01:20:11Z`, `01:14:58Z`, `01:15:35Z`, `01:15:50Z`에 draft 전환; 처분은 그대로 | draft 상태 유지. 전환은 기여자가 재구축 요청에 대응 중일 수 있다는 신호지만, 새 head나 rebase 증거는 아님 |

`#428`의 중간 head `5ff127f3f5`는 원래 head `2161fbcbb3`의 `react-hooks/set-state-in-effect` 두 오류를 그대로 이어받았다고 볼 수 없다. `01:40Z` 재확인에서 run `30138616581`의 exact-head 필수 CI는 모두 성공했지만, 이 문서는 diff와 lint 로그로 두 위치의 수정 방식을 별도 검토하지 않았으므로 “같은 오류를 고쳤다”고 단정하지 않는다. 이후 head `e691b76efd`가 푸시되어 run `30139502262`가 다시 진행 중이다. `#402` 머지로 스냅샷 매니페스트의 open PR 수는 23에서 **22**로 줄었다.

인벤토리 스냅샷 `2026-07-25T01:05:24Z` 뒤 열린 `#431`은 author `H-H-E`, createdAt `2026-07-25T01:52:42Z`다. `createdAt > snapshot` 배제 규칙에 따라 이 유닛 범위 밖이며 다음 사이클 인벤토리에 넣는다.

## 상시 상태 drift 정책

모든 처분은 `(스냅샷 시점의 상태, 전순서 우선순위)`의 함수다. 인벤토리 스냅샷 시점 `2026-07-25T01:05:24Z`는 고정되지만 live 상태는 고정되지 않는다. 따라서 live 상태와 더는 일치하지 않는 처분은 전순서를 다시 적용했을 때 올바른 답이 나오기만 하면 분석 오류가 아니라 **drift**다.

실행 직전 volatile 행은 PR마다 `gh pr view <n> --json isDraft,mergeable,mergeStateStatus,reviewDecision`와 `gh pr checks <n>`를 새로 실행하고 전순서의 first-match를 다시 적용한다. 이는 PR당 한 번의 상태 새로고침이지 코드 재분석이 아니다. `AWAIT_CI`, `AWAIT_FIX`, `AWAIT_REVIEW`는 push나 CI 완료 한 번으로 뒤집히는 **volatile** 처분이므로 행동 전에 반드시 재확인한다. `REBUILD_ON_DEV`, `AWAIT_AUTHOR`, `UPSTREAM_TRACKING`, `ROADMAP`, `DEFER`는 사람의 결정이나 상당한 작업 없이는 바뀌지 않는 **stable** 처분이므로 며칠간 실행 기준으로 신뢰할 수 있다.

스냅샷 뒤 생성된 항목은 상태 새로고침 대상이 아니라 규칙상 범위 밖이며 다음 사이클로 넘긴다. 현재 예시는 `#431`이다.

## 축 1 — 스냅샷 매니페스트 PR 처분 (23건: 현재 open 22 + 이후 머지 #402 1)

상태 수치는 `2026-07-25T01:10:40Z`, base `3fac781f` 스냅샷을 보존한다. 화살표 뒤 값과 처분 열은 위 델타를 반영한 최신값이다. `#402`는 스냅샷 매니페스트 구성원이므로 이 표에서 한 번 세되, 머지 뒤 상세 7필드 행은 비축 1 부록으로 옮긴다.

| PR | author | head | draft | mergeable | review | checks(p/f/pend) | 3-platform CI | 처분 |
|---|---|---|---:|---|---|---:|---|---|
| #430 | snowyukitty | `8704ab7bd3` | false | MERGEABLE/UNSTABLE → CLEAN | none | 5/0/5 | all three IN_PROGRESS → SUCCESS | `AWAIT_REVIEW` |
| #429 | Aciredy | `f408f3485d` | false | MERGEABLE/UNSTABLE → CONFLICTING/DIRTY | none | 3/0/0 | CI_NOT_RUN | `REBUILD_ON_DEV` |
| #428 | Wibias | `2161fbcbb3` → `5ff127f3f5` → `e691b76efd` | false | MERGEABLE/UNSTABLE → CLEAN → UNSTABLE | none | 7/3/0 → 8/0/0 → 8/0/2 | all three FAILURE → SUCCESS → Ubuntu/macOS SUCCESS, Windows IN_PROGRESS | `AWAIT_CI` |
| #427 | dev-shinyu | `e43c59f4e5` | false | MERGEABLE/UNSTABLE | none | 2/0/0 | CI_NOT_RUN | `AWAIT_CI` |
| #426 | chrisae9 | `4a0558ce88` | true | MERGEABLE/UNSTABLE | none | 3/0/0 | CI_NOT_RUN | `AWAIT_VALIDATION` |
| #424 | tizerluo | `d4b9ac59f4` | false | MERGEABLE/UNSTABLE | none | 3/0/0 | CI_NOT_RUN | `REBUILD_ON_DEV` |
| #413 | HaydernCenterpoint | `23c47671bf` | false → true | CONFLICTING/DIRTY | none | 10/0/0 | all SUCCESS | `REBUILD_ON_DEV` |
| #411 | HaydernCenterpoint | `d01b164940` | false → true | CONFLICTING/DIRTY | none | 10/0/0 | all SUCCESS | `REBUILD_ON_DEV` |
| #410 | HaydernCenterpoint | `ea98e44077` | false → true | CONFLICTING/DIRTY | none | 10/0/0 | all SUCCESS | `REBUILD_ON_DEV` |
| #409 | HaydernCenterpoint | `1acca4cb2a` | false → true | CONFLICTING/DIRTY | none | 4/6/0 | all three FAILURE | `REBUILD_ON_DEV` |
| #408 | Wibias | `a816f6f367` | false | MERGEABLE/CLEAN | none | 12/0/0 | all SUCCESS | `AWAIT_REVIEW` |
| #407 | HaydernCenterpoint | `60046f85af` | false → true | CONFLICTING/DIRTY | none | 10/0/0 | all SUCCESS | `REBUILD_ON_DEV` |
| #406 | HaydernCenterpoint | `c42716deea` | false → true | CONFLICTING/DIRTY | none | 9/0/1 | windows CANCELLED | `REBUILD_ON_DEV` |
| #405 | HaydernCenterpoint | `a70e0cc4d7` | false | MERGEABLE/CLEAN | none | 10/0/0 | all SUCCESS | `AWAIT_REVIEW` |
| #403 | lidge-jun | `fcd3d682ee` | false | MERGEABLE/CLEAN | none | 17/0/0 | all SUCCESS | `AWAIT_REVIEW` |
| #402 | Wibias | `c7908f9ab1` | false | MERGEABLE/UNSTABLE → UNKNOWN/UNKNOWN | none | 8/0/1 → 9/0/0 | windows CANCELLED → SUCCESS | `ALREADY_MERGED` |
| #392 | Wibias | `9a0e695a8e` | false | MERGEABLE/CLEAN | CHANGES_REQUESTED | 9/0/0 | all SUCCESS | `AWAIT_AUTHOR` |
| #391 | Wibias | `a39261fb01` | false | MERGEABLE/UNSTABLE | CHANGES_REQUESTED | 6/3/0 | all three FAILURE | `AWAIT_AUTHOR` |
| #389 | csa906 | `1e1fa59808` | false | MERGEABLE/UNSTABLE | CHANGES_REQUESTED | 3/0/0 | CI_NOT_RUN | `AWAIT_AUTHOR` |
| #385 | latemonk | `ac0260b7af` | false | MERGEABLE/UNSTABLE | none | 3/0/0 | CI_NOT_RUN | `AWAIT_CI` |
| #376 | HaydernCenterpoint | `01466a7714` | false | MERGEABLE/CLEAN | CHANGES_REQUESTED | 10/0/0 | all SUCCESS | `AWAIT_AUTHOR` |
| #370 | duansy123 | `ed7147faf6` | false | MERGEABLE/CLEAN | CHANGES_REQUESTED | 10/0/0 | all SUCCESS | `AWAIT_AUTHOR` |
| #355 | tizerluo | `1700fa3ffe` | false | MERGEABLE/UNSTABLE | none | 2/0/0 | CI_NOT_RUN | `AWAIT_CI` |

최신 처분 집계는 `AWAIT_AUTHOR` 5 + `REBUILD_ON_DEV` 8 + `AWAIT_CI` 4 + `AWAIT_VALIDATION` 1 + `AWAIT_REVIEW` 4 + `ALREADY_MERGED` 1 = **23**이다. 이 가운데 `ALREADY_MERGED`인 `#402`를 빼면 스냅샷 매니페스트의 현재 open PR은 **22**다. `AWAIT_FIX`, `MERGE`, `MERGE_AFTER_FIX`, `DEFER`, `ROADMAP`, `CLOSE_MENTION`에 배치된 open PR은 없다. 스냅샷 뒤 생성된 `#431`은 이 산술에 더하지 않는다.

### `AWAIT_AUTHOR` — 5건

#### #391

- author: `Wibias`
- head SHA: `a39261fb01`
- mergeable/mergeStateStatus: `MERGEABLE/UNSTABLE`
- reviewDecision: `CHANGES_REQUESTED`
- check pass/fail/pending: `6/3/0`
- 변경 파일 수: `9`
- 증거: run `30119868825`; `tests/subagent-model-fallback.test.ts:96:28`; `src/codex/subagent-model-fallback.ts:156-165`; `src/codex/subagent-model-fallback.ts:97-105`; `src/server/responses/core.ts:1325-1341`; `src/server/management/agent-settings-routes.ts:312-341`

`CHANGES_REQUESTED`가 가장 먼저 맞으므로 주 처분은 `AWAIT_AUTHOR`다. 리뷰는 `2026-07-24T07:02:01Z`, 최신 커밋은 `2026-07-24T19:11:51Z`라 작성자가 뒤에 푸시했지만 재리뷰와 red CI 해소가 남았다.

세 플랫폼에서 같은 세 테스트가 실패한다. 대표 실패는 `tests/subagent-model-fallback.test.ts:96:28`의 `expect(selected.model).toBe("kimi/k3")`가 `"gpt-5.6-sol"`을 받은 것이다. 구현은 `src/codex/subagent-model-fallback.ts:156-165`에서 건강한 primary를 먼저 돌려주는 정상 경로다. 테스트는 line 94에서 Alibaba만 unavailable로 만들고 primary를 소진하지 않았다. 같은 설정 결함이 lines 100-115와 223-238에도 있다. 각 케이스에 `updateAccountQuota("main", 95, undefined, 20)`를 넣는 것이 최소 수정이다. 따라서 실패 원인은 구현 무능이 아니라 defective test setup이다.

별도 설계 쟁점은 남는다. `src/codex/subagent-model-fallback.ts:97-105`는 slash가 든 후보의 접두사가 설정된 제공자가 아니면 모두 허용한다. 이 규칙만으로 `anthropic/claude-sonnet-4-6`을 허용하면서 `missing-provider/does-not-exist`를 거부할 수 없다. GitHub review thread는 총 29개이며 그중 23개가 미해결이다. 여기에는 이름이 붙은 두 설계 blocker, 즉 `src/server/responses/core.ts:1325-1341`의 default-tee SSE `response.failed` 기록과 `src/server/management/agent-settings-routes.ts:312-341`의 atomic validation이 포함된다.

#### #392

- author: `Wibias`
- head SHA: `9a0e695a8e`
- mergeable/mergeStateStatus: `MERGEABLE/CLEAN`
- reviewDecision: `CHANGES_REQUESTED`
- check pass/fail/pending: `9/0/0`
- 변경 파일 수: `11`
- 증거: `src/server/management/oauth-account-routes.ts:274-280`; `gui/src/pages/ApiKeys.tsx:226-255`; `gui/src/pages/ApiKeys.tsx:474-497`; `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS

`CHANGES_REQUESTED`가 `AWAIT_REVIEW`보다 먼저 맞아 `AWAIT_AUTHOR`다. 리뷰 `2026-07-24T07:02:00Z` 뒤 최신 커밋 `2026-07-24T19:03:14Z`가 있어 TS2783 blocker는 `src/server/management/oauth-account-routes.ts:274-280`에서 고쳐졌다. 다만 재리뷰가 필요하다.

`gui/src/pages/ApiKeys.tsx:474-497`은 `/v1/messages`를 lines 474-484에서 무조건 렌더링하고 lines 485-497에서 조건부로 다시 렌더링한다. disabled mode에서는 403 endpoint를 광고하고 enabled mode에서는 중복한다. lines 474-484를 지우면 된다. `gui/src/pages/ApiKeys.tsx:226-255`의 test button은 `x-opencodex-api-key`를 보내지 않아 non-loopback에서 401이 난다. 사용자 동작이 바뀌었지만 `docs-site/` 갱신도 없다.

#### #389

- author: `csa906`
- head SHA: `1e1fa59808`
- mergeable/mergeStateStatus: `MERGEABLE/UNSTABLE`
- reviewDecision: `CHANGES_REQUESTED`
- check pass/fail/pending: `3/0/0`
- 변경 파일 수: `15`
- 증거: 리뷰 `2026-07-24T07:02:04Z`; 최신 커밋 `2026-07-24T12:18:43Z`; 필수 job `ubuntu-latest`, `macos-latest`, `windows-latest`는 `CI_NOT_RUN`

요청된 기술 변경은 모두 해결됐다. Ingwannu가 요구한 physical combo provider 일관 분류는 `src/server/management/model-routes.ts:146-149`의 공용 `preservesPhysicalComboProvider(config)` 호출로 바뀌어 `src/router.ts:237-245`와 `src/combos/types.ts:13-18`의 기준을 공유하고, `tests/model-visibility-management-api.test.ts:120-164`가 회귀를 잡는다. canonical/public combo selector는 `src/server/management/model-routes.ts:171-176`에서 모아 cleanup의 `:191-205`까지 보존하며, `tests/model-visibility-management-api.test.ts:166-202`가 `anthropic/fast`를 검증한다. stale native ID는 `src/server/management/model-routes.ts:198-204`의 `disabledNativeSlugs()`로 거르고 `tests/model-visibility-management-api.test.ts:96-118`이 이를 검증한다. CodeRabbit도 fixture 이의를 “The expected result is correct; no fixture adjustment is needed”라며 철회했다.

남은 blocker는 기술이 아니라 절차다. 작성자 푸시 뒤에도 stale `CHANGES_REQUESTED`가 남았고 메인테이너 승인이 없으며, 보고된 check는 `enforce-target`, `label`, `CodeRabbit`뿐이라 필수 3플랫폼 CI가 없다. head는 `dev@3fac781f`보다 12 commits 뒤다. owner가 이미 “Could you rebase on `dev` and push to re-trigger the full matrix? Once it's green I'll merge. Content-wise this is MERGE_READY.”라고 안내했다. first-match는 계속 `AWAIT_AUTHOR`이며, 작성자는 `dev` rebase와 full matrix 재실행으로 절차 상태를 갱신해야 한다.

#### #376

- author: `HaydernCenterpoint`
- head SHA: `01466a7714`
- mergeable/mergeStateStatus: `MERGEABLE/CLEAN`
- reviewDecision: `CHANGES_REQUESTED`
- check pass/fail/pending: `10/0/0`
- 변경 파일 수: `8`
- 증거: 리뷰 `2026-07-24T07:02:06Z`; 최신 커밋 `2026-07-24T04:28:11Z`; `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS

최신 커밋이 변경요청보다 앞서므로 review freshness상 작성자 후속 푸시가 없다. green CI보다 `CHANGES_REQUESTED`가 먼저 맞아 `AWAIT_AUTHOR`다.

#### #370

- author: `duansy123`
- head SHA: `ed7147faf6`
- mergeable/mergeStateStatus: `MERGEABLE/CLEAN`
- reviewDecision: `CHANGES_REQUESTED`
- check pass/fail/pending: `10/0/0`
- 변경 파일 수: `5`
- 증거: 리뷰 `2026-07-24T07:02:07Z`; 최신 커밋 `2026-07-24T16:03:19Z`; `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS

리뷰 뒤 푸시는 확인되지만 변경요청 상태가 남아 재리뷰가 필요하다. first-match는 `AWAIT_AUTHOR`다.

### `REBUILD_ON_DEV` — 8건

HaydernCenterpoint 스택 여섯 건은 CI나 기능 가치보다 `CONFLICTING/DIRTY`가 먼저 맞는다. `#424`는 충돌 상태가 아니지만 독립 심층 리뷰에서 단순 CI 대기보다 앞서는 재구축 blocker가 확인됐다. 모두 `dev@3fac781f`와 선행 변경의 canonical API 위에 고유 변경만 다시 잘라야 한다.

`01:40Z` 델타로 `#429`가 추가되어 최신 집계는 8건이다.

#### #429

- author: `Aciredy`
- head SHA: `f408f3485d`
- mergeable/mergeStateStatus: 원래 `MERGEABLE/UNSTABLE`; `01:35Z` `UNKNOWN/UNKNOWN`; `01:40Z` `CONFLICTING/DIRTY`
- reviewDecision: `none`
- check pass/fail/pending: `3/0/0`
- 변경 파일 수: `5`
- 증거: `src/adapters/cursor/tool-definitions.ts`; `src/adapters/cursor/protobuf-events.ts`; `tests/cursor-blob.test.ts`; 필수 3플랫폼 작업 `CI_NOT_RUN`; 선행 PR #402 merge SHA `6f4cd1d6bf`

#402가 머지되기 전에는 두 PR의 반대 방향 변경을 직렬화해야 한다는 조건부 요구였지만, 이제 rebase 요구가 확정됐다. `#429`는 `appendCursorShellAliasHint()`를 지우고 #402는 이를 유지·확장했으므로, #402의 alias normalization과 system-prompt guidance를 보존하면서 user/developer prompt mutation만 제거하도록 현재 `dev` 위에 다시 맞춰야 한다. `CONFLICTING/DIRTY`가 CI 부재보다 먼저 매칭되므로 최신 처분은 `REBUILD_ON_DEV`다.

#### #424

- author: `tizerluo`
- head SHA: `d4b9ac59f4`
- mergeable/mergeStateStatus: `MERGEABLE/UNSTABLE`
- reviewDecision: `none`
- check pass/fail/pending: `3/0/0`
- 변경 파일 수: `17`
- 증거: 필수 3플랫폼 job `CI_NOT_RUN`; `src/responses/parser.ts:276-285,538-555,583-601`; `src/images/artifacts.ts:47-138`; `src/images/plan.ts:24-44`; `src/images/loop.ts:362-370`; `src/server/responses/core.ts:1303-1400,1452-1478`

CI 부재보다 다음 다섯 blocker가 더 높은 우선순위의 재구축 근거다.

- **High — Responses Lite image tools 누락:** `additional_tools`는 `src/responses/parser.ts:276-285`에서 수집돼 routed-model tools에 `src/responses/parser.ts:538-555`에서 합쳐지지만, image detection은 `src/responses/parser.ts:583-601`의 `data.tools`만 본다. Responses Lite의 flat `image_gen`은 `_imageGeneration`을 설정하지 못하고 `src/images/plan.ts:31-44`의 `planImageBridge()`가 `undefined`를 반환해 ordinary routed path로 조용히 빠진다. 합쳐진 top-level + loaded tool specs를 `extractHostedImageGeneration()`에 넘기고 Lite shape의 `parseRequest` 회귀 테스트를 추가해야 한다.
- **High / SECURITY — provider-returned URL SSRF:** `downloadImageToArtifact()`는 `src/images/artifacts.ts:88-100`에서 `fetch(url)`을 직접 호출하고 기본 redirect를 따르며, 응답을 `src/images/artifacts.ts:102-137`에서 저장한다. 악성 또는 침해된 image response가 loopback, private, link-local, cloud metadata endpoint에 닿을 수 있다. HTTP(S)만 허용하고 연결 전 public-address 검증을 적용하며 redirect마다 거부 또는 재검증해야 한다. private-IP와 redirect 회귀 테스트가 필요하고, AGENTS.md에 따라 명시적 security review가 필수다.
- **High — `adapter.runTurn` provider bridge 우회:** `src/server/responses/core.ts:1303-1400`의 `runTurn` branch가 streaming과 non-streaming 모두 먼저 반환하고 image planning은 `src/server/responses/core.ts:1452-1478`에서 뒤늦게 실행된다. 해당 non-OpenAI adapter는 bridge뿐 아니라 문서화된 `stream:false` 거부에도 닿지 않는다. early return 전에 bridge 여부를 정하거나 지원 adapter를 코드와 문서에서 명시적으로 제한해야 한다.
- **Medium — OAuth refresh 미지원:** configured key는 `src/images/plan.ts:24-26`의 `resolveEnvValue(provider.apiKey)`로 풀지만 fallback은 `src/images/plan.ts:27-29`에서 `getCredential("xai").access`를 직접 읽는다. `docs-site/src/content/docs/guides/image-bridge.md:15-18`의 “automatically refreshed bearer token” 설명과 맞지 않는다.
- **Medium — handler/parser 통합 검증 부재:** parser → routing → synthetic tool → xAI fulfillment, web-search precedence, `stream:false`, `runTurn` 동작을 잇는 테스트가 없다.

`#424↔#355`는 서로 다른 API 설계가 아니다. 둘 다 `ImageBudget`, `createImageBudget()`, `materializeInlineImage(mimeType, base64Data, budget?)`를 export한다. `#424`가 `src/images/artifacts.ts:47-138`에서 magic-byte detection과 `downloadImageToArtifact()`를 확장한 add/add 충돌이며, 차이는 extension semantics다. `#355`는 filename에 declared MIME을 신뢰하고 `#424`는 `src/images/artifacts.ts:47-53,81-84`에서 decoded bytes를 sniff한다. canonical 해법은 `#355`의 consumer/test를 유지하면서 `#424`의 더 강한 magic-byte 및 bounded-download 동작을 채택한 단일 `src/images/artifacts.ts`다. `#424`는 병렬 사본을 싣지 말고 이 모듈을 소비해야 한다.

또한 `runWithImageBridge()`는 `src/images/loop.ts:362-370`에서 `onUsage` seam 없이 `bridgeToResponsesSSE()`를 호출한다. `#403` 뒤에 그대로 랜딩하면 image-bridge turn의 usage provenance가 퇴행한다. `#403`의 callback 계약에 맞춘 `onUsage` seam도 재구축 범위에 포함한다.

#### #406

- author: `HaydernCenterpoint`
- head SHA: `c42716deea`
- mergeable/mergeStateStatus: `CONFLICTING/DIRTY`
- reviewDecision: `none`
- check pass/fail/pending: `9/0/1`
- 변경 파일 수: `11`
- 증거: `windows-latest` CANCELLED; 고유 범위는 provider fetch/discovery와 테스트 파일 7개; ancestry `#405 a70e0cc4` → `#406 c42716de`; `draft=true` 전환 `2026-07-25T01:19:43Z`

provider fetch/discovery와 테스트 파일 7개가 고유 가치다. 취소된 Windows 작업보다 충돌 해소가 먼저라 `REBUILD_ON_DEV`다. draft 전환은 기여자가 재구축 요청에 대응 중일 수 있다는 신호지만, 새 head가 없으므로 처분은 바뀌지 않는다. 재커팅 뒤 exact-head 3플랫폼 CI를 다시 돌린다.

#### #407

- author: `HaydernCenterpoint`
- head SHA: `60046f85af`
- mergeable/mergeStateStatus: `CONFLICTING/DIRTY`
- reviewDecision: `none`
- check pass/fail/pending: `10/0/0`
- 변경 파일 수: `24`
- 증거: `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS; 고유 범위는 `gui/src/components/AddProviderModal.tsx`와 model-loader UI; ancestry `#406 c42716de` → `#407 60046f85`; `draft=true` 전환 `2026-07-25T01:20:03Z`

Add Provider/model-loader UI만 `dev` 위에 재커팅한다. draft 전환 뒤에도 head는 같으므로 현재 성공한 CI는 오래된 stacked head의 증거일 뿐 재커팅된 SHA의 CI를 대신하지 못한다.

#### #409

- author: `HaydernCenterpoint`
- head SHA: `1acca4cb2a`
- mergeable/mergeStateStatus: `CONFLICTING/DIRTY`
- reviewDecision: `none`
- check pass/fail/pending: `4/6/0`
- 변경 파일 수: `30`
- 증거: GUI build TS2345; `gui/src/pages/Models.tsx:157,717-724,737-738`; `gui/src/i18n/{de,en,ja,ko,ru,zh}.ts`; `gui/tests/error-boundary.test.tsx:38`; 고유 범위 `src/combos/smart-routing.ts`와 combo API/UI; `draft=true` 전환 `2026-07-25T01:20:11Z`

고유 기능은 smart-routing core와 combo API/UI다. 누락된 i18n key는 12개다. static key는 `models.smartRoutingApplied`, `models.smartRoutingFailed`, `models.smartRoutingTitle`, `models.smartRoutingHint`, `models.smartRoutingApplying`, `models.smartRoutingApply`이고, dynamic key는 `models.smartRouting_intelligence`, `models.smartRouting_balance`, `models.smartRouting_cost`, `models.smartRouting_intelligenceHint`, `models.smartRouting_balanceHint`, `models.smartRouting_costHint`다. 이 12개가 `gui/src/i18n/{de,en,ja,ko,ru,zh}.ts` 전부에서 빠졌다. TypeScript가 6개만 보고하는 이유는 나머지 6개가 `as TKey`에 가려지기 때문이다.

`gui/tests/error-boundary.test.tsx:38`의 `error: render exploded`는 passing test가 의도적으로 낸 출력이라 결함이 아니다. 실제 실패는 GUI build TS2345다. `AWAIT_FIX`도 맞을 수 있지만 `REBUILD_ON_DEV`가 전순서에서 먼저다. 재커팅 때 12개 키를 함께 고친다.

#### #410

- author: `HaydernCenterpoint`
- head SHA: `ea98e44077`
- mergeable/mergeStateStatus: `CONFLICTING/DIRTY`
- reviewDecision: `none`
- check pass/fail/pending: `10/0/0`
- 변경 파일 수: `24`
- 증거: `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS; 고유 diff는 `gui/src/styles/provider-catalog.css`의 CSS 교체 1건과 테스트 7줄; `draft=true` 전환 `2026-07-25T01:14:58Z`

고유 diff가 작으므로 누적 24파일 PR을 머지하지 말고 CSS 교체 1건과 테스트 7줄만 독립 커밋으로 다시 만든다.

#### #411

- author: `HaydernCenterpoint`
- head SHA: `d01b164940`
- mergeable/mergeStateStatus: `CONFLICTING/DIRTY`
- reviewDecision: `none`
- check pass/fail/pending: `10/0/0`
- 변경 파일 수: `83`
- 증거: `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS; 고유 범위는 아이콘·라이선스 자산 59개와 `gui/src/provider-icons.ts` mapping; `draft=true` 전환 `2026-07-25T01:15:35Z`

아이콘·라이선스 자산 59개와 `gui/src/provider-icons.ts` mapping만 재커팅한다. 83파일 누적 PR을 그대로 받으면 조상 기능까지 함께 들어온다.

#### #413

- author: `HaydernCenterpoint`
- head SHA: `23c47671bf`
- mergeable/mergeStateStatus: `CONFLICTING/DIRTY`
- reviewDecision: `none`
- check pass/fail/pending: `10/0/0`
- 변경 파일 수: `24`
- 증거: `src/codex/catalog/provider-fetch.ts`; `src/server/management/provider-routes.ts`; `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS; `draft=true` 전환 `2026-07-25T01:15:50Z`

OpenRouter free-only filtering 두 파일이 고유 가치다. 이 변경만 현재 `dev` 위에 재커팅하고 provider contract와 회귀 테스트를 다시 검토한다. draft 전환은 재구축 의사 신호로 기록하되 기존 충돌 처분보다 앞세우지 않는다.

### `AWAIT_CI` — 4건

#### #428

- author: `Wibias`
- head SHA: 원래 `2161fbcbb3`; 중간 `5ff127f3f5`; 최신 `e691b76efd`
- mergeable/mergeStateStatus: 원래 `MERGEABLE/UNSTABLE`; 중간 `MERGEABLE/CLEAN`; 최신 `MERGEABLE/UNSTABLE`
- reviewDecision: `none`
- check pass/fail/pending: 원래 `7/3/0`; 중간 `8/0/0`; 최신 `8/0/2`
- 변경 파일 수: 원래 `21`; 중간 `29`; 최신 head는 이 drift 새로고침에서 재분석하지 않음
- 증거: 원래 head의 `gui/src/App.tsx:186:5`, `gui/src/App.tsx:238:9`, `react-hooks/set-state-in-effect`; 중간 head run `30138616581`의 `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS; 최신 head Cross-platform CI run `30139502262` `in_progress`, `ubuntu-latest`와 `macos-latest` SUCCESS, `windows-latest` pending; CodeRabbit pending

처분 진행은 `2161fbcbb3`의 3플랫폼 GUI lint FAILURE로 `AWAIT_FIX` → `5ff127f3f5`의 run `30138616581` green으로 `AWAIT_REVIEW` → `e691b76efd` 푸시 뒤 run `30139502262` 재실행으로 `AWAIT_CI`다. non-draft이고 exact-head 필수 CI가 아직 terminal이 아니므로 전순서 first-match는 `AWAIT_CI`다. run `30139502262`가 끝날 때까지 독립 리뷰 착수나 이전 green head를 근거로 한 랜딩을 지시하지 않는다. 완료 뒤 같은 head의 세 플랫폼 결론을 새로 확인해 실패면 `AWAIT_FIX`, 모두 성공이면 `AWAIT_REVIEW`로 다시 파생한다. `#427`과 `gui/src/pages/Dashboard.tsx` 및 locale 6종이 겹치므로 직렬화는 계속 필요하다.

#### #427

- author: `dev-shinyu`
- head SHA: `e43c59f4e5`
- mergeable/mergeStateStatus: `MERGEABLE/UNSTABLE`
- reviewDecision: `none`
- check pass/fail/pending: `2/0/0`
- 변경 파일 수: `13`
- 증거: 필수 3플랫폼 job `CI_NOT_RUN`; `gui/src/pages/Dashboard.tsx`; `gui/src/i18n/{de,en,ja,ko,ru,zh}.ts`

코드 수준 blocker는 없다. merged commit `aff83eb4`를 중복하지 않고 `src/server/management/system-routes.ts:41-67`에 `responseState` property 하나만 더한다. 노출 필드는 `src/responses/state.ts:244-256`의 `count`, `totalBytes`, `largestBytes`, `oldestAgeMs`뿐이며, `src/responses/state.ts:267-281`에서 map size, cached byte counts, timestamps만으로 계산한다. conversation content, request bodies, API keys, paths, account identifiers는 노출하지 않는다.

인증 경계도 그대로다. `/api/*`는 계속 `src/server/index.ts:332-336`의 `requireApiAuth(req, config, "management")`를 거치고 `#427`은 이 파일을 바꾸지 않는다. `/healthz`는 unauthenticated 상태를 유지하며 memory field가 추가되지 않았고 `tests/server-auth.test.ts:516-544`가 이를 검증한다. 값 검증도 construction-only가 아니다. `tests/responses-state.test.ts:848-903`과 `tests/memory-watchdog.test.ts:125-145`가 실제 값을 assert한다. 남은 coverage gap은 polling/rendering GUI test 부재다.

non-draft이며 필수 CI가 없어 처분은 `AWAIT_CI`다. head는 merge-base `dbed8c159` 기준 `dev@3fac781f`보다 6 commits 뒤다. `#428`과 Dashboard 및 6개 locale이 겹치므로 더 큰 dashboard redesign을 먼저 랜딩한 뒤 그 layout에 card를 다시 넣어야 한다.

#### #385

- author: `latemonk`
- head SHA: `ac0260b7af`
- mergeable/mergeStateStatus: `MERGEABLE/UNSTABLE`
- reviewDecision: `none`
- check pass/fail/pending: `3/0/0`
- 변경 파일 수: `2`
- 증거: 필수 3플랫폼 job `CI_NOT_RUN`; `tests/provider-registry-parity.test.ts:32`; 변경량 `+13/-1`

CI 부재로 `AWAIT_CI`지만, 성공 뒤에도 바로 머지할 수 없다. **BizRouter**를 registry에 받아들이려면 공식 endpoint·model catalog 출처, vendor confirmation artifact, context-window metadata 출처, 갱신할 docs/locale 파일 목록과 실제 변경, registry contract test, 지정된 trust/security reviewer의 승인까지 모두 필요하다. 현재 유일한 테스트 변경은 `tests/provider-registry-parity.test.ts:32`에서 ID 순서를 바꾼 것이다.

#### #355

- author: `tizerluo`
- head SHA: `1700fa3ffe`
- mergeable/mergeStateStatus: `MERGEABLE/UNSTABLE`
- reviewDecision: `none`
- check pass/fail/pending: `2/0/0`
- 변경 파일 수: `11`
- 증거: 필수 3플랫폼 job `CI_NOT_RUN`; `src/images/artifacts.ts`; `src/adapters/google.ts`; `tests/provider-registry-parity.test.ts`

필수 CI가 없어 `AWAIT_CI`다. rebuilt image bridge와 image artifact 경로, `#430`과 Google adapter, provider stack 및 `#385`와 registry parity test가 겹친다. 세 선행 변경을 먼저 정리한 뒤 rebase해야 한다.

### `AWAIT_VALIDATION` — 1건

#### #426

- author: `chrisae9`
- head SHA: `4a0558ce88`
- mergeable/mergeStateStatus: `MERGEABLE/UNSTABLE`
- reviewDecision: `none`
- check pass/fail/pending: `3/0/0`
- 변경 파일 수: `32`
- 증거: `draft=true`; 필수 3플랫폼 job `CI_NOT_RUN`; `src/server/responses/core.ts`; `src/server/management/provider-routes.ts`; 11개 cross-cutting intersections

필수 CI가 없지만 `AWAIT_CI`의 non-draft guard를 통과하지 않는다. 작성자의 ready 선언이 먼저라 `AWAIT_VALIDATION`이다. 11개 교차점으로 가장 얽힌 PR이며 `handleResponses()`, provider routes, routing/types를 함께 건드린다. 작성자가 범위를 줄이고 ready로 바꾼 뒤 최신 직렬 머지 결과 위로 rebase해야 한다.

### `AWAIT_REVIEW` — 4건

#### #430

- author: `snowyukitty`
- head SHA: `8704ab7bd3`
- mergeable/mergeStateStatus: 원래 `MERGEABLE/UNSTABLE`; `01:35Z`부터 `MERGEABLE/CLEAN`
- reviewDecision: `none`
- check pass/fail/pending: 원래 `5/0/5`; 최신 필수 CI 실패·대기 `0`
- 변경 파일 수: `2`
- 증거: run `30137944678`; `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS, Windows 완료 `2026-07-25T01:18:01Z`; `src/providers/registry.ts:665`; `src/server/adapter-resolve.ts:27-36`; `tests/google-empty-content.test.ts`

필수 CI가 끝난 draft가 아닌 PR이므로 CI 대기 처분은 해소됐고, 사람 리뷰가 없어 `AWAIT_REVIEW`다. 이슈 #420은 기능상 전부 고친다. `google-antigravity` + Claude route는 Anthropic이 아니라 GOOGLE adapter가 직렬화한다. `src/providers/registry.ts:665`가 `adapter: "google"`로 등록하고 `src/server/adapter-resolve.ts:27-36`은 `adapter: "anthropic"`일 때만 Anthropic을 고른다. 새 `geminiTextPart()`는 문자열이 아닌 text를 거부하므로 nested `{text:{text:...}}`가 upstream에 닿지 않는다. 회귀 범위는 `tests/google-empty-content.test.ts`의 **12 tests**다. `#355`와 `src/adapters/google.ts`에서 겹치지만 함수는 다르므로 `#430`을 먼저 리뷰한다.

#### #408

- author: `Wibias`
- head SHA: `a816f6f367`
- mergeable/mergeStateStatus: `MERGEABLE/CLEAN`
- reviewDecision: `none`
- check pass/fail/pending: `12/0/0`
- 변경 파일 수: `5`
- 증거: `src/lib/windows-elevation.ts:55-67`; `src/service.ts:315-317,361-367,480-484`; `activeInstall`; `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS

코드 보안 검토에서 injection path는 찾지 못했다. `execFile`을 쓰고 PowerShell single quote를 `src/lib/windows-elevation.ts:55-67`에서 escape한다. elevated binary는 `src/service.ts:315-317`의 System32 `schtasks.exe`로 고정되고 task XML은 `src/service.ts:480-484`에서 `<RunLevel>LeastPrivilege</RunLevel>`을 선언한다. `activeInstall` guard가 있어 retry loop도 없다.

작성자 수정 대신 MAINTAINER security review가 남아 `AWAIT_REVIEW`다. 낮은 우선순위 UX gap은 `src/service.ts:361-367`이 `/run` 실패를 삼켜 UI가 등록만 된 상태를 설치 완료로 표시할 수 있다는 점이다. 이 문제를 수용할지 고칠지는 메인테이너 리뷰에서 정한다.

#### #405

- author: `HaydernCenterpoint`
- head SHA: `a70e0cc4d7`
- mergeable/mergeStateStatus: `MERGEABLE/CLEAN`
- reviewDecision: `none`
- check pass/fail/pending: `10/0/0`
- 변경 파일 수: `4`
- 증거: `ubuntu-latest`, `macos-latest`, `windows-latest` all SUCCESS; stack root `#405 a70e0cc4`

충돌 없고 필수 CI는 끝났지만 독립 리뷰가 없다. `MERGE`의 독립 코드리뷰 조건을 채우기 전까지 `AWAIT_REVIEW`다. 이 PR을 stack root로 먼저 판단해야 #406 이후 재커팅 기준이 선다.

#### #403

- author: `lidge-jun`
- head SHA: `fcd3d682ee`
- mergeable/mergeStateStatus: `MERGEABLE/CLEAN`
- reviewDecision: `none`
- check pass/fail/pending: `17/0/0`
- 변경 파일 수: `26`
- 증거: unresolved review threads `12/12`; `src/cli/index.ts:390,445`; `src/grok/inject.ts:64,106,134,171,175,226`; head commit `2026-07-24T10:46:19Z`; reviews `11:00Z/11:04Z`; owner blocker comment `13:05:24Z`

owner PR도 같은 기준을 적용한다. 12개 inline review thread가 모두 unresolved이고, head commit은 reviews와 owner blocker comment보다 앞서 후속 수정이 없다. `src/cli/index.ts:390`의 ownership refusal 뒤에도 line 445에서 global Grok fence를 제거한다. `src/grok/inject.ts:106,134`는 실제 admission token을 `api_key = "opencodex-loopback"` placeholder로 덮고 line 171에서 managed region 전체를 start/ensure/restart 때마다 교체하므로 config data loss가 난다. line 64에는 quoted-first-segment TOML collision, lines 175와 226에는 no-final-newline 복원 손상이 있다. CLI lifecycle test가 없고 명시적 service/API stop 뒤 stale Grok entry도 남는다.

`SELF_MERGE_SAFE: no`다. `MAINTAINERS.md`는 author self-approval을 금지하고 credential handling에는 security review를 요구한다. green CI만으로 머지하지 않는다. owner가 blocker를 고친 뒤 별도 메인테이너의 security review와 독립 승인이 필요하다.

## Wibias 검증 부록 — 축 1 상세 집합에서 제외

이 부록은 Wibias 완료선언 5건의 검증 기록을 보존하기 위한 축 1 밖 영역이다. `#423`은 스냅샷 전에 이미 머지돼 처음부터 45항목 매니페스트 밖이므로 축 1 집합에 포함하지 않는다. `#402`는 스냅샷 당시 open PR 매니페스트 구성원이므로 위 축 1 표와 23건 산술에는 `ALREADY_MERGED` 상태표 행으로 한 번 포함했지만, 현재 open 상세 목록에서는 빠졌기 때문에 7필드 행만 이 부록으로 옮겼다. 부록의 번호를 축 1 집합에 다시 더하지 않는다.

### #402 — 스냅샷 뒤 머지된 매니페스트 구성원

- author: `Wibias`
- head SHA: `c7908f9ab1`
- mergeable/mergeStateStatus: 원래 `MERGEABLE/UNSTABLE`; 머지 뒤 `UNKNOWN/UNKNOWN`
- reviewDecision: `none`
- check pass/fail/pending: 원래 `8/0/1`; 재실행 뒤 `9/0/0`
- 변경 파일 수: `16`
- 증거: run `30137522394`; `windows-latest` 성공 `2026-07-25T01:29:26Z`; merged `2026-07-25T01:32:12Z`; merge SHA `6f4cd1d6bf`; `src/adapters/cursor/tool-definitions.ts`; `src/adapters/cursor/protobuf-events.ts`; `tests/cursor-blob.test.ts`; 이슈 #399

스냅샷 당시에는 Windows 작업 취소로 CI 재실행이 필요했지만, 재실행 성공 뒤 머지되어 최신 처분은 `ALREADY_MERGED`다. 이슈 #399 커버리지는 **`3/5 fully covered + cause 5 partially mitigated; cause 1 intentionally unchanged`**다. #402 머지 뒤 이슈 #399 자체 처분도 다시 판단해야 하므로 `020_issues.md`의 해당 행을 교차 참조한다. 이 작업에서는 동시 편집 중인 그 파일을 수정하지 않는다.

### #423 — 스냅샷 전 머지된 매니페스트 밖 항목

- author: `Wibias`
- head SHA: `af28e37c74`
- mergeable/mergeStateStatus: `UNKNOWN/UNKNOWN` (merged PR의 현재 GitHub 반환값)
- reviewDecision: `none`
- check pass/fail/pending: `11/0/0`
- 변경 파일 수: `4`
- 증거: merged `2026-07-24T23:57:05Z`; merge commit `3fac781f36a4e704c3fe847b60596f1cc2b7517c`; `ubuntu-latest`, `macos-latest`, `windows-latest` SUCCESS

`#423`은 open PR 23건 매니페스트에는 없지만 사용자가 완료선언 5건에 넣었으므로 이 부록에만 표시한다. 이미 `3fac781f`로 머지돼 추가 행동은 없다.

## Wibias 완료선언 5건 판정

| PR | 완료선언 대비 검증 결과 | 다음 공의 소유자 |
|---|---|---|
| #423 | 선언과 일치한다. `2026-07-24T23:57:05Z`에 `3fac781f`로 이미 머지됐다. | 없음 |
| #402 | 선언 뒤 `windows-latest` 재실행이 성공했고 `2026-07-25T01:32:12Z`에 merge SHA `6f4cd1d6bf`로 머지됐다. 이슈 #399 커버리지는 `3/5 fully covered + cause 5 partially mitigated; cause 1 intentionally unchanged`다. | 없음. 단, 이슈 #399 처분은 `020_issues.md`에서 새로 판단해야 함 |
| #408 | exact-head CI는 green이고 코드 보안 검토에서 injection path는 없었다. credential/elevation 경계라 MAINTAINER security review가 필수다. | 메인테이너 security reviewer |
| #392 | TS2783은 고쳤지만 `ApiKeys.tsx` endpoint 중복·누락 header와 docs gap이 남았다. `CHANGES_REQUESTED`가 아직 유효하다. | 작성자가 잔여 blocker 수정·응답, 이후 리뷰어 재검토 |
| #391 | “ready” 선언은 run `30119868825`의 3플랫폼 red CI와 맞지 않는다. 다만 red 원인은 구현이 아니라 primary를 소진하지 않은 test setup 결함이다. GitHub review thread 29개 중 23개가 미해결이며, 그 안에 이름이 붙은 두 설계 blocker가 포함된다. | 작성자가 테스트 fixture와 미해결 review thread를 정리, 이후 리뷰어 재검토 |

완료선언은 작업 재개 신호로는 유효하지만 머지 증거를 대신하지 않는다. `#391`의 불일치는 기여자의 역량 문제가 아니라 exact-head CI와 테스트 설정을 다시 맞춰야 하는 상태로 기록한다.

## HaydernCenterpoint 스택 (7건)

검증된 ancestry는 다음과 같다.

```text
#405 a70e0cc4  provider stack root
└─ #406 c42716de  provider fetch/discovery + 7 test files
   └─ #407 60046f85  Add Provider/model-loader UI
      ├─ #409 1acca4cb  smart-routing core + combo API/UI
      ├─ #410 ea98e440  provider-catalog CSS replacement + 7 test lines
      ├─ #411 d01b1649  59 icon/license assets + provider-icons mappings
      └─ #413 23c47671  OpenRouter free-only filtering
```

| PR | 고유 가치 | 현재 형태의 문제 |
|---|---|---|
| #405 | provider stack root의 4파일 변경 | 독립 리뷰가 없어 먼저 root 적격성을 정해야 함 |
| #406 | provider fetch/discovery + 7 test files | #405를 포함하고 `CONFLICTING/DIRTY` |
| #407 | Add Provider/model-loader UI | #405–#406을 포함하고 `CONFLICTING/DIRTY` |
| #409 | `src/combos/smart-routing.ts` + combo API/UI | 약 1,769줄 조상 변경과 12개 i18n key 누락을 함께 품음 |
| #410 | CSS replacement 1건 + 7 test lines | 작은 고유 diff에 약 1,769줄 조상 변경이 붙음 |
| #411 | 59 icon/license assets + mapping | 83파일 중 조상 24파일군이 중복됨 |
| #413 | OpenRouter free-only filtering 2파일 | 조상 provider/UI 변경 24파일군을 함께 품음 |

`#409`, `#410`, `#411`, `#413`은 `#407`의 sibling이지 서로의 후속 커밋이 아니다. sibling 하나를 as-is로 머지하면 그 PR의 고유 가치뿐 아니라 약 1,769줄의 stale ancestor diff까지 흡수한다. `#405`를 먼저 리뷰한 뒤, 필요한 기능만 현재 `dev` 위에 작은 독립 커밋으로 재커팅해야 한다. 재커팅한 각 SHA는 별도 3플랫폼 CI와 독립 리뷰를 받아야 한다.

## 파일 충돌 행렬

`gh pr view <n> --json files`의 비어 있지 않은 교집합을 공통 파일군으로 묶었다. 아래 “순서”는 왼쪽부터 직렬 처리하며, 뒤 PR은 앞 PR의 최종 결과 위로 rebase한다는 뜻이다. sibling stack은 as-is 머지가 아니라 고유 diff 재커팅을 뜻한다.

| 파일군 | 교차 PR 전수 | 직렬 순서 |
|---|---|---|
| Cursor adapter/tests | `#429↔#402`, `#429↔#376`, `#402↔#376` | merged `#402@6f4cd1d6bf` → `#376` 수정·rebase → `#429` rebase. `#429`는 #402의 alias normalization/system guidance를 보존 |
| Google adapter | `#430↔#355` (`src/adapters/google.ts`) | `#430` → `#355` rebase |
| Dashboard + 6 locales | `#427↔#428` | `#428@e691b76efd`의 run `30139502262` 완료 확인 → 성공 시 독립 리뷰·land → `#427` rebase. 중간 head `5ff127f3f5`의 run `30138616581` green은 진행 이력으로만 보존한다. 더 큰 dashboard redesign(`#428` `+1209/-610`, `#427` `+417/-2`)을 먼저 받고, 후행 `#427`은 revised layout에 card를 다시 넣고 6개 `dash.mem.*` locale group을 모두 합친 뒤 GUI tests/lint/build를 재실행 |
| 6 locales — #428 | `#428↔#413`, `#428↔#411`, `#428↔#410`, `#428↔#409`, `#428↔#407`, `#428↔#392` | `#392` → rebuilt `#407` → `#409` → `#410` → `#411` → `#413` → `#428` rebase |
| 6 locales — #427 | `#427↔#413`, `#427↔#411`, `#427↔#410`, `#427↔#409`, `#427↔#407`, `#427↔#392` | 같은 순서 뒤 `#427` rebase |
| 6 locales — stack/#392 | `#413↔#392`, `#411↔#392`, `#410↔#392`, `#409↔#392`, `#407↔#392` | `#392` → rebuilt stack 순서 |
| Dashboard docs/styles | `#428↔#389` (docs 5종), `#428↔#392` (`gui/src/styles.css` 포함) | `#389`와 `#392`의 작성자 수정 → `#428` rebase |
| `handleResponses()` / response types | `#426↔#424`, `#426↔#403`, `#426↔#391`, `#424↔#403`, `#424↔#391`, `#403↔#391` | `#391` 수정·재리뷰 → `#403` blocker/security review → rebuilt `#424`가 `onUsage` seam을 보존 → `#426` ready·rebase |
| Image artifacts | `#424↔#355` (`src/images/artifacts.ts`) | `#355` shared artifact module → rebuilt `#424`가 canonical API 소비. `#355` consumer/test와 `#424` magic-byte·bounded-download semantics를 한 모듈에 통합 |
| Provider routes — draft #426 | `#426↔#413`, `#426↔#411`, `#426↔#410`, `#426↔#409`, `#426↔#407`, `#426↔#406` | rebuilt `#406` → `#407` → `#409` → `#410` → `#411` → `#413` → `#426` rebase |
| Draft #426 기타 | `#426↔#389` (`src/router.ts`), `#426↔#370` (account/auth), `#426↔#409` (combo routes/tests) | `#370`, `#389` 완료 → rebuilt `#409` → `#426` rebase. `#426`은 account-namespace routing을 provider/combo resolution 앞에 넣되 `#389`의 `preservesPhysicalComboProvider()` 호출을 유지 |
| Provider stack 24파일 core | sibling 전쌍 `#413/#411/#410/#409/#407`; 각 sibling과 `#406`; 각 sibling 및 `#406`과 `#405` | `#405` 리뷰 → 고유 diff `#406` → `#407` → `#409` → `#410` → `#411` → `#413`; 매 단계 재커팅 |
| Provider registry/parity | `#413/#411/#410/#409/#407/#406` 각각 `↔#385`, `↔#355`; `#405↔#385`, `#405↔#355`, `#385↔#355`; stack 각 PR과 `#405`도 포함 | `#405` → `#385` contract 보강 → rebuilt stack → `#355` rebase |
| Smart routing | `#409↔#389` (`gui/src/pages/Models.tsx`, `src/combos/index.ts`) | `#389` rebase·land → rebuilt `#409` semantic rebase. 같은 `Models()` component를 수정하므로 conflict marker만 푸는 방식은 금지하고, `src/combos/index.ts` 교집합은 export barrel overlap으로 처리 |

중복이 큰 provider sibling 전쌍은 다음 10쌍이다: `#413↔#411`, `#413↔#410`, `#413↔#409`, `#413↔#407`, `#411↔#410`, `#411↔#409`, `#411↔#407`, `#410↔#409`, `#410↔#407`, `#409↔#407`. 각 쌍은 같은 24파일군을 공유한다. 이 표의 묶음은 조회된 비어 있지 않은 교집합 전수를 덮으며, 서로 다른 파일군을 공유하는 쌍은 행에 중복 표기될 수 있다.

HIGH 위험은 다음 네 갈래다.

- `#402↔#429`: 같은 Cursor 함수와 assertion을 반대 방향으로 바꾼다. `#402@6f4cd1d6bf`가 이미 선행했으므로 `#429` rebase가 필수다.
- `#427↔#428`: `Dashboard.tsx`와 locale 6종이 겹친다. 현재 head `#428@e691b76efd`의 run `30139502262`가 끝난 뒤 exact-head green이면 독립 리뷰하고 먼저 랜딩한다. 그 뒤 `#427`이 revised layout과 6개 `dash.mem.*` group을 다시 합친다.
- `#424↔#355`: 같은 export API의 add/add 충돌이지만 extension semantics가 다르다. `#355`의 consumer/test를 보존한 canonical artifact module에 `#424`의 magic-byte·bounded-download 동작을 합친다.
- `#424↔#403↔#391↔#426`: `src/server/responses/core.ts`의 `handleResponses()`에서 cross-cutting 변경이 겹친다. `#391`과 `#403`을 먼저 반영하고 rebuilt `#424`가 usage-provenance `onUsage` seam을 보존한 뒤 `#426`을 rebase한다.
- `#389↔#409/#426`: `#409`는 같은 `Models()` component를, `#426`은 같은 `routeModelInternal()`과 combo-preservation hunk를 수정한다. 둘 다 `#389` 뒤 semantic rebase가 필요하다.

## 실행 순서

실행 승인 뒤에도 아래 precondition을 만족한 단계만 진행한다.

1. **[작성자] `#391`, `#392`, `#389`, `#376`, `#370` 응답 수렴.** 각 작성자가 `CHANGES_REQUESTED`를 수정·설명하고 review thread에 답한다. `#391`은 세 test fixture와 slash-provider 설계를 분리하고 run `30119868825`의 실패를 없앤다. `#392`는 ApiKeys endpoint/header/docs를 고친다. `#389`의 요청 변경은 기술적으로 끝났으므로 `dev` rebase와 full matrix 재실행 뒤 stale review decision을 해소하고, `#409`와 `#426`보다 먼저 랜딩한다.
2. **[메인테이너] `#430` 독립 리뷰.** run `30137944678`에서 exact-head 3플랫폼 CI가 모두 성공했으므로 이슈 #420의 full fix 여부를 코드로 확인한 뒤 머지 여부를 판단한다.
3. **[작성자] `#429` 재구축.** `#402`는 run `30137522394` 성공 뒤 merge SHA `6f4cd1d6bf`로 이미 랜딩했다. `#429`를 최신 `dev` 위로 rebase하고 #402의 alias normalization/system guidance를 보존하면서 user/developer prompt mutation만 제거한 뒤 3플랫폼 CI를 돌린다.
4. **[메인테이너] `#408` security review.** elevation/credential boundary를 별도 메인테이너가 승인하고 `/run` UX gap의 수용 여부를 기록해야 머지할 수 있다.
5. **[owner 작성자 + 별도 메인테이너] `#403` blocker 수정.** 12/12 thread를 답하고 admission token data loss, ownership refusal, TOML/newline/lifecycle 결함을 고친다. author self-approval 없이 security review와 독립 승인 뒤에만 머지한다.
6. **[메인테이너] `#405` 독립 리뷰.** stack root를 먼저 수용·거절한다. 수용 시 exact-head green을 확인하고 이후 재커팅 기준 SHA로 삼는다.
7. **[HaydernCenterpoint/메인테이너] `#406`–`#413` 재커팅.** `#406` provider fetch → `#407` Add Provider UI → `#409` smart routing → `#410` CSS → `#411` icons → `#413` OpenRouter filter 순으로 고유 diff만 새 `dev` 위에 올린다. 각 단계에서 3플랫폼 CI와 독립 리뷰를 새로 받는다. `#409`는 먼저 랜딩한 `#389`의 `Models()` 의미를 보존하는 semantic rebase를 하고 12개 i18n key를 채운다. `src/combos/index.ts`의 export barrel overlap만 보고 양립성을 판단하지 않는다.
8. **[작성자 + 메인테이너] `#428` → `#427` 직렬화.** 중간 head `#428@5ff127f3f5`는 run `30138616581`에서 3플랫폼 CI가 모두 성공했지만, 현재 head는 `e691b76efd`이고 run `30139502262`가 진행 중이다. 먼저 현재 run의 exact-head 세 플랫폼 결론을 확인한다. 모두 성공한 경우에만 독립 리뷰에서 원래 lint 두 위치를 현재 diff 기준으로 다시 확인한 뒤 더 큰 dashboard redesign을 랜딩한다. `#427`은 revised layout에 memory card를 다시 넣어 6개 `dash.mem.*` locale group을 합친 뒤 GUI tests/lint/build와 필수 CI를 실행한다.
9. **[작성자 + 지정된 trust/security reviewer] `#385` BizRouter admission 검증.** 공식 endpoint·model catalog 출처, vendor confirmation artifact, context-window metadata 출처를 확보한다. 문서 대상 `docs-site/src/content/docs/guides/providers.md`, `docs-site/src/content/docs/{ko,ja,ru,zh-cn}/guides/providers.md`와 UI locale 대상 `gui/src/i18n/{de,en,ja,ko,ru,zh}.ts`의 갱신 필요 여부를 파일별로 판정하고 필요한 변경을 반영한다. BizRouter endpoint·model·context-window를 고정하는 registry contract test, exact-head CI, 지정된 검토자의 trust/security 승인을 모두 갖춘다.
10. **[작성자] `#355` shared artifact module 정착.** `#430`과 provider registry 결정 뒤 Google/image/registry 교집합을 풀고, 기존 consumer/test를 유지한 canonical `src/images/artifacts.ts`를 exact-head CI로 검증한다.
11. **[작성자 + security reviewer] `#424` 재구축.** `#355` artifact API, `#391` routing, `#403` usage-provenance callback 위에 다시 자른다. Responses Lite combined tools, SSRF 방어와 redirect 재검증, `runTurn` adapter 경계, refresh-aware OAuth, handler/parser 통합 회귀를 갖추고 `onUsage` seam을 보존한다. private destination 처리는 명시적 security review를 받고 exact-head CI와 독립 리뷰를 새로 받는다.
12. **[작성자] `#426` draft 종료.** 앞의 `#389`, `handleResponses()`, provider-route 결정을 반영해 범위를 줄이고 rebase한다. account-namespace routing을 provider/combo resolution 앞에 넣되 `preservesPhysicalComboProvider()` 호출을 유지한다. 작성자가 ready로 바꾼 뒤에만 필수 CI와 독립 리뷰 큐에 넣는다.
13. **[메인테이너] 최종 머지 게이트.** 각 후보마다 current `dev` 기준 mergeability, exact-head 3플랫폼 green, unresolved blocker 0, 독립 승인, 보안 경계의 명시적 security review를 동시에 확인한다. 하나라도 없으면 `MERGE`로 승격하지 않는다.

## C1-C6 자체 점검

- **C1:** Wibias 완료선언 `#423 #402 #408 #392 #391` 각각에 author, head SHA, mergeable/mergeStateStatus, reviewDecision, check p/f/pend, 변경 파일 수, `file:line`·run·job·test 증거의 7필드를 모두 적었다. `#402`는 스냅샷 구성원으로 `ALREADY_MERGED`, `#423`은 스냅샷 전 머지된 축 1 밖 검증 항목이다.
- **C2:** 스냅샷 매니페스트 PR 집합은 `{430,429,428,427,426,424,413,411,410,409,408,407,406,405,403,402,392,391,389,385,376,370,355}`로 정확히 23건이며 위 축 1 표에서 각 번호를 한 번씩 센다. 현재 open 집합은 여기서 머지된 `{402}`를 뺀 22건이다. `#423`은 매니페스트 밖 부록에만 있고 축 1 합집합에는 들어가지 않는다. 따라서 스냅샷 PR 23 + Issue 22 = 45라는 C2 집합 일치를 유지하면서, 최신 open PR 수 22도 별도로 성립한다.
- **C3:** open PR에는 `ROADMAP`과 `DEFER` 처분이 없어 PR 쪽 고정 라벨 의무가 발생하지 않는다. 해당 처분의 Issue 필드는 `020_issues.md`가 점검한다.
- **C4:** open PR에는 `CLOSE_MENTION`이 없다. Issue의 사실 근거와 코멘트 문안은 `020_issues.md`가 맡는다.
- **C5:** `gh pr view <n> --json files`의 PR 교집합 전수를 파일군별로 묶고 각 묶음에 직렬 순서를 줬다. 필수쌍 `#427↔#428`, `#402↔#429`와 HIGH `#424↔#355`, `handleResponses()` cluster를 명시했다.
- **C6:** 이 문서의 write 대상은 `devlog/_plan/260725_wibias_pr_issue_disposition/010_disposition.md` 한 파일뿐이다. `src/`, `gui/`, `tests/`, `.github/`, `docs-site/`, `000_plan.md`, `020_issues.md`는 수정하지 않는다.
