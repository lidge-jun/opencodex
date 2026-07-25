# Review-only PR contracts — security, split, supersession, stale rework

## 범위와 게시 규칙

- 이 문서는 병합/수정 대상이 아닌 **11개 PR**(#408 #424 #447 #445 #355 #434 #405 #429 #391
  #426 #431)에 남길 **영어 리뷰 코멘트 본문 초안**만 고정한다.
  #403과 #437은 `NO_ACTION`이므로 게시 대상이 아니다 (`000_plan.md` manifest 참조).
- GitHub comment/review/close/push는 WP0 범위 밖이며 이 문서 작성 중 실행하지 않는다.
- 게시 직전 각 PR의 head SHA, draft 상태, diff, CI를 다시 확인한다. 아래 head가 달라졌다면 해당 초안을 그대로 게시하지 말고 `STALE`로 재감사한다.
- 리뷰는 AGENTS.md에 따라 영어로 쓰고 file:line, 구체적 failure mode, 수정 제안, 감사 표현을 포함한다.
- auth/credential/OAuth/process spawn/privileged execution/image URL fetch는 `MAINTAINERS.md:19-23`의 maintainer approval, required CI, explicit security review 경계다.

## 착수 시점과 apply-check 영수증

기준: detached `HEAD == origin/dev == 037e8f5e4fa32a82e4149acc509554f157656dad`, 2026-07-25 KST.

공통 명령:

```bash
gh pr diff N --repo lidge-jun/opencodex | git apply --check -
```

| PR | pinned head | 상태 | apply-check 결과 |
|---|---|---|---|
| #408 | `d435ce38546425e34420135ca5d00f16dc7a7f7e` | ready, 7 files | exit 0, clean |
| #424 | `db48e7c540c0e2fb657d8f2c5b1e845689385262` | ready, 18 files | exit 0, clean |
| #447 | `0c73bd1f06a4b6a7fa9973043330bcd943869e6b` | ready, 19 files | exit 0, clean |
| #445 | `ba5d9ca1e1c5a86a8ce2b0dc005c620afeef4021` | ready, 13 files | exit 0, clean |
| #355 | `1700fa3ffed0cdb8580772a454a9f8b91a735c6e` | ready, 11 files | exit 0, clean |
| #434 | `9b05269eb705a0cfa534c7c80769227c37a766a0` | ready, 96 files, `+2901/-391` | exit 1: six binary icon patches lack full index metadata; removed `gui/src/components/providers/{OAuthPanel,ProviderCardList}.tsx`; `gui/src/pages/Providers.tsx:56` conflict |
| #405 | `a70e0cc4d720e3a512910f3ea327d2db94fc865e` | ready, 4 files | exit 0, clean |
| #429 | `f408f3485d2a3ec1d35b10e82dcbd9d28f8f9932` | **draft**, 5 files | exit 1: `src/adapters/cursor/protobuf-events.ts:2`, `tool-definitions.ts:9`, `tests/cursor-blob.test.ts:324` do not apply |
| #391 | `ed1ee20139f0eb8dac194b8c8ad66a037be35848` | ready, 9 files | exit 0, clean |
| #426 | ~~`374313200f8fa20c9e00fe5f918c67372a289381`~~ → live `2ff3e24b` | **STALE — 게시 보류** | 50 files, `+2111/-74`, mergeable=CONFLICTING |
| #431 | `d25eba5b` (full SHA는 게시 직전 재확인) | **draft**, 9 files, `+140/-5` | exit 0, clean |

Clean apply는 security/correctness 승인 근거가 아니다. #434의 binary error만으로 stale을 판정하지 않고, removed paths와 Providers conflict 및 4-feature blast radius를 함께 근거로 split/rework를 요구한다.

## PR #408 — hostile `SystemRoot`를 통한 elevated executable substitution

게시할 영어 본문:

```text
Thank you for working through the Windows service-install recovery path. I found a security-blocking executable-resolution issue that needs to be fixed before this can merge.

`src/lib/windows-elevation.ts:212-213` derives the PowerShell executable passed to UAC `RunAs` from `process.env.SystemRoot`. That environment variable is caller-controlled, so a hostile process can point it at an attacker-owned directory containing `System32\WindowsPowerShell\v1.0\powershell.exe`; this code would then ask Windows to execute that binary with administrator privileges. The same trust rule must cover the `schtasks.exe` path used around `src/lib/windows-elevation.ts:446`.

Please resolve the real Windows system directory through a trusted OS mechanism rather than inherited environment state, construct both PowerShell and `schtasks.exe` from that trusted result, and fail closed if resolution cannot be verified. Add a regression test that launches the resolver with a hostile `SystemRoot` and proves neither elevated executable comes from it.

Because this code selects binaries for UAC elevation, it is an explicit security boundary under `MAINTAINERS.md` and requires maintainer security review in addition to the normal CI gates. Thanks again for improving the Windows path; once executable provenance is fixed and tested, the retry behavior can be reviewed on its own merits.
```

## PR #424 — image URL SSRF와 `runTurn` bridge bypass

게시할 영어 본문:

```text
Thank you for building out the Grok image bridge. There are two merge-blocking issues in the current implementation.

First, `src/images/artifacts.ts:83` fetches a provider-returned URL without validating its protocol, hostname, resolved addresses, or redirects. A malicious or compromised upstream can therefore make the local proxy request loopback, link-local, RFC1918, or other internal services (SSRF). Please require the intended HTTPS origin(s), run the existing destination/private-network policy before every request, revalidate every redirect target, and add negative tests for loopback/private/link-local hosts plus a redirect into a private address. Do not log the returned URL if it can contain credentials.

Second, `src/server/responses/core.ts:1308` and `src/server/responses/core.ts:1449` return through `adapter.runTurn` before the new image-plan branch executes. Cursor and any other runTurn adapter therefore never reach this bridge even when the request contains the advertised image-generation plan. Please integrate the bridge into the runTurn path or move the plan decision ahead of the early return, then add an end-to-end regression using a runTurn adapter that proves the bridge executes and its artifact is returned.

The outbound fetch is a network security boundary, so this PR also needs explicit maintainer security review after the fixes. I appreciate the substantial work here; these two paths need to be closed before we can safely expose it.
```

## PR #447 — destructive Kiro logout before replacement login commits

게시할 영어 본문:

```text
Thank you for adding browser-based Kiro multi-account login. The current transaction order can destroy the user's external CLI session on a normal cancellation or login failure.

At `src/oauth/kiro.ts:170`, the flow logs out `kiro-cli` before the browser login has succeeded. If the user closes the browser, the callback times out, or credential persistence fails, the operation exits with the external CLI still logged out and no replacement credential committed. Please defer logout until the new login and validation have succeeded, or snapshot and reliably restore the prior external session on every failure/cancellation path. Add regressions for user cancellation, callback failure, and credential-save failure that prove the prior Kiro CLI session remains usable.

This crosses both the external-process spawn boundary and credential persistence in `src/oauth/store.ts:160-178`, so `MAINTAINERS.md` requires explicit maintainer security review. Thanks for tackling a difficult account-flow improvement; the login needs transactional rollback semantics before merge.
```

## PR #445 — disabled OpenAI row bypasses canonical account-provider validation

게시할 영어 본문:

```text
Thank you for restoring the OpenAI account setup paths. The disabled-provider recovery logic currently bypasses the stricter canonical-provider validation and can re-enable an unusable OpenAI row.

At `gui/src/pages/CodexAuth.tsx:72-73`, `codexAccountModeState` treats any disabled `providers.openai` object as the built-in provider before `openAiAccountProviderState` verifies the canonical adapter/base URL/auth contract. The server's disabled-only PATCH path has the same problem: it can toggle that malformed row back on without canonicalizing or rejecting it. The UI can therefore report a recovered Codex account path while routing remains broken or points at a non-canonical OpenAI configuration.

Please make disabled rows pass the same `openAiAccountProviderState` canonical checks before they are considered built-in, and make the server validate/canonicalize the complete OpenAI row before a disabled-only re-enable is persisted. Add a regression with a disabled `openai` entry carrying a wrong adapter/base URL/auth mode and prove the UI does not offer the built-in recovery path and the PATCH cannot reactivate it unchanged.

This changes authentication/provider-validation behavior, so it requires explicit maintainer security review. I appreciate the recovery UX work; canonical validation has to remain the single gate for both enabled and disabled rows.
```

## PR #355 — MIME/extension spoofing과 신규 OAuth credential path

게시할 영어 본문:

```text
Thank you for adding Gemini inline-image output support. I found a correctness and safety issue in artifact materialization that should block merge.

`src/images/artifacts.ts:32` chooses the on-disk extension solely from the upstream-declared MIME type. The tests currently lock in the unsafe behavior by saving PNG bytes under JPEG/WebP extensions when the declaration says so. Downstream viewers and security tooling rely on the file signature matching the extension, so an incorrect or malicious MIME declaration produces mislabeled artifacts. Please sniff a small allowlisted set of image magic bytes (PNG, JPEG, WebP, and any other explicitly supported formats), reject a declaration/signature mismatch or choose the extension from the verified signature, and add positive plus spoofed-MIME regressions.

In addition, `src/server/images.ts:42-148` introduces a new path that reads OAuth tokens and project IDs to call the image backend. Please keep those values out of logs/errors/artifact metadata, cover refresh/expiry and failure behavior, and obtain the explicit maintainer security review required for credential-handling changes by `MAINTAINERS.md`.

Thanks for the feature work; verified bytes and the credential boundary both need to be addressed before this is safe to merge.
```

## PR #434 — 96-file mixed feature stack; split plus three concrete defects

게시할 영어 본문:

```text
Thank you for the large amount of provider-workspace work in this PR. At 96 files (`+2901/-391`) it combines four independently reviewable features and cannot be safely validated or reverted as one change. Please split it into these boundaries:

1. free-provider directory, trust metadata, and provider icons;
2. model-discovery API and model-selection UI;
3. connected-provider workspace redesign;
4. smart-routing backend and UI.

Each split should target current `dev`, include only its own tests/docs/assets, and preserve exact attribution/license files for any icons. The current aggregate also has these concrete blockers:

- `gui/src/components/AddProviderModal.tsx:254` retains the previous `defaultModel` when that value is absent from newly discovered models. This can save a provider with a model the selected endpoint does not expose. Clear the stale default or require an explicit valid selection, and add a provider-switch/discovery-refresh regression.
- `src/combos/smart-routing.ts:132` ignores each provider's `selectedModels` allow-list, so automatic routing can choose a model the user explicitly excluded. Filter candidates through the same allow-list contract used by catalog/routing and add a negative regression proving an excluded model is never selected.
- `gui/public/provider-icons/LICENSE.simple-icons:5` contains a U+FFFD replacement character, which means the license text was decoded or copied corruptly. Restore the exact upstream license text and add a UTF-8/replacement-character check for attribution assets.

The current diff also does not apply to current `dev`: it references removed provider components and conflicts in `gui/src/pages/Providers.tsx`; the GitHub text diff cannot apply six binary icons without full index metadata. Please re-cut each split from current `dev` rather than trying to merge the stale aggregate.

I appreciate the breadth of the contribution. Splitting it along the boundaries above will let us review trust metadata, discovery behavior, workspace UX, and routing correctness independently.
```

## PR #405 — directory rows become actionable without the guarding UI; superseded by #434

Live blob verification at the pinned heads confirms all four #405 files are byte-identical in #434:

| 파일 | shared blob SHA |
|---|---|
| `src/providers/derive.ts` | `22f19a6d431fff6073ff35a6d73987dc49adae8a` |
| `src/providers/free-directory.ts` | `3cd4647afb392df838fbfd8ccde1fe1aadbd7f6d` |
| `src/providers/registry.ts` | `5a579d4452dc6808755769e98416b505e8785681` |
| `tests/provider-registry-parity.test.ts` | `b7bc992792a25843a9232d211241d28c0c5b1f9e` |

게시할 영어 본문:

```text
Thank you for assembling the canonical free-provider directory. This PR should not merge independently in its current form.

At `src/providers/derive.ts:202`, entries marked `reference` / `directoryOnly` are still emitted into dashboard presets. The UI guard that prevents those informational rows from being connected (`isPresetActionable`) exists only in #434, not in this PR. Merging #405 alone would therefore present unverified/reference endpoints as connectable providers, which turns directory metadata into a product trust decision without the corresponding safety gate.

Please either add the actionable-state contract and tests in the same narrowly scoped PR, or keep directory-only rows out of dashboard presets. A regression should prove a `directoryOnly` entry can be displayed as reference information but cannot create provider config.

#434 already contains #405's four changed file blobs unchanged, so maintaining both also creates duplicate/superseded review work. Please close this PR in favor of the appropriately split directory slice from #434, rebased on current `dev`. Thanks for the research and curation; it needs to land with the non-actionable boundary intact.
```

## PR #429 — stale Cursor alias validation

게시할 영어 본문:

```text
Thank you for tightening Cursor's shell-command handling and for keeping this as a draft. The patch is stale against current `dev` and its validation is incomplete for the current alias contract.

`src/adapters/cursor/protobuf-events.ts:322` validates only `exec_command`, while current `dev` defines both `shell_command` and `exec_command` in `src/adapters/cursor/tool-definitions.ts:8-16`. The two aliases also use different accepted payload fields (`cmd` and `command`). As written, an empty or malformed shell invocation can still pass through the alias path that this PR does not inspect.

Please rebase/re-cut from current `dev`, normalize both tool names through one validator, and validate the corresponding `cmd` / `command` fields as non-empty commands. Add a four-way regression matrix covering both aliases with both valid and empty payloads, plus a malformed non-string value. The current patch fails `git apply --check` in `protobuf-events.ts`, `tool-definitions.ts`, and `tests/cursor-blob.test.ts`, so please do not resolve this by restoring old definitions.

Thanks for addressing the prompt-injection/empty-command edge; once rebased, both aliases need to share the same fail-closed behavior.
```

## PR #391 — floating quota refresh, non-atomic validation, incomplete health blocking

게시할 영어 본문:

```text
Thank you for the substantial quota-aware subagent fallback work. I found three correctness blockers that need to be resolved before merge.

1. `src/codex/subagent-model-fallback.ts:275-281` starts quota refresh work with `void` and returns no promise. The caller at `src/server/responses/core.ts:700-703` uses `await maybePrimeSubagentQuota(...)`, but that await resolves immediately, so model selection can run on stale quota state. Return the actual refresh promise (with errors handled at the owning boundary) and add a deferred-promise regression proving selection waits for the refresh result.

2. `src/server/management/agent-settings-routes.ts:328-331` silently removes invalid entries with `filter()` instead of rejecting the request. That violates the management API's atomic validation contract: a typo can persist a partially truncated fallback chain while returning success. Validate every item first, return 400 with the offending index/value, and mutate config only after the whole payload is valid. Add a regression proving one invalid entry leaves the previous config unchanged.

3. `src/codex/subagent-model-fallback.ts:173-184` does not record ordinary rate-limit wording as a health block. Providers that report rate limiting without the currently recognized quota phrases remain eligible and are selected repeatedly. Normalize the existing rate-limit classifier into this health path and test representative generic 429/rate-limit messages without treating unrelated errors as quota exhaustion.

I appreciate the scope of this feature. The refresh must be truly awaited, settings updates must be atomic, and generic rate limits must participate in the same health block before the fallback chain is reliable.
```

## PR #426 — account-id namespace fallback leaks identifiers into catalog and logs

검증 영수증:

- pinned head: `374313200f8fa20c9e00fe5f918c67372a289381` (ready, 46 files, `+1438/-57`)
- `gh pr diff 426 --repo lidge-jun/opencodex | git apply --check -`: exit 1 — `src/codex/auth-context.ts:24`, `src/codex/routing.ts:66`, `src/server/responses/compact.ts:255`, `src/server/responses/core.ts:120` do not apply to `origin/dev=037e8f5e`

게시할 영어 본문:

```text
Thank you for implementing the account-qualified model picker and the fail-closed exact-account routing requested in #425. I found a privacy blocker in the namespace fallback that must be fixed before this can merge.

`src/codex/account-namespaces.ts:33-36` and `src/codex/account-namespaces.ts:45-56` derive a public namespace from `account.id` whenever the account has no alias. That namespace is then written into catalog model slugs at `src/codex/catalog/sync.ts:276-282` and copied into auth/provider logs at `src/server/responses/core.ts:853-857` and `src/server/responses/core.ts:874-877`. An account added by manual import or OAuth without an alias therefore exposes its internal account identifier through the model catalog and logs, contradicting this PR's stated contract that account ids stay server-side and violating the repository privacy rule against logging account identifiers.

Please never use `account.id`, email, or another credential-derived identifier as a public namespace fallback. Generate a stable non-PII label (the existing random `logLabel` is the closest established primitive), persist it independently from the private binding value, and keep catalog/error/log serialization limited to that safe label. Add regressions that enable namespaces for an alias-less account whose id and email are unique sentinels, then assert neither sentinel appears in the catalog JSON, model display names, error text, or captured logs; also cover add, delete, and reauthentication so stale namespace rows cannot survive account removal or silently rebind to a different identity.

This PR also needs to be rebased on current `dev`. Its auth changes overlap the planned #370 integration in `src/codex/auth-api.ts`, `src/codex/auth-context.ts`, and `src/codex/account-lifecycle.ts`; `src/router.ts` overlaps the planned #389 integration; and `src/types.ts` overlaps the planned #439 integration. The pinned patch already fails `git apply --check` in auth/routing/Responses files, so please re-cut the fix against the integrated contracts rather than restoring stale code.

Because this changes account selection, OAuth-created credential lifecycle, and credential-to-model routing, it is a C4 authentication boundary and requires the explicit maintainer security review mandated by `MAINTAINERS.md`, in addition to focused auth/catalog/privacy regressions and the full typecheck, test, and privacy-scan gates. I appreciate the careful work on exact-account fail-closed behavior; the public namespace must be fully separated from private account identity before review can proceed.
```

감사 메모: provider-name/combo 충돌은 `src/config.ts:449-482`에서 거부되고, 삭제 시 binding 제거는 `src/codex/account-lifecycle.ts:15-30`에 구현되어 있다. `src/config.ts`는 `.passthrough()`를 유지하므로 이 diff만으로 기존 사용자 정의 설정 필드가 유실되는 결함은 확인하지 못했다. 위 코멘트는 재현 가능한 account-id 노출과 미고정 lifecycle 테스트 계약에 한정한다.

## PR #431 — split reasoning emits final text before reasoning; draft rebase/readiness contract

검증 영수증:

- pinned head: `d25eba5b1f329ac77a2a75cce11ce2cf9a8d65d3` (**draft**, 9 files, `+140/-5`)
- `gh pr diff 431 --repo lidge-jun/opencodex | git apply --check -`: exit 0, clean against `origin/dev=037e8f5e`

게시할 영어 본문:

```text
Thank you for keeping this as a draft while adding MiniMax's split-reasoning request capability. Before marking it ready for review, please fix the response-ordering regression and tighten the scope/test contract.

`src/adapters/openai-chat.ts:784-790` emits `text_delta` before `reasoning_raw_delta` when a non-streaming MiniMax response contains both `content` and `reasoning_content`, which is exactly the split response shape described in this PR. The bridge closes the text item when the later reasoning event arrives (`src/bridge.ts:470-542`), so the final answer is materialized before the reasoning item instead of reasoning preceding the answer. The streaming path has the same ordering when both fields share one delta at `src/adapters/openai-chat.ts:683-690`. Please emit non-empty reasoning before final content for both paths and add parser-level regressions for (1) a non-stream response containing both fields, (2) a stream frame containing both fields, (3) empty deltas followed by a finish-only frame, and (4) EOF without `[DONE]`, `finish_reason`, or usage. The last two should preserve the existing no-op and fail-closed behavior rather than treating an interrupted stream as complete.

The current `tests/minimax-reasoning-split.test.ts:38-95` only calls `buildRequest`; it proves `reasoning_split`, effort mapping, and history serialization, but never executes `parseStream` or `parseResponse`, so it cannot catch the response-ordering failure promised by the title. Please make the regression assert emitted adapter-event order, not only request JSON.

I traced the one-line additions in `src/oauth/index.ts:492-499`, `src/oauth/login-cli.ts:86-93`, and `src/server/auth-cors.ts:313-323`. They carry `reasoningSplitModels` through existing provider-config reconciliation, key-login construction, and the safe dashboard DTO; I do not see a new OAuth flow or CORS-origin policy in those hunks. Please explain that propagation in the PR scope and keep it to those whitelist paths, because OAuth/config serialization remains a security-sensitive boundary even when the value itself is only a model-id list.

Although this pinned patch currently passes `git apply --check`, it must be rebased before it becomes ready: `src/providers/registry.ts` overlaps the planned #385/WP7 integration, `src/router.ts` overlaps #389/WP5, and `src/types.ts` overlaps #439/WP3. After rebasing, verify that registry enrichment still preserves explicit user provider fields, run the focused MiniMax parser/request tests, and run the full typecheck and test suite. Thanks again for addressing the visible `<think>` leakage; the draft needs response-side proof and the integrated provider contracts before full review.
```

감사 메모: `src/router.ts:81-86,153-207`은 registry/user 배열을 합집합으로 병합하고 `src/providers/derive.ts`도 기존 값이 없을 때만 seed를 채우므로, 이 diff가 기존 provider 설정을 덮어쓰는 결함은 확인하지 못했다. 빈 delta는 무시되고 terminal 없는 EOF는 `src/adapters/openai-chat.ts:747-754`에서 fail-closed 처리된다. 확인된 결함은 content/reasoning 동시 응답의 event 순서와 해당 parser 계약을 실행하지 않는 테스트 공백이다.

## 게시 전 체크리스트 (WP8에서 사용)

게시 대상은 **11건**이다: #408 #424 #447 #445 #355 #434 #405 #429 #391 #426 #431.

- [ ] 각 PR head가 위 표의 pinned SHA와 같다. 다르면 그 초안을 그대로 게시하지 않고 `STALE`로 재감사한다.
- [ ] draft PR(#429, #431)은 draft 상태를 존중하고 merge 요구 대신 rebase/rework만 요청한다.
- [ ] #408/#424/#447/#445/#355/#426에는 explicit maintainer security review 요구가 포함된다.
- [ ] #434 split boundaries 4개와 defects 3개가 모두 포함된다.
- [ ] #405가 #434에 완전히 포함된 blob 관계를 live diff/blob으로 재확인한다.
- [ ] **rebase 문구를 게시 시점 사실로 갱신한다** (A-gate 라운드3 residual 3). #426과 #431의
      초안은 "planned integration"으로 쓰여 있다. WP1~WP7이 실제로 dev에 통합된 뒤 게시하므로,
      게시 직전 live base/head를 재확인하고 "dev has integrated #370/#389/#439 ..." 형태의
      완료 사실로 바꿔 쓴다. 통합 전에 게시할 경우에만 "planned" 표현을 유지한다.
- [ ] 모든 코멘트가 영어이며 감사 표현, file:line, failure mode, fix, test 계약을 포함한다.
- [ ] #403과 #437에는 아무 코멘트도 게시하지 않는다 (`NO_ACTION`).

## WP8 게시 시점 갱신 (A-gate 반영)

### #426 — STALE, 이번 배치에서 게시하지 않는다

pinned `37431320`에서 live `2ff3e24b`로 head가 바뀌었다(50파일 `+2111/-74`, mergeable=CONFLICTING).
문서의 게시 전 규칙에 따라 **이전 line/diff 기반 초안을 그대로 게시하면 안 된다.** 새 head 전체를
재감사한 뒤 별도로 게시한다. `account.id` namespace fallback 자체는 새 head에서도 남아 있는 것으로
보이지만, 라인 근거가 이동했으므로 초안 재작성이 필요하다.

따라서 이번 게시 대상은 **10건**이다: #408 #424 #447 #445 #355 #434 #405 #429 #391 #431.

### 게시 시점 rebase 완료 문구 (planned → 완료 사실)

dev가 실제로 통합한 것: #370(auth 3파일), #389(`src/router.ts`), #439(`src/types.ts`),
#385(`src/providers/registry.ts`), #436(`src/responses/parser.ts`), #430(`src/adapters/google.ts`),
#449(provider workspace).

| PR | 추가할 문구 |
|---|---|
| #408 | 불필요 |
| #424 | current `dev` now includes #436's validated Responses parser contract in `src/responses/parser.ts` and #439's context-pressure types in `src/types.ts` |
| #447 | current `dev` now includes #439's Kiro/context-pressure changes in `src/adapters/kiro.ts` and `src/types.ts`, and #385's BizRouter registry seed |
| #445 | current `dev` now includes #449's provider-workspace integration in `gui/src/pages/Providers.tsx` and the new dashboard i18n keys |
| #355 | preserve #430's Google empty/malformed-content guards in `src/adapters/google.ts` and the current provider-registry parity contract |
| #434 | re-cut each split from current `dev`, which now includes #389's model visibility/router contracts, #449's provider-workspace changes, and #385's registry seed |
| #405 | current `dev` now includes #385's BizRouter registry entry and expanded registry-parity assertions |
| #429 | 완료 사실 없음. 기존 current-dev re-cut 요구 유지 |
| #391 | current `dev` now includes #439's context-pressure fields in `src/types.ts` |
| #431 | current `dev` now integrated #385 in `src/providers/registry.ts`, #389 in `src/router.ts`, #439 in `src/types.ts` |

### close 순서 (감사 지적)

`dev` push 후 remote `dev`가 `15dfa270`을 포함함을 **확인한 뒤에** 통합 PR과 이슈를 닫는다.
push 전에 닫으면 안 된다.

