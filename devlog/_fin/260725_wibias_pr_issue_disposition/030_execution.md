# 030 — 메인테이너 트리아지 실행 패킷

> 인벤토리 스냅샷 `2026-07-25T01:05:24Z` · 실행 근거 새로고침 `2026-07-25T01:40:17Z` · #428 drift 확인 `2026-07-25T02:01:37Z` · 기준 SHA `3fac781f`
> 구조와 판정 규칙: [`000_plan.md`](./000_plan.md) · PR별 처분과 충돌 순서: [`010_disposition.md`](./010_disposition.md) · 이슈 처분과 검증: [`020_issues.md`](./020_issues.md)
>
> 이 문서는 처분 축을 바꾸지 않는다. `010_disposition.md`의 축 1 처분을 실제 명령·리뷰 점검표·작성자 요청으로 변환하고, `020_issues.md`의 이슈 처분은 실행 우선순위 판단에 연결한다. GitHub 조치는 아직 실행하지 않았다.

## CI가 실행되지 않은 진짜 원인

### 결론

PR `#429 #427 #426 #424 #389 #385 #355`의 필수 교차 플랫폼 CI가 보고되지 않은 원인은 워크플로 실행 조건이나 경로 필터가 아니다. 일곱 PR 모두 `dev`를 대상으로 하고, CI 대상 경로를 바꾸며, 다른 포크 저장소에서 들어왔다. 각 워크플로 실행은 생성됐지만 결론이 `action_required`다. 저장소의 현재 Actions 설정은 다음과 같다.

```json
{"approval_policy":"first_time_contributors"}
```

GitHub가 처음 기여한 포크 저장소 기여자의 워크플로를 보류한 상태다. 쓰기 권한이 있는 메인테이너가 실행별로 승인해야 작업이 시작된다.

> **`Approve workflow run`과 `Approve pull-request review`는 서로 다른 조치다.** 여기서 필요한 것은 Actions 실행 승인이다. 이 승인은 코드리뷰 승인이나 머지 승인을 대신하지 않는다.

### 워크플로 근거

- `.github/workflows/ci.yml:3`: `main`/`dev` 대상 `pull_request`. `types:`가 없으므로 기본 이벤트 `opened`, `synchronize`, `reopened`가 적용된다.
- `.github/workflows/ci.yml:6`: PR 경로 필터가 `src/**`, `bin/**`, `tests/**`, `scripts/**`, `gui/**`와 지정된 설정/워크플로 파일을 포함한다.
- `.github/workflows/ci.yml:20`: `main`/`preview`/`dev` 푸시를 받는다.
- `.github/workflows/ci.yml:36`: `workflow_dispatch`가 있다.
- `.github/workflows/ci.yml:38`: `contents` 권한은 읽기 전용이다.
- `.github/workflows/ci.yml:41`: 같은 ref의 이전 실행을 취소하는 동시성 정책이다.
- 워크플로 수준 `if:` 중 포크 PR을 막는 조건은 없다.

따라서 실제 분포는 `#427 #385 #355`가 `AWAIT_CI`, `#426`이 `AWAIT_VALIDATION`, `#429 #424`가 `REBUILD_ON_DEV`, `#389`가 `AWAIT_AUTHOR`다. 일곱 건 모두 워크플로 실행이 생성된 뒤 메인테이너 승인을 기다린다는 기술적 원인은 같지만, 현재 헤드의 실행을 지금 승인해도 되는지는 처분과 선행 조건에 따라 다르다. React Doctor 실행도 같은 정책으로 보류됐다.

## CI 조치 명령 시트

`AWAIT_CI`/`AWAIT_FIX`/`AWAIT_REVIEW` 행은 push나 CI 완료 한 번으로 뒤집히므로 실행 직전에 현재 head와 checks를 반드시 다시 확인한다.

### 1. 지금 승인

현재 헤드에서 포크 승인만 남은 세 건이다.

| PR | 필요 조치 | 정확한 명령 |
|---|---|---|
| `#427` (`dev-shinyu`) | 교차 플랫폼 CI와 React Doctor 실행 승인 | `gh api --method POST repos/lidge-jun/opencodex/actions/runs/30136135893/approve`<br>`gh api --method POST repos/lidge-jun/opencodex/actions/runs/30136135898/approve` |
| `#385` (`latemonk`) | 교차 플랫폼 CI와 React Doctor 실행 승인 | `gh api --method POST repos/lidge-jun/opencodex/actions/runs/30069499741/approve`<br>`gh api --method POST repos/lidge-jun/opencodex/actions/runs/30069499731/approve` |
| `#355` (`tizerluo`) | 교차 플랫폼 CI와 React Doctor 실행 승인 | `gh api --method POST repos/lidge-jun/opencodex/actions/runs/30111628130/approve`<br>`gh api --method POST repos/lidge-jun/opencodex/actions/runs/30111628129/approve` |

### 2. 선행 조치 후 승인

아래 기존 실행 ID는 기술적으로 유효한 승인 끝점이지만 운영상 폐기됐다. **지금 승인하지 말고**, 선행 조치가 새 헤드의 대체 실행을 만든 뒤 GitHub가 보류한 그 새 실행을 승인한다.

| PR | 선행 조건 | 추적용 기존 실행 ID — 지금 실행 금지 |
|---|---|---|
| `#429` (`Aciredy`) | 작성자가 머지된 `#402@6f4cd1d6bf`를 보존하며 현재 `dev` 위로 리베이스한다. 그 뒤 새 헤드에서 보류된 실행을 승인한다. | `30137311395`, `30137311394` |
| `#424` (`tizerluo`) | `#355`의 공용 산출물 모듈과 `#391`/`#403`이 랜딩한 뒤, SSRF 위험을 포함한 다섯 차단 요인을 해소해 현재 `dev` 위에서 재구축한다. 그 재구축 헤드의 실행만 승인한다. | `30133744691`, `30133744700` |
| `#389` (`csa906`) | 소유자가 이미 요청한 대로 작성자가 `dev` 위로 리베이스해 푸시하고 전체 행렬을 다시 생성한다. 대체 실행이 보류되면 승인한다. | `30093516334`, `30093516368` |
| `#426` (`chrisae9`) | 작성자가 범위를 줄이고 최신 직렬 머지 결과 위로 리베이스한 뒤 초안을 해제해 준비 완료를 선언한다. 그 뒤 생성된 실행만 승인한다. | `30136033128`, `30136033126` |

### 3. 진행 중 — 완료 대기

| PR | 확인된 상태 | 다음 조치 |
|---|---|---|
| `#428` | 원래 head `2161fbcbb3`의 3플랫폼 GUI lint FAILURE로 `AWAIT_FIX` → 중간 head `5ff127f3f5`의 run `30138616581` green으로 `AWAIT_REVIEW` → 현재 head `e691b76efd`의 Cross-platform CI run `30139502262` 재실행으로 `AWAIT_CI`. 현재 `MERGEABLE/UNSTABLE`이며 Ubuntu/macOS는 성공, Windows는 진행 중이다. | run `30139502262`가 terminal이 될 때까지 기다린다. 완료 뒤 head가 여전히 `e691b76efd`인지와 세 플랫폼 결론을 다시 확인해 실패면 `AWAIT_FIX`, 모두 성공이면 `AWAIT_REVIEW`로 재파생한다. 이전 green head를 근거로 리뷰·랜딩하지 않는다. |

### 4. 조치 불필요

| PR | 확인된 상태 | 실행 명령 |
|---|---|---|
| `#402` | `2026-07-25T01:32:12Z`에 머지 SHA `6f4cd1d6bf`로 머지됨 | 없음 |
| `#430` | 실행 `30137944678`의 6개 작업이 모두 성공함 | 없음 |

승인 명령은 실행을 시작할 뿐이다. 실행 뒤 정확한 헤드의 Ubuntu/macOS/Windows 결과, React Doctor 결과, 코드리뷰 게이트를 다시 확인한다.

## 리뷰 패킷 — #405

대상 헤드: `a70e0cc4d7`. CI는 성공했지만 승인 전 차단 요인이 있다.

- [ ] `deriveKeyLoginMap()`이 `supportLevel === "reference"`와 `directoryOnly`를 제외하는지 확인한다(`src/providers/derive.ts:135`). `deriveInitProviders()`도 같은 조건을 쓴다(`src/providers/derive.ts:175`). 두 함수가 어긋나지 않도록 공용 연결 가능성 판정식 하나로 합치거나 동등성 테스트를 요구한다.
- [ ] **승인 전 차단 요인:** `deriveProviderPresets()`는 `accessGroups?.length`만 보고 범위를 넓히며 `reference`/`directoryOnly`를 제외하지 않는다(`src/providers/derive.ts:202-208`). 그 결과 `agy`, `blackbox`, `coze`, `duckduckgo-web` 같은 항목이 `/api/provider-presets`에 들어간다.
- [ ] 후속 실패 경로를 막는다. `gui/src/components/provider-catalog/provider-presets.ts:13-36`은 새 필드를 해석하지 못한다. `bucketPresets()`는 해당 항목을 일반 제공자로 분류하고, `ProviderCatalog.tsx:122-129`는 선택 버튼을 그린다. `AddProviderModal.tsx:134-148`은 비어 있거나 사용할 수 없는 `baseUrl`로 제공자를 만든다.
- [ ] `src/providers/registry.ts:1024-1054`의 메타데이터 덮어쓰기를 검토한다. 디렉터리 메타데이터가 기존 제공자의 표준 어댑터, `baseUrl`, 인증을 덮어쓰지 않는다는 증거가 필요하다.
- [ ] 테스트에 다음 계약을 고정한다: `reference`/`directoryOnly`는 키 로그인과 초기화에 없음; 프리셋에 사용할 수 없는 항목이 없음; 연결 가능한 디렉터리 항목은 계속 노출됨; 반환 배열은 공용 참조가 아니라 복제본임.
- [ ] 디렉터리 데이터 오류를 고친다. `glm-cn`이 `src/providers/free-directory.ts:15-24`의 `recurring-uncapped`와 `signup-credit`에 중복돼 있다.
- [ ] `src/providers/free-directory.ts:70`의 `cloudflare-ai`에는 리터럴 `{account_id}`가 있다. 계정 범위 재정의가 생기기 전에는 선택 가능하게 노출하지 않는다.
- [ ] 수정 뒤 `bun test tests/provider-registry-parity.test.ts`를 실행한다.
- [ ] 회귀 검증 기준으로 `bun run typecheck`와 `bun run test`를 실행한다.

승인 조건은 연결 가능성 판정 일치, 사용할 수 없는 프리셋 차단, 덮어쓰기 안전성, 위 회귀 테스트 통과다.

## 보안 리뷰 패킷 — #408

대상 헤드: `a816f6f367`. 12개 검사는 모두 성공했지만 `MAINTAINERS.md:19`에 따라 명시적 보안 리뷰가 필수다. 위협 경계는 권한 없는 대시보드 요청이 PowerShell `RunAs`를 써서 Task Scheduler 등록만 재시도할 수 있고, 설치된 작업은 최소 권한을 유지해야 한다는 것이다.

- [ ] **Fail-closed:** `elevateSchtasks()`는 `windowsSchtasks()` 결과를 `runWindowsElevated()`에 넘긴다(`src/service.ts:347-353`). `windowsSchtasks()`는 absolute System32 경로에서 bare `schtasks.exe`로 fallback한다(`src/service.ts:315-317`). `windowsPowerShell()`도 bare `powershell.exe`로 fallback한다(`src/lib/windows-elevation.ts:50-52`). 조작된 `SystemRoot`, `PATH`, cwd가 사용자 소유 실행 파일을 고를 수 있는지 판정한다. absolute trusted resolution만 허용하고 PATH fallback을 없애거나, 공격자가 fallback을 통제할 수 없다는 문서와 테스트를 요구한다.
- [ ] **TOCTOU:** 경로를 한 번만 resolve하고 absolute path를 보관한다. elevated child가 검증된 System32 binary인지 보장한다. 파일 소실·교체 시 PATH fallback 없이 실패해야 한다.
- [ ] **Argument boundary:** `execFile()`(`src/lib/windows-elevation.ts:72-94`)와 `psSingleQuote()`(`:55-67`)가 invocation boundary를 지키는지 확인한다. `buildWindowsElevatedArgumentList()`(`:40-48`)가 space, apostrophe, ampersand, trailing backslash를 `Start-Process -ArgumentList`에 정확히 전달해야 한다. 중간 문자열 비교가 아니라 **child가 원래 argv를 받은 사실**을 테스트한다.
- [ ] **Input constraint:** `runWindowsElevated()`가 고정된 `schtasks` call site에서만 도달 가능한지 확인한다. dashboard 입력으로 path나 argument를 주입할 수 없어야 한다.
- [ ] **Privilege persistence:** task XML은 `<RunLevel>LeastPrivilege</RunLevel>`을 쓴다(`src/service.ts:480-484`). elevated action이 principal, command, run level을 바꾸지 않는지 확인한다.
- [ ] **Real UAC cancellation:** `Start-Process -Verb RunAs`는 `$null` 반환 대신 throw할 수 있어 `src/lib/windows-elevation.ts:69`의 `$null` 검사가 1223을 만들지 못할 수 있다. Windows 실측으로 stable cancellation error 또는 1223을 요구한다. 취소 뒤 `writeServiceInstallState("scheduler")`가 호출되지 않고, `runStartupInstallAction()`이 success를 반환하지 않으며, `src/server/startup-action-control.ts:65`의 `finally`가 `activeInstall`을 지우고, 다음 시도가 허용되며 idempotent인지 확인한다.
- [ ] **Partial-install recovery / post-create validation:** `windowsSchedulerTaskInstalled()`는 현재 존재 여부만 확인한다(`src/service.ts:337-345`). substring match가 아니라 task identity와 configuration까지 검사하게 한다.
- [ ] **Swallowed `/run` failure:** `src/service.ts:361-367`의 실패 무시는 “설치됨”이 “다음 로그인에서 시작됨”을 뜻해도 되는 경우 tracked correctness follow-up으로 남긴다. dashboard가 즉시 실행을 약속하거나 `/run` 실패가 잘못된 registration을 숨길 수 있으면 merge blocker로 올린다.

보안 승인 전 산출물은 trusted executable resolution 증거, child argv round-trip 테스트, Windows UAC 취소 실측, least-privilege/identity 검증이다.

## 본인 PR #403 — 심각도 순 9개 작업

대상 헤드: `fcd3d682ee`. 인라인 스레드 12개는 admission-token, ownership-refusal, quoted-TOML 항목의 중복 스레드를 합치면 9개 작업이다. `MAINTAINERS.md:19-23`에 따라 본인 승인은 금지된다.

1. **Critical · data ownership — admission token 파괴를 막는다.** `src/grok/inject.ts:106-134`가 `api_key = "opencodex-loopback"`를 만들고 `:171-179`가 managed region 전체를 교체한다. non-loopback 또는 token-protected binding에는 managed entry를 만들지 말고 manual-configuration warning을 반환한다. reachable `base_url`과 real token을 담은 fence 밖 user-owned entry를 문서화한다. user-owned non-loopback entry의 real token이 반복 start/ensure/restart 뒤 byte-for-byte 보존되고, token-protected endpoint에 loopback credential이 생기지 않으며, loopback autoconfig는 idempotent임을 테스트한다.
2. **High — ownership refusal 뒤 teardown을 중단한다.** `stopServiceIfInstalled()`가 `src/cli/index.ts:390-398`에서 ownership guard를 throw하면 `restoreNativeCodex()`, `revertSystemEnv()`, `stripGrokConfig()`(`:440-450`) 전에 abort하고 restart도 이어가지 않는다. `OPENCODEX_HOME`/`CODEX_HOME` mismatch에서 nonzero exit, teardown 없음, strip 없음, restore 없음, subsequent ensure 없음을 테스트한다.
3. **Medium — 정상 stop 뒤 stale entry를 지운다.** `ocx service stop` 성공 뒤(`src/service.ts:1066-1075`)와 `POST /api/stop` 성공 뒤(`src/server/management-api.ts:136-147`) `stripGrokConfig()`를 호출한다. ownership과 stop이 성공한 뒤 한 번만 호출한다. 두 경로는 strip하고, crash/respawn은 유지하며, ownership failure는 원문을 건드리지 않는지 테스트한다.
4. **Medium — quoted first-segment TOML collision을 잡는다.** `src/grok/inject.ts:64-76`에서 두 key segment를 모두 parse/canonicalize한다. `["model"."ocx-mine"]`, `['model'.ocx-mine]`, mixed form이 `[model.ocx-mine]`과 같은 alias로 판정돼야 한다. 각 형식이 alias를 예약해 generated entry가 `-2`를 받고, 원래 bytes가 보존되며, `Bun.TOML.parse()`가 성공하는지 테스트한다.
5. **Medium — final newline 상태를 byte-for-byte 복원한다.** `src/grok/inject.ts:175-179`, `:226-231`의 heuristic은 원본 newline과 주입된 newline을 구별하지 못한다. empty, LF with/without final newline, CRLF with/without final newline, 반복 inject-update-strip cycle을 테스트한다.
6. **Coverage gate — lifecycle wiring을 행위로 검증한다.** `handleStart`, `handleEnsure`의 두 branch, `handleStop`, restart refusal, service stop, API stop을 테스트한다. source-string 존재가 아니라 호출과 error propagation을 assert한다.
7. **Docs — non-loopback manual entry 계약을 바로잡는다.** `docs-site/src/content/docs/guides/grok-build.md:51-70`에서 reachable `/v1` `base_url`과 admission token을 모두 요구하고, managed fence 편집을 금지한다.
8. **Docs — protocol 권고를 실측과 맞춘다.** `devlog/_plan/260723_grok_build_bridge/020_docs_and_residual_smoke.md:10-14`에서 `chat_completions`를 권장하고, 관측된 `response.heartbeat` 동작 때문에 Responses가 incompatible하다고 기록한다.
9. **Docs — 지원되지 않는 hot-reload 보장을 없앤다.** `docs-site/src/content/docs/guides/grok-build.md:90-92`에서 hot-reload 보장을 삭제하고 `grok inspect` 뒤 reopen/reselect하도록 안내한다.

수정이 끝나면 인라인 스레드 12개를 모두 해결하고 다른 메인테이너의 리뷰를 받는다. 집중 Grok/CLI 테스트 뒤 `bun run typecheck`, `bun run test`, `bun run privacy:scan`을 실행한다.

## 기여자 코멘트 초안

`#428`의 Wibias에게 head 진행 이력과 현재 CI 대기 상태를 알리고 폐기된 실행의 재실행을 막으며 `#427` 충돌 범위를 경고한다.

```text
Thanks for the follow-up commits. The two earlier GUI lint failures at `gui/src/App.tsx:186:5` and `gui/src/App.tsx:238:9` were real regressions introduced by this PR under `react-hooks/set-state-in-effect`; that log ended with `✖ 2 problems (2 errors, 0 warnings)`. For comparison, `dev` at `3fac781f` passed GUI lint in run `30135102870`.

The intermediate head `5ff127f3` passed run `30138616581` at `01:38:26Z`, with all three platforms green. A later push moved the current head to `e691b76e`, and Cross-platform CI run `30139502262` is now in progress. Please wait for that exact-head run to finish before maintainer review; if it is green, #427 should rebase after this dashboard layout lands. Please do not rerun the obsolete run `30137327231`, which tested head `2161fbc`.

The old macOS failure was infrastructure while loading the pinned `actions/checkout` manifest used at `.github/workflows/ci.yml:56,107` (SHA `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`). The same action loaded successfully in that run's npm-global macOS job and in runs `30137944678`, `30137607500`, and `30137167914`.

One integration warning: #427 overlaps this PR in `gui/src/pages/Dashboard.tsx` and all six `gui/src/i18n/*` locale files. Please account for that overlap when rebasing or resolving the final merge order.
```

`#409`의 HaydernCenterpoint에게 누락 키 12개 전부와 형식 우회 제거를 요청하고 실제 차단 요인을 분리해 알린다.

```text
There are twelve missing i18n keys here, not six.

The six static keys are:
- `models.smartRoutingApplied` (`Models.tsx:157`)
- `models.smartRoutingFailed` (`Models.tsx:160`)
- `models.smartRoutingTitle` (`Models.tsx:717`, `Models.tsx:724`)
- `models.smartRoutingHint` (`Models.tsx:718`)
- `models.smartRoutingApplying` (`Models.tsx:721`)
- `models.smartRoutingApply` (`Models.tsx:721`)

The six dynamic keys hidden by `as TKey` are:
- `models.smartRouting_intelligence`
- `models.smartRouting_balance`
- `models.smartRouting_cost`
- `models.smartRouting_intelligenceHint`
- `models.smartRouting_balanceHint`
- `models.smartRouting_costHint`

Those dynamic keys originate from `Models.tsx:157`, `Models.tsx:737`, and `Models.tsx:738`. All twelve keys are absent from all six locale files. Please add all twelve to every locale and remove the `as TKey` escape where a typed key mapping can express the relationship safely.

Also, `error: render exploded` is intentional output from the passing test at `gui/tests/error-boundary.test.tsx:38`; it is not the blocker. The blocking failure is the GUI build's TS2345 error starting at `Models.tsx:157`.
```

`#429`의 Aciredy에게 머지된 `#402` 위로 리베이스하고 프롬프트 변경 제거 범위를 정확히 보존해 달라고 요청한다.

```text
Thanks for raising the prompt-mutation concern. #402 is the older change, addresses #399, and has now merged. #429 was authored from the same `3fac781f` base and conflicts with it in `src/adapters/cursor/tool-definitions.ts`, `src/adapters/cursor/protobuf-events.ts`, and the shared assertion in `tests/cursor-blob.test.ts`.

Please rebase this PR onto current `dev`, preserving #402's alias normalization and system-prompt guidance while removing only user/developer prompt mutation.

After the rebase, empty-argument validation needs to cover all of these paths:
- the aliased `shell_command` wire name;
- normalization from its `command` field to canonical `exec_command` `cmd`;
- the stateful completion path; and
- the stateless fallback at `src/adapters/cursor/protobuf-events.ts:288-294`.
```

`#430`의 snowyukitty에게 수정 경계와 6개 작업 성공 상태를 확인하고 메인테이너 리뷰 대기로 넘긴다.

```text
This confirms the fix and corrects the public record. The initial analysis blamed the Anthropic serializer, but `google-antigravity` is registered with `adapter: "google"` at `src/providers/registry.ts:665`. The Google adapter serializes the content before Antigravity translates it upstream, so guarding `geminiTextPart()` at `src/adapters/google.ts:103` is the correct boundary.

`tests/google-empty-content.test.ts` adds twelve focused tests, and run `30137944678` is green across all six jobs. This is ready for maintainer review and approval.
```

## 실행 우선순위

### P0 — 메인테이너가 지금 할 일

- `#427 #385 #355`의 교차 플랫폼 CI와 React Doctor 실행만 위 **지금 승인** 명령대로 승인한다. 이는 워크플로 실행 승인이지 PR 리뷰 승인이 아니다.
- `#430`은 독립 메인테이너 코드리뷰에 넣는다. `#428`은 현재 head `e691b76efd`의 run `30139502262`가 끝날 때까지 `AWAIT_CI`로 두고, exact-head green을 확인한 경우에만 독립 리뷰로 넘긴다. 이후 `#428`이 랜딩하면 `#427`은 확정된 대시보드 레이아웃 위로 리베이스한다.
- `#405`는 제공자 프리셋 차단 요인을 확인하고 수정 요청을 남긴다. CI 성공만으로 승인하지 않는다.
- `#408`은 일반 코드리뷰와 분리해 명시적 보안 리뷰를 배정한다.

### P1 — 작성자 수정 뒤 다시 볼 일

- `#403`: 위 9개 작업을 고치고 스레드 12개를 해결한 뒤 다른 메인테이너의 독립 리뷰를 받는다. 소유자 본인 승인은 금지한다.
- `#429`: 머지된 `#402`를 보존하는 현재 `dev` 리베이스와 네 검증 경로의 회귀 테스트를 기다린 뒤 새 실행을 승인한다.
- `#424`: `#355` 공용 산출물 모듈과 `#391`/`#403` 랜딩 뒤 다섯 차단 요인을 해소한 재구축 헤드의 실행만 승인한다.
- `#389`: 작성자의 `dev` 리베이스 푸시로 전체 행렬이 다시 생성되면 대체 실행을 승인한다.
- `#426`: 범위 축소, 리베이스, 초안 해제와 작성자의 준비 완료 선언 뒤 새 실행을 승인한다.
- `#409`: 로캘 6종의 키 12개와 형식화된 매핑 수정을 기다린다.

### P2 — 결과가 모인 뒤 직렬 판정할 일

- 승인한 포크 실행마다 정확한 헤드의 Ubuntu/macOS/Windows와 React Doctor 결과를 기록하고 `010_disposition.md`의 처분을 재평가한다. 성공은 리뷰 시작 조건이지 자동 머지 조건이 아니다.
- `#405`는 연결 가능성/프리셋/덮어쓰기 테스트가 모두 갖춰진 뒤 승인 여부를 결정한다.
- `#408`은 신뢰할 수 있는 경로, argv 왕복, UAC 취소, 작업 신원이 입증된 뒤 보안 승인 여부를 결정한다.
- `020_issues.md`의 `PR_IN_FLIGHT` 항목은 연결 PR이 실제로 머지된 뒤 남은 커버리지 공백을 다시 판정한다. 작성자 측 수정 대기 중에는 이슈를 성급히 닫지 않는다.
