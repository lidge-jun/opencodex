# 020 — Open Issue 처분 및 검증

> 스냅샷 `2026-07-25T01:10:40Z` · 기준 `dev` `3fac781f`
> 분류 규칙·처분 전순서·accept criteria는 [`000_plan.md`](./000_plan.md), PR 몫은 [`010_disposition.md`](./010_disposition.md)를 따른다.
> 이 문서는 `lidge-jun/opencodex`의 open issue 22건만 다룬다. 축 1은 항목당 하나의 배타적 primary disposition이고, 축 2는 축 1에서 파생한 사용자 요청 뷰다.

## 축 1 — Issue 처분 (22건)

전순서 `ALREADY_MERGED > CLOSE_MENTION > UPSTREAM_TRACKING > NEEDS_INFO > AWAIT_AUTHOR > REBUILD_ON_DEV > AWAIT_FIX > AWAIT_CI > AWAIT_VALIDATION > AWAIT_REVIEW > DEFER > ROADMAP > MERGE_AFTER_FIX > PR_IN_FLIGHT > FIX_NOW > MERGE`를 위에서부터 처음 맞는 처분에 적용했다. Issue에 실제로 쓰인 처분은 아래 여섯 가지다.

| Issue | 유형 | 라벨 | 연결 PR | 처분 |
|---|---|---|---|---|
| #425 | enhancement | `enhancement` | draft #426 | `PR_IN_FLIGHT` |
| #422 | bug | `bug` | 없음 | `FIX_NOW` |
| #420 | bug | `bug` | #430 | `PR_IN_FLIGHT` |
| #418 | bug | `bug` | 없음 | `NEEDS_INFO` |
| #417 | bug | `bug`, `upstream-tracking` | 없음 | `UPSTREAM_TRACKING` |
| #415 | enhancement | `enhancement` | #416 | `ROADMAP` |
| #414 | enhancement | `enhancement` | #416 | `ROADMAP` |
| #401 | enhancement | `enhancement` | 없음 | `NEEDS_INFO` |
| #399 | bug | `bug` | #402 (`6f4cd1d6bf`) | `DEFER` |
| #386 | enhancement | `enhancement` | 없음 | `ROADMAP` |
| #374 | enhancement | `enhancement` | #391 | `PR_IN_FLIGHT` |
| #373 | bug | `bug` | #376 | `PR_IN_FLIGHT` |
| #357 | enhancement | `enhancement` | #392 | `PR_IN_FLIGHT` |
| #330 | enhancement | `enhancement` | 없음 | `ROADMAP` |
| #294 | enhancement | `enhancement`, `roadmap` | 없음 | `DEFER` |
| #241 | bug | `bug`, `upstream-tracking` | 없음 | `UPSTREAM_TRACKING` |
| #201 | enhancement | `enhancement`, `roadmap` | 없음 | `DEFER` |
| #178 | enhancement | `enhancement`, `roadmap` | 없음 | `ROADMAP` |
| #177 | enhancement | `enhancement`, `roadmap` | 없음 | `DEFER` |
| #95 | enhancement | `enhancement`, `roadmap` | 없음 | `ROADMAP` |
| #92 | bug | `bug`, `upstream-tracking` | #94 | `UPSTREAM_TRACKING` |
| #42 | enhancement | `enhancement`, `roadmap` | 없음 | `ROADMAP` |

### FIX_NOW (1건)

#### #422 — API-key `openai-responses` remote compaction v2 fatal

- 유형: bug
- 라벨: `bug`
- 연결된 PR/커밋: 없음
- 원인 근거: `resolveAdapter()`가 `authMode`와 무관하게 모든 `openai-responses`를 passthrough로 고른다(`src/server/adapter-resolve.ts:27-35`). 해당 adapter는 언제나 `passthrough: true`다(`src/adapters/openai-responses.ts:521-525`). V2는 non-passthrough에서만 synthetic compaction을 실행하고(`src/server/responses/core.ts:973-983`) passthrough에서는 raw body를 그대로 보낸다(`src/server/responses/core.ts:986-1008`). V1도 같은 오분기를 쓴다(`src/server/responses/compact.ts:205-250`; 다른 adapter의 synthetic 경로는 `src/server/responses/compact.ts:305-339`). 따라서 제보자가 지적한 원인은 확인됐다.
- 처분별 추가 증거: 기존 `tests/responses-compaction.test.ts:99-157`은 bridge shape만 검증하고 route 선택을 검증하지 않는다. `supportsNativeResponsesCompaction(provider)`는 `adapter === "openai-responses" && authMode === "forward"`일 때만 true여야 한다. `authMode`는 `"key" | "forward" | "oauth" | "local"`이고 미지정은 key다(`src/types.ts:721-794`). 다만 predicate만 바꾸면 부족하다. passthrough가 `parsed._rawBody`로 요청을 만들고(`src/adapters/openai-responses.ts:526-567`) stream parser가 없기 때문이다(`src/adapters/openai-responses.ts:588-590`). 정상 트래픽의 passthrough는 유지하고 compaction만 전용 실행 경로로 보내야 한다. blanket adapter switch는 LiteLLM/Bifrost/vLLM의 raw-field 보존과 key-mode `previous_response_id` 처리(`src/adapters/openai-responses.ts:445-459`)를 깨뜨린다.

### PR_IN_FLIGHT (5건)

#### #420 — Antigravity message content serialization

- 유형: bug
- 라벨: `bug`
- 연결된 PR/커밋: PR #430
- 원인 근거: **보고된 경로의 serializer를 Anthropic으로 지목한 제보자 및 최초 분석은 잘못됐다.** `google-antigravity`는 `adapter: "google"`, `googleMode: "cloud-code-assist"`로 등록된다(`src/providers/registry.ts:665`). adapter resolver가 Anthropic을 고르는 경우는 `adapter: "anthropic"`뿐이다(`src/server/adapter-resolve.ts:27-36`). 실제 경로는 `messagesToGeminiFormat()`(`src/adapters/google.ts:217-223`)과 CCA envelope(`src/adapters/google.ts:243-301`)이며, Antigravity upstream이 Anthropic-shaped 400을 반환한다.
- 처분별 추가 증거: PR #430은 보고된 경로를 전부 다룬다. `geminiTextPart()`가 `typeof text === "string" && text.length > 0`이 아닌 값을 버리므로 중첩 객체가 upstream에 도달하지 않으며 `tests/google-empty-content.test.ts`에 12개 회귀 테스트가 있다. 공용 방어선의 약점은 남는다. 느슨한 fallback(`src/responses/schema.ts:87-97`)은 malformed `{type:"message"}`를 허용하고 `inputContentParts()`는 `block.text`를 검사 없이 복사한다(`src/responses/parser.ts:36-37`). `outputTextOf()`(`src/responses/parser.ts:59-66`)와 Anthropic 직접 경로(`src/adapters/anthropic.ts:26-35,392-395`)의 후속 보강은 선택 사항이며 #420을 `FIX_NOW`로 바꾸는 근거가 아니다.

#### #425 — Codex account namespaces

- 유형: enhancement
- 라벨: `enhancement`
- 연결된 PR/커밋: draft PR #426
- 원인 근거: issue가 요청한 계정별 model namespace는 draft PR #426에서 catalog/router/auth-context/compact/HTTP/SSE/WS 경로로 구현 중이다([issue #425](https://github.com/lidge-jun/opencodex/issues/425), [PR #426](https://github.com/lidge-jun/opencodex/pull/426)).
- 처분별 추가 증거: 범위는 넓지만 dashboard controls를 의도적으로 제외했고 standalone image/search relay는 global로 남는다. account-bound real-machine smoke test도 아직 없다. credential/account selection 경계를 바꾸므로 `MAINTAINERS.md`에 따른 security review가 필수다.

#### #373 — Cursor restart 뒤 output-only context telemetry

- 유형: bug
- 라벨: `bug`
- 연결된 PR/커밋: PR #376
- 원인 근거: `CursorContextUsageTracker`의 checkpoint는 in-memory `Map`뿐이다(`src/adapters/cursor/protobuf-events.ts:31-73`). checkpoint `usedTokens`는 absolute로 처리되고(`src/adapters/cursor/protobuf-events.ts:356-362`), `tokenDelta`는 output만 늘린다(`src/adapters/cursor/protobuf-events.ts:421-425`). restart 뒤 checkpoint/carry가 없으면 finalization이 `inputTokens: 0`을 반환한다(`src/adapters/cursor/protobuf-events.ts:437-454`). 제보자가 지적한 원격 측정 실패는 확인됐다.
- 처분별 추가 증거: PR #376은 checkpoint/carry가 없을 때 model-visible pruned payload를 추정하고 checkpoint 우선순위를 보존해 reported failure를 막는다. checkpoint persistence는 추가하지 않아 totals는 추정치로 남는다. PR #376은 review `2026-07-24T07:02:06Z` 뒤 author push가 `2026-07-24T04:28:11Z`에 멈춰 PR 축에서는 `AWAIT_AUTHOR`다([PR #376](https://github.com/lidge-jun/opencodex/pull/376)).

#### #374 — subagent model fallback chain

- 유형: enhancement
- 라벨: `enhancement`
- 연결된 PR/커밋: PR #391
- 원인 근거: PR #391이 global/per-agent chains, native quota polling, routed failure TTL, spawn rewriting, management API를 구현한다([issue #374](https://github.com/lidge-jun/opencodex/issues/374), [PR #391](https://github.com/lidge-jun/opencodex/pull/391)).
- 처분별 추가 증거: third-party `quota polling`은 provider quota API가 아니라 recent-failure health이므로 문서에 이 의미를 밝혀야 한다. PR #391은 3개 플랫폼 CI에서 `tests/subagent-model-fallback.test.ts:96:28`이 실패하며 expected `"kimi/k3"`, received `"gpt-5.6-sol"`이다(run `30119868825`). Issue는 PR이 커버하므로 `PR_IN_FLIGHT`, PR 자체는 전순서상 `AWAIT_AUTHOR`다.

#### #357 — external aggregated model API

- 유형: enhancement
- 라벨: `enhancement`
- 연결된 PR/커밋: PR #392
- 원인 근거: `/v1/chat/completions`는 이미 `src/server/index.ts:564`와 `src/server/chat-completions.ts`에 있다. PR #392는 endpoint/auth guidance, external catalog, copy/test UX, translations를 보강한다([issue #357](https://github.com/lidge-jun/opencodex/issues/357), [PR #392](https://github.com/lidge-jun/opencodex/pull/392)).
- 처분별 추가 증거: 적용 범위는 설계상 일부다. key scopes, expiration, limits, per-key usage, richer SDK examples, robust remote-auth testing은 범위 밖이다. 이 공백을 후속 범위로 남겨야 한다.

### NEEDS_INFO (2건)

#### #418 — custom-parent → custom-child V2 delegation

- 유형: bug
- 라벨: `bug`
- 연결된 PR/커밋: 없음
- 원인 근거: 제보자가 회수한 client error는 `failed to parse function arguments: missing field \`message\` at line 1 column 2`지만 같은 실행의 raw `spawn_agent` trace가 없다. control capture에서는 보통 tool arguments가 유지됐고, 2.7.33 capture에서는 custom upstream이 zero-byte `spawn_agent` arguments를 반환했다([issue #418](https://github.com/lidge-jun/opencodex/issues/418)). 현재 parser는 empty/non-JSON historical arguments를 허용한다(`src/responses/parser.ts:405-410`). OpenCodex defect 여부는 unverified다.
- 처분별 추가 증거: 같은 실행에서 얻은 redacted trace 하나를 요청한다. 그 한 trace에는 (1) raw upstream `spawn_agent` name/arguments/finish reason, (2) emitted `response.output_item.*`와 `response.function_call_arguments.*`, (3) Codex child-created/child-completed notifications가 모두 있어야 한다. #92는 native-parent→routed-child ciphertext loss이고 #418은 custom-parent structured emission/lifecycle이므로 duplicate가 아니다.

#### #401 — voice chat model 변경

- 유형: enhancement
- 라벨: `enhancement`
- 연결된 PR/커밋: 없음
- 원인 근거: 요청 대상은 text-model routing이 아니라 `/v1/live` bidirectional realtime transport다([issue #401](https://github.com/lidge-jun/opencodex/issues/401), `src/server/index.ts:150-179,675-699`).
- 처분별 추가 증거: 지원을 원하는 provider/model 이름과 그 provider가 공개한 realtime audio/event API 문서를 요청한다. 이 둘이 없으면 adapter contract와 이벤트 호환성을 검증할 수 없다.

### UPSTREAM_TRACKING (3건)

#### #417 — Korean realtime U+FFFD

- 유형: bug
- 라벨: `bug`, `upstream-tracking`
- 연결된 PR/커밋: 없음
- 원인 근거: `attachLiveSidebandUpstream()`은 upstream frame을 변경 없이 relay하고(`src/server/index.ts:150-179`) client frame도 그대로 전달한다(`src/server/index.ts:675-699`). Korean/binary/fragmented frame 회귀 범위는 `tests/server-live.test.ts:606-721`에 있다. issue의 direct GA Realtime 검증은 25/25 clean transcript다([issue #417](https://github.com/lidge-jun/opencodex/issues/417)). 로컬 릴레이 결함이 아니라는 점은 확인됐다.
- 처분별 추가 증거: upstream tracker는 [openai/codex#35161](https://github.com/openai/codex/issues/35161)이다. 실제 frame-log capture로 corruption이 upstream 진입 전인지 relay 뒤 Desktop 단계인지 확인될 때까지 추적을 유지한다.

#### #241 — Desktop picker의 routed model 누락

- 유형: bug
- 라벨: `bug`, `upstream-tracking`
- 연결된 PR/커밋: 없음
- 원인 근거: ocx는 root `model_catalog_json`을 쓴다(`src/codex/inject.ts:378-487`). catalog sync는 routed models를 `"list"`로 둔다(`src/codex/catalog/sync.ts:87-109,163-208`). 소스에는 `use_hidden_models`나 `available_models` 재정의가 없다. Desktop 자체 remote allowlist라는 판정은 확인됐다([issue #241](https://github.com/lidge-jun/opencodex/issues/241)).
- 처분별 추가 증거: workaround는 Codex CLI/config에서 routed model을 선택하는 것이며, 지원되는 ocx-side 재정의는 없다. Desktop이 native-only allowlist를 없애거나 local 재정의를 공개하면 재평가한다.

#### #92 — V2 cross-provider NEW_TASK ciphertext loss

- 유형: bug
- 라벨: `bug`, `upstream-tracking`
- 연결된 PR/커밋: PR #94, commit `b6281b7a`
- 원인 근거: proxy는 Fernet ciphertext를 복호화할 수 없다. 감지는 `src/server/responses/core.ts:638-640`, plaintext-only rewrite는 `src/server/responses/core.ts:645-657`, opaque representation은 `src/responses/parser.ts:193-203`에 있다. 제보자가 지적한 제공자 간 손실은 확인됐다([issue #92](https://github.com/lidge-jun/opencodex/issues/92)).
- 처분별 추가 증거: PR #94는 encrypted slot에 들어온 다른 plaintext shape만 고쳤다. upstream tracker는 [openai/codex#32453](https://github.com/openai/codex/issues/32453)이고 관련 commit은 `b6281b7a`다. V1이 문서화된 reliable workaround다.

### ROADMAP (7건)

#### #415 — search-API-capable sidecar backend 조사

- 유형: enhancement
- 라벨: `enhancement`
- 연결된 PR/커밋: PR #416, commits `6a0f5b5dd254b9548793c8ea37198a669d377669`, `92a1e5ae6231471850b8f92fce2a923acff91944`
- 원인 근거: 현재 backend seam은 `resolveSidecarBackend()`/`SidecarPlan`(`src/web-search/index.ts:102`)이고 config union은 두 값뿐이다(`src/types.ts:678`). seam은 #416이 아니라 commit `92a1e5ae6231471850b8f92fce2a923acff91944`에서 들어왔다.
- 처분별 추가 증거:
  - 선행조건: PR #416이 `6a0f5b5dd254b9548793c8ea37198a669d377669`로 병합되어 #415가 보존할 bounded fail-open degradation contract를 제공한다.
  - 소유자: 메인테이너 @lidge-jun. 이슈와 PR #416을 모두 작성했다.
  - 완료조건: Gemini 또는 다른 search API용 sidecar 실행기가 확장된 `OcxWebSearchSidecarConfig.backend` union에서 선택되고, citation이 `SidecarOutcome`에 매핑되며, 백엔드별 timeout/cancellation/redaction 회귀 테스트가 통과한다.
  - 잔존게이트: capability matrix 작성; 후보별 auth/quota/citation/streaming/error contract 검증; credential resolution과 executor dispatch 추가; bounded fail-open degradation 보존; credential security review.

#### #414 — Exa sidecar backend

- 유형: enhancement
- 라벨: `enhancement`
- 연결된 PR/커밋: PR #416, commit `6a0f5b5dd254b9548793c8ea37198a669d377669`
- 원인 근거: 확장 지점은 두 값짜리 backend union(`src/types.ts:678`)과 기존 `SidecarOutcome` contract다. #416의 fail-open 동작은 `src/web-search/index.ts:19`와 `src/web-search/loop.ts:428`에 있다.
- 처분별 추가 증거:
  - 선행조건: PR #416이 `6a0f5b5dd254b9548793c8ea37198a669d377669`로 병합되어 60s default와 redacted failed-tool-result conversion을 각각 `src/web-search/index.ts:19`, `src/web-search/loop.ts:428`에 제공한다.
  - 소유자: @lidge-jun.
  - 완료조건: Exa 실행기가 config로 선택되고 기존 `SidecarOutcome` 형식을 내며, 자격 증명 해석과 백엔드별 timeout/cancellation/redaction/degradation 회귀 테스트가 통과한다.
  - 잔존게이트: Exa credential/config schema; `src/types.ts:678`의 backend union 확장; full typecheck/test/privacy scan; docs; API-key persistence security review.

#### #386 — packaged macOS menu bar companion

- 유형: enhancement
- 라벨: `enhancement`
- 연결된 PR/커밋: commit `93b8b638b34c0374db681feb3912b96e57266f0b`, branch head `e81d0db0d1080273d785d4b20190409451273af7`; closed PR #387/#421은 설계 입력
- 원인 근거: `devlog/_plan/260725_macos_menubar_app/000_plan.md`가 실행 계획이다. #387의 실제 close 이유는 반복적인 `ocx status --json` subprocess 대신 HTTP management API architecture로 통합했기 때문이다. closed #387/#421은 prerequisite가 아니다.
- 처분별 추가 증거:
  - 선행조건: 브랜치 `feat/macos-app`의 계획 커밋 `93b8b638b34c0374db681feb3912b96e57266f0b`과 `devlog/_plan/260725_macos_menubar_app/000_plan.md`; 현재 로컬/원격 브랜치 head는 `e81d0db0d1080273d785d4b20190409451273af7`다.
  - 소유자: @lidge-jun이 #387/#421을 닫고 통합했다. 수락 기록이 없는 @jaycho46와 @genglintong은 확정 소유자가 아니라 제안 검토자다. 제안 검토 범위에서 @jaycho46는 기존 Swift/SwiftPM 패키징을, @genglintong은 채택한 HTTP 관리 API 설계를 검토한다.
  - 완료조건: `feat/macos-app`에서 `dev`로 향하는 PR이 병합되고, 실제 GitHub 릴리스에 `.zip`과 `.sha256` 파일이 첨부되며, `lipo`가 universal binary임을 확인한다.
  - 잔존게이트: `dev` 대상 PR; `.github/workflows/release.yml` explicit security review; exact-head root tests/privacy scan/Swift tests/macOS build; `lipo` universal binary 증명; signing/archive 검증; 실제 release에 `.zip`과 `.sha256` 첨부.

#### #330 — session correlation 기반 로그 합계

- 유형: enhancement
- 라벨: `enhancement`
- 연결된 PR/커밋: 없음
- 원인 근거: `RequestLogContext`에는 correlation field가 없고(`src/server/request-log.ts:31`), `PersistedUsageEntry`에도 없다(`src/usage/log.ts:34`). 현재 filtering 경계는 `src/server/request-log.ts:619`다. maintainer comment `5057057078`이 best-effort non-secret conversation/session correlation ID를 Phase 1로 확정했다.
- 처분별 추가 증거:
  - 선행조건: issue #330의 Phase 1인 best-effort non-secret conversation/session correlation ID persistence가 구현되고 병합된다. 구현 PR은 아직 없다.
  - 소유자: @Ingwannu가 schema/privacy 승인을, @jhste102lab가 Phase 1/2 명세를 맡는다.
  - 완료조건: Logs UI가 세션별 token 및 estimated-cost 합계를 표시하고, unpriced/unmetered 제외 건수를 명시한다.
  - 잔존게이트: aggregation scope를 200-entry in-memory window와 persisted usage 중에서 결정; optional correlation field를 `RequestLogContext`, `RequestLogEntry`, `/api/logs`, `PersistedUsageEntry`에 전달하고 backward-compat tests 추가; unsafe fallback 금지. Claude system-hash fallback은 session identity가 아니다(`src/server/claude-messages.ts:631`). Cursor continuity는 별도다(`src/adapters/cursor/request-builder.ts:176`).

#### #178 — Factory execution backend

- 유형: enhancement
- 라벨: `enhancement`, `roadmap`
- 연결된 PR/커밋: 없음
- 원인 근거: Factory 공식 계약은 Droid Exec `stream-jsonrpc`로 sessions, streamed text/tool/usage events, permission/question requests, interruption, `FACTORY_API_KEY`를 문서화한다([issue #178](https://github.com/lidge-jun/opencodex/issues/178)). 이는 HTTP model registry가 아니라 process-backed agent execution contract다.
- 처분별 추가 증거:
  - 선행조건: Factory 공식 문서에 stream-JSON-RPC 계약이 공개되고, 저장소에는 메인테이너의 범위 결정이 기록된다(issue #178 comment `5042693481`).
  - 소유자: @lidge-jun이 아키텍처를 맡는다. 수락 기록이 없는 @ardjo-s는 확정 소유자가 아니라 인수 시험 제안 검토자다.
  - 완료조건: Factory Droid가 실행 백엔드로 선택 가능하고 permission/question 처리와 cancellation을 지원하며 cross-platform process tests가 통과한다.
  - 잔존게이트: process-backed execution abstraction, lifecycle supervision, session mapping, JSON-RPC correlation, permission/question UI, cancellation/crash cleanup, model discovery, working-directory policy, Codex Responses semantics 매핑 결정; cross-platform process tests와 real-account tests 뒤 GUI 노출.

#### #95 — multi-user proxy

- 유형: enhancement
- 라벨: `enhancement`, `roadmap`
- 연결된 PR/커밋: 없음
- 원인 근거: remote admission은 caller `Authorization`과 별개로 `x-opencodex-api-key`를 요구한다(`src/server/auth-cors.ts:120,178`). ChatGPT header forwarding은 `src/adapters/openai-responses.ts:9`에 있다. admission separation은 있지만 tenant boundary는 없다.
- 처분별 추가 증거:
  - 선행조건: #330 Phase 1 correlation instrumentation이 구현되고 병합된다.
  - 소유자: @lidge-jun이 tenant/security architecture, @Wibias가 client/proxy validation, @rafalkwol이 LAN/VPN acceptance environment를 맡는다(comment `5042694805`).
  - 완료조건: 인증된 tenant identity, tenant-scoped policy, 격리된 logs/usage가 구현되고 multi-account LAN/VPN 부하에서 cross-user state leakage가 없음이 검증된다.
  - 잔존게이트: tenant-scoped authorization/model policy; management/log/usage isolation; reverse proxy/SSO trusted attribution; concurrency/resource limits; TLS/reverse-proxy docs. Cursor continuity의 namespace(`src/server/responses/core.ts:857`, `src/adapters/cursor/thread-continuity.ts:30`)는 tenant boundary가 아니다.

#### #42 — Storage cleanup lifecycle

- 유형: enhancement
- 라벨: `enhancement`, `roadmap`
- 연결된 PR/커밋: commit `24d8bbb9df3433f74ab097528d82a04ed4bcb7a7`
- 원인 근거: `devlog/_plan/500_storage-page-session-cleanup/10_epic_plan.md`는 read-only Phase 1, C4 Phase 2 cleanup, Phase 3 policy를 분리한다. Phase 1 scanner는 `src/storage/scanner.ts:17`, endpoint는 `src/server/management/logs-usage-routes.ts:162`, page는 `gui/src/pages/Storage.tsx:114`다.
- 처분별 추가 증거:
  - 선행조건: `devlog/_plan/500_storage-page-session-cleanup/10_epic_plan.md`; Phase 1은 commit `24d8bbb9df3433f74ab097528d82a04ed4bcb7a7`로 `dev`에 반영되어 scanner/API/page를 각각 `src/storage/scanner.ts:17`, `src/server/management/logs-usage-routes.ts:162`, `gui/src/pages/Storage.tsx:114`에 제공한다.
  - 소유자: 메인테이너가 destructive session lifecycle인 Phase 2/3을, @Chang-Jin-Lee가 Phase 1을 맡는다.
  - 완료조건: Phase 2 수동 cleanup이 quarantine/restore와 preview-first confirmation을 포함해 출시되고, interrupted/partial-failure cleanup에서도 안전하며 활성 세션을 read-only로 유지함이 검증된다.
  - 잔존게이트: rollout JSONL, `state_5.sqlite` thread rows, attachments, manifests, WAL/SHM locks를 포괄하는 Phase 2 data model; high-risk maintainer review; Phase 2 보장을 상속하는 opt-in Phase 3(`devlog/_plan/500_storage-page-session-cleanup/10_epic_plan.md:43`).

### DEFER (4건)

#### #399 — Cursor native-tool mismatch와 false blocked report

- 유형: bug
- 라벨: `bug`
- 연결된 PR/커밋: PR #402, merged at `2026-07-25T01:32:12Z`, merge SHA `6f4cd1d6bf`
- 원인 근거: issue가 열거한 다섯 원인에 대한 coverage는 `3/5 fully covered + cause 5 partially mitigated; cause 1 intentionally unchanged`다. 원인 1의 native Shell/Read/Grep/LS policy rejection은 의도적으로 유지되고, 원인 5의 false `blocked` prose는 deterministic output filter가 없어 확률적으로만 줄었다([issue #399](https://github.com/lidge-jun/opencodex/issues/399), [PR #402](https://github.com/lidge-jun/opencodex/pull/402)).
- 처분별 추가 증거:
  - defer근거: PR #402의 수정은 병합됐지만 원인 1은 의도된 동작이고 원인 5는 확률적으로만 완화됐다. 전체 해결로 닫으면 coverage를 과장하며, 현재 증거만으로 별도 후속 구현 범위를 확정할 수 없다.
  - 재평가: merge SHA `6f4cd1d6bf`가 반영된 버전에서 false `blocked` report가 재현되고, native policy rejection과 구별되는 trace 또는 deterministic filter 요구사항이 확보될 때.

#### #177 — Warp agent execution backend

- 유형: enhancement
- 라벨: `enhancement`, `roadmap`
- 연결된 PR/커밋: 없음
- 원인 근거: Warp의 Oz API/SDK는 이제 공식 문서화되어 있다([API/SDK quickstart](https://docs.warp.dev/reference/api-and-sdk/quickstart), [CLI](https://docs.warp.dev/reference/cli)). 다만 async Oz API와 supervised local `oz` CLI 중 어느 실행 경계를 택할지 정한 저장소 아키텍처 아티팩트는 아직 없다.
- 처분별 추가 증거:
  - defer근거: no repository architecture artifact exists yet for the Oz execution-backend decision.
  - 재평가: when an architecture issue or plan choosing between the async Oz API and supervised local `oz` CLI is filed.

#### #294 — Claude account pool

- 유형: enhancement
- 라벨: `enhancement`, `roadmap`
- 연결된 PR/커밋: 없음
- 원인 근거: multi-account OAuth storage는 `src/oauth/store.ts:1`에 있지만 normal routing은 `getValidAccessTokenSnapshot()`에서 `activeAccountId`만 고른다(`src/oauth/index.ts:215-218`). quota/affinity/cooldown engine은 Codex 전용이다(`src/codex/routing.ts:25`).
- 처분별 추가 증거:
  - defer근거: maintainer comment `5056442347`은 Claude rotation의 account restriction 위험, Anthropic의 organization/tier limits, 서로 다른 OAuth lifecycle을 active blocker로 기록한다. 현재 repo groundwork만으로 안전한 자동 rotation contract를 만들 수 없다.
  - 재평가: Anthropic이 machine-readable per-account/per-org quota와 reset semantics를 포함한 supported multi-account automation contract를 공개하거나, 승인된 repo design이 Claude 전용 health/affinity/cooldown/ToS constraints와 real multi-account tests를 정의할 때.

#### #201 — TRAE International provider

- 유형: enhancement
- 라벨: `enhancement`, `roadmap`
- 연결된 PR/커밋: 없음
- 원인 근거: maintainer comment `5042693335`는 reverse-engineered internals 없이 쓸 수 있는 TRAE International auth/refresh/inference transport가 문서화되지 않았다고 기록한다. trae.ai enterprise page는 CLI를 `coming soon`으로 표시하고, `bytedance/trae-agent`는 trae.ai subscription transport가 아니라 사용자 third-party model key를 요구한다([issue #201](https://github.com/lidge-jun/opencodex/issues/201)).
- 처분별 추가 증거:
  - defer근거: 공식 international login/token-refresh와 machine transport가 없어 구현이 private protocol reverse engineering에 의존한다(comment `5042693335`).
  - 재평가: trae.ai가 advertised international CLI와 documented login/token-refresh 및 machine transport를 출시하거나 sanctioned API/SDK 또는 international ACP server를 문서화할 때. trae.cn에만 공개된 계약은 조건을 충족하지 않는다.

## 버그 검증 결과

| Issue | 제보 내용 | 소스에서 확인되는 사실 | 판정 |
|---|---|---|---|
| #422 | API-key `openai-responses`도 native compaction passthrough로 잘못 분기한다. | resolver가 `authMode`를 무시하고(`src/server/adapter-resolve.ts:27-35`) V1/V2가 passthrough raw body를 보낸다(`src/server/responses/compact.ts:205-250`, `src/server/responses/core.ts:973-1008`). | **confirmed** |
| #420 | Anthropic serializer가 `text.text`를 만들었다. | **보고된 경로는 Google adapter다. Anthropic 경로로 귀속한 분석은 잘못됐다.** registry와 resolver가 이를 확정한다(`src/providers/registry.ts:665`, `src/server/adapter-resolve.ts:27-36`). 다만 느슨한 schema와 검증하지 않은 `block.text`는 공용 취약점이다(`src/responses/schema.ts:87-97`, `src/responses/parser.ts:36-37`). | **reporter root cause wrong; symptom confirmed** |
| #92 | V2 cross-provider NEW_TASK가 encrypted content에서 사라진다. | proxy가 감지할 수는 있어도 Fernet ciphertext를 복호화하지 못해 plaintext rewrite만 가능하다(`src/server/responses/core.ts:638-657`, `src/responses/parser.ts:193-203`). | **confirmed, upstream** |
| #399 | Cursor tool-name/policy mismatch가 false blocked report를 만든다. | PR #402가 `2026-07-25T01:32:12Z`에 merge SHA `6f4cd1d6bf`로 병합됐다. Coverage는 `3/5 fully covered + cause 5 partially mitigated; cause 1 intentionally unchanged`다([PR #402](https://github.com/lidge-jun/opencodex/pull/402)). | **partially confirmed / partial coverage** |
| #373 | restart 뒤 input context가 0으로 보고된다. | checkpoint가 memory-only이고(`src/adapters/cursor/protobuf-events.ts:31-73`) fallback finalization이 `inputTokens: 0`을 낸다(`src/adapters/cursor/protobuf-events.ts:437-454`). | **confirmed** |
| #418 | ocx가 custom-parent의 `spawn_agent` arguments를 손상한다. | same-run raw trace가 없고, 과거 capture는 upstream zero-byte arguments를 보였다. parser는 empty/non-JSON history를 허용한다(`src/responses/parser.ts:405-410`). | **unverified** |
| #241 | ocx catalog injection 실패로 Desktop picker에서 routed model이 사라진다. | ocx는 root catalog를 쓰고 routed model을 `"list"`로 둔다(`src/codex/inject.ts:378-487`, `src/codex/catalog/sync.ts:87-109,163-208`). Desktop allowlist가 원인이다. | **reporter local attribution wrong; upstream confirmed** |
| #417 | ocx realtime relay가 Korean U+FFFD를 만든다. | frames는 양방향 그대로 전달되고(`src/server/index.ts:150-179,675-699`) Korean/binary/fragmented tests가 있다(`tests/server-live.test.ts:606-721`). direct GA는 25/25 clean이었다([issue #417](https://github.com/lidge-jun/opencodex/issues/417)). | **reporter local attribution wrong; upstream stage unresolved** |

## 버그 영향도 순위

1. **#422** — API-key gateway 전반에서 long-thread compaction을 결정적으로 깨뜨리고, 복구하려면 model을 바꿔야 한다.
2. **#420** — Antigravity의 core message flow가 malformed content 하나로 400이 되지만 PR #430이 reported route를 전부 막는다.
3. **#92** — V2 cross-provider subagent의 NEW_TASK 본문이 사라져 delegation 핵심 흐름을 깨뜨리며 reliable workaround는 V1 전환뿐이다.
4. **#399** — Cursor tool execution과 상태 보고의 신뢰도를 넓게 떨어뜨린다. PR #402가 병합됐지만 coverage는 `3/5 fully covered + cause 5 partially mitigated; cause 1 intentionally unchanged`다.
5. **#373** — restart 뒤 context telemetry가 틀려 운영 판단을 흐리지만 실제 요청 실행은 계속되고 PR #376의 추정 fallback이 있다.
6. **#418** — delegation 실패면 영향은 크지만 defect 귀속이 unverified이고 추가 same-run trace가 필요하다.
7. **#241** — Desktop picker discoverability가 깨지지만 CLI/config 선택 workaround가 있어 routed model 실행 자체는 가능하다.
8. **#417** — local relay 결함이 재현되지 않았고 direct GA 25/25가 clean이라 현재 OpenCodex가 고칠 수 있는 영향이 가장 낮다.

## Issue↔PR 커버리지 갭

| Issue | PR | coverage | 남은 gap / gate |
|---|---|---|---|
| #422 | 없음 | 0% | compaction-only execution path, auth-mode predicate, key/oauth/local route tests가 필요하다. |
| #420 | #430 | reported route **FULL** | direct Anthropic 공용 parser hardening은 defense-in-depth 후속이며 issue close blocker는 아니다. |
| #425 | draft #426 | broad, partial | dashboard controls 제외, standalone image/search relay global 유지, real-machine account-bound smoke 미실행, security review 필요. |
| #399 | #402 (`6f4cd1d6bf`) | `3/5 fully covered + cause 5 partially mitigated; cause 1 intentionally unchanged` | native Shell/Read/Grep/LS policy rejection 유지, false `blocked` prose에 deterministic filter 없음. |
| #373 | #376 | reported telemetry failure covered | checkpoint는 restart를 넘어 persist되지 않아 totals가 estimate로 남고 author response가 필요하다. |
| #374 | #391 | broad | third-party quota는 recent-failure health라는 문서 정정과 `tests/subagent-model-fallback.test.ts:96:28` 실패 수리가 필요하다. |
| #357 | #392 | partial by design | key scopes/expiration/limits/per-key usage, SDK examples, robust remote-auth tests가 없다. |

## 재분류 및 정정 기록

- **#177 `DEFER` → `ROADMAP` → `DEFER`:** Warp의 공식 Oz API/SDK quickstart와 local `oz` CLI 문서 공개로 “문서화된 계약 없음”이라는 기존 근거는 폐기했다([API/SDK](https://docs.warp.dev/reference/api-and-sdk/quickstart), [CLI](https://docs.warp.dev/reference/cli)). 그러나 async Oz API와 supervised local `oz` CLI 중 하나를 고른 저장소 아키텍처 아티팩트가 없어 `ROADMAP`의 검증 가능한 선행조건 규칙을 충족하지 못하므로 다시 `DEFER`로 분류했다.
- **#399 `PR_IN_FLIGHT` → `DEFER`:** PR #402가 `2026-07-25T01:32:12Z`에 merge SHA `6f4cd1d6bf`로 병합되어 진행 중 PR은 더는 없다. 하지만 coverage가 `3/5 fully covered + cause 5 partially mitigated; cause 1 intentionally unchanged`이므로 `CLOSE_MENTION`은 해결 범위를 과장하고, 재현 가능한 후속 요구사항이 생길 때까지 `DEFER`가 전순서상 맞다.
- **#420 adapter path 정정:** reported route는 Anthropic serializer가 아니라 `google-antigravity` → Google CCA 경로다(`src/providers/registry.ts:665`, `src/adapters/google.ts:217-301`). PR #430이 이 경로를 FULL coverage하므로 primary disposition은 `PR_IN_FLIGHT`다.
- **PR #416 seam 귀속 정정:** `resolveSidecarBackend()`/`SidecarPlan`(`src/web-search/index.ts:102`)은 #416이 아니라 commit `92a1e5ae6231471850b8f92fce2a923acff91944`에서 도입됐다. #416 (`6a0f5b5dd254b9548793c8ea37198a669d377669`)은 bounded fail-open degradation contract를 제공한다.

## 멘션클로즈

22건 중 `CLOSE_MENTION`은 **없다**. merged fix SHA로 완전히 해결된 open issue, exact duplicate, definitive out-of-scope policy가 확인된 항목이 없다. #418은 #92와 failure boundary가 달라 duplicate가 아니고, #386은 #387이 닫혔어도 HTTP management API architecture로 통합된 유효한 roadmap이다. 그러므로 설명 코멘트와 함께 즉시 닫을 근거도 없다.

## 축 2 — 사용자 요청 6개 뷰 중 이슈 몫

축 2는 축 1의 처분을 다시 분류한 파생 뷰다. 뷰 사이 중복 가능성은 축 1의 배타성을 깨지 않는다.

| 뷰 | 파생 규칙 | 이슈 몫 |
|---|---|---|
| 1. 이슈 처리 | open issue 전부를 primary disposition별로 제시 | `FIX_NOW`: #422 · `PR_IN_FLIGHT`: #425 #420 #374 #373 #357 · `NEEDS_INFO`: #418 #401 · `UPSTREAM_TRACKING`: #417 #241 #92 · `ROADMAP`: #415 #414 #386 #330 #178 #95 #42 · `DEFER`: #399 #294 #201 #177 |
| 2. Wibias 완료 선언 PR | PR 전용 | 이슈 몫 없음. `010_disposition.md` 참조. |
| 3. 그럴만한 개선 | `MERGE ∪ MERGE_AFTER_FIX ∪ FIX_NOW` | #422 |
| 4. 차후 개선 | `ROADMAP ∪ REBUILD_ON_DEV` | #415 #414 #386 #330 #178 #95 #42 |
| 5. defer가 맞는 개선 | `DEFER` | #399 #294 #201 #177 |
| 6. 멘션클로즈 | `CLOSE_MENTION` | 없음 |

집합 검산: `{425,422,420,418,417,415,414,401,399,386,374,373,357,330,294,241,201,178,177,95,92,42}`로 스냅샷 22건과 일치하며, 각 번호는 축 1에서 정확히 한 번만 배치됐다.
