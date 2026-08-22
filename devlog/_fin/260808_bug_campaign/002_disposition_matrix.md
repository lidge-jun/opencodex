# 002 — 처분 매트릭스 (근거 포함)

조사 시점 base: `origin/dev@ec8ceef00`. 5개 독립 조사 레인이 그 시점의 실제
소스를 읽어 도출했다. PR 설명만으로 내린 판정은 없다.

> **출처 주의.** 이 문서의 file:line 인용은 `ec8ceef00` 시점 기준이다. 감사에서
> 13건을 표본 검증했고 전부 그대로 유효했다. 이후 dev가 `a259d63dc` 를 거쳐
> `d55b903d8` 로 이동했으므로, 실제 작업 착수 시점에는 각 인용을 현재 head에서
> 다시 확인한다(`010` 문서의 라이브 갱신 게이트).
>
> 감사에서 뒤집힌 판정: #1176, #1024는 close에서 **tracking 유지**로 변경.
> #1257은 `db371021c` 로 dev에 머지되어 재발행 대상에서 제외.

## A. 재발행 (리베이스 + Co-authored-by)

### 무충돌 소형 — WP1

**#1189** `luvs01 <27862058+luvs01@users.noreply.github.com>`
`src/routing/history/indexer.ts:195-196` 이 `const length = size - fromOffset`
계산 후 `Buffer.allocUnsafe(length)` 를 호출하고, `:266` 이 미인덱스 tail 전체를
넘긴다. PR은 청크 단위 수집으로 대체하며 부분 라인 오프셋 규칙을 보존한다.
커밋 `6e7269d05`, `d5242a231`.

**#1187** `luvs01 <27862058+luvs01@users.noreply.github.com>`
`src/routing/analytics.ts:153-154` 이 `attemptsOf(entry) ?? []` 후 검증 없이
`attempt.recoveryKinds.some(...)` 를 호출한다. `attempts` 가 배열이 아닌 JSONL
행에서 throw. 커밋 `8b413ac50`.

**#1184** `luvs01 <luvs01@hanmail.net>`
`src/adapters/command-code.ts:321,350` 과 `src/providers/command-code-efforts.ts:34,62`
가 객체를 직접 인덱싱한다. `constructor`, `toString` 같은 ID가 상속 속성으로
해석된다. `Object.hasOwn` 가드가 모든 조회 지점을 덮는다. 커밋 `cc01ba04e`.

**#1258** `luvs01 <luvs01@hanmail.net>`
`src/routing/trace.ts:468-474` 이 잘라낸 접두부만 검증한 뒤 `:470` 에서 전체
영속 배열을 순회한다. PR은 보존된 8개 항목만 읽고 sparse hole도 거부한다.
커밋 `1af3b74de`.

**#1256** `luvs01 <luvs01@hanmail.net>`
`src/usage/log.ts:658-664` 가 "파일 전체까지" 확장한다고 명시하며
`Buffer.alloc(size - start)` 를 호출하고, `:671` 이 창을 `size` 까지 키운다.
64 MiB 상한이 전체 원장 읽기를 막는다. 커밋 `50117895 6`.

**#1195** `luvs01 <27862058+luvs01@users.noreply.github.com>`
`src/router.ts:516-529` 가 프로세스 활성 Codex 계정을, `:531-533` 이 활성
Anthropic 계정을 주입한다. 관리 dry-run이 `src/server/management/routing-profile-routes.ts:118-135`
에서 같은 동작을 반복한다. 커밋 `e555f7b44`, `6eff3f6a5`.

**#1202** `Yuxin Qiao <104957188+Yuxin-Qiao@users.noreply.github.com>`
`src/codex/inject.ts:1036-1041`, `:1261-1263`, `src/cli/index.ts:900-903` 이 모든
실패를 lock 문구로 수렴시킨다. 별개로 `src/codex/history-lock.ts:184-187` 이
`realpathSync.native(databasePath) !== databasePath` 일 때 거부하는데
`src/codex/user-identity.ts:157-163` 은 정규화되지 않은 Windows 루트를 반환한다.
커밋 4개: `d30ad97ab`, `fe1d1e539`, `e9d58d805`, `44b0a04b6`. 이슈 #1191 해소.

**#1169** `TyroneXie <328347833@qq.com>`
`src/cli/index.ts:1151-1155` 가 `r.installed` 만으로 green을 출력하고, Codex가
실제로 OpenCodex를 경유하는지 확인하지 않는다. 커밋 `d8968b7e6`.

**#1192** `luvs01 <27862058+luvs01@users.noreply.github.com>`
`src/server/responses-json-events.ts:24-38` 이 출력 항목당 프레임 배열을 만들고
`:49-51` 이 전부를 한 문자열로 join, `src/server/responses/core.ts:2452` 가 그
전체 본문을 반환한다. 리베이스 충돌은 `structure/04_transports-and-sidecars.md`
2줄뿐 — 양쪽 문서 텍스트를 모두 보존한다. 커밋 `b50f23943`.

### 스트리밍 — WP2

**#1249** `Yuxin Qiao <104957188+Yuxin-Qiao@users.noreply.github.com>`
`src/adapters/openai-chat.ts:951-963` 이 `trim()` 직후 `[DONE]` 검사와
`JSON.parse` 로 진행한다. 빈 `data:` 가 종료성 malformed 오류가 된다.
커밋 `20c7afb5`.

### 카탈로그 — WP4

**#1224** `xinweigao <xinwei.gao.7@yandex.com>` (13커밋, head `3e23b4b`)
`src/server/management/provider-routes.ts:644-655` 의 PUT이 `setAll` 과 무관하게
항상 `setGlobalContextCapValue` 를 호출하고 capped 프로바이더를 전부 지운다.

**#1226** `xinweigao <xinwei.gao.7@yandex.com>` (커밋 `a74325a`, `ad4459a`)
`src/providers/registry.ts:1295-1306` 에 DeepSeek의 `jawcodeBundle` 이 없고
`modelContextWindows` 가 `1_000_000` 이다.

**#1178** `Xinwei Gao <xinweigao.1@bytedance.com>` (4커밋)
`src/providers/registry.ts:1290` 이 `liveModels: false` 로 고정돼 있다. 발견,
캐시 동일성, OAuth 조정, 아웃바운드 POST 하드닝을 함께 바꾸므로 보안 민감
슬라이스로 취급한다.

**#1244** WZBbiao / Wibias (52커밋, head `67842aa`)
`src/codex/catalog/sync.ts:543-549` 의 보존 로직이 슬래시 유무로만 라우팅 행을
인식한다. Desktop 호환 bare native-alias 행을 보존할 수 없다.

**#1266** `Ingwannu <ingwannu@users.noreply.github.com>`
head `c0ffaef643aee3a6b73f93db834cc6e4749b5728` (2026-08-08T06:21:28Z 갱신).
원본 브랜치 `lidge-jun:agent/fix-1254-vertex-thought-signature`. WP4 §040-7,
#1178 바로 뒤에 배치(둘 다 Google/Antigravity 경로).

> head 이력: 최초 기록은 `ae28b69ef` 였으나 기여자가 갱신했다. 파일 맵은 동일
> 9개로 유지됐지만, **착수 시점에 SHA를 다시 확인하고 diff를 재확인한다.**
> 이 사례가 라이브 게이트에 SHA 대조 조건을 넣게 만든 계기다(`010` 참조).

Vertex 경로에서 thought signature가 후속 턴에 재생되지 않는다. 수정 범위는
`src/adapters/google.ts` 와 신규 `src/adapters/google-antigravity-replay.ts`,
문서 5개 로케일 `reference/adapters.md`,
`structure/04_transports-and-sidecars.md`, 회귀
`tests/google-vertex-thought-signature.test.ts`.

활성화 증거: signature를 포함한 응답의 후속 턴에서 재생된 signature가 요청에
실리는지, signature 없는 응답에서는 기존 동작이 유지되는지 양쪽을 확인한다.

감사 라운드 5의 라이브 게이트가 잡아낸 항목이다 — 게이트가 의도대로 작동한 사례.

**#1163** eachann1024 (커밋 `39f677cb`, `99c63dbf`)
Co-authored-by: 关俊江 <each1024@qq.com>
`src/codex/catalog/provider-fetch.ts:1276-1284` 이 이미 발견된 멤버만 취하고,
`src/codex/catalog/aggregation.ts:102-115` 이 결측 멤버를 거부하며 `:134-136` 이
없는 ladder를 빈 배열로 만든다.

### CI 워크플로 — WP3

**#1255** ~~스택 루트~~ — **머지 완료, 조치 없음.** `b73f6a42` 가 `d55b903d8` 로
dev에 착지했고 그 커밋이 현재 `origin/dev` 다. 이 항목의 재발행 계획은 무효이며
WP3은 #1259와 #1185 두 독립 PR로 재구성됐다(`030` 문서 참조).

**#1185** `luvs01 <luvs01@hanmail.net>` (커밋 `bff31d1e`)
`tests/ci-workflows.test.ts:166-169` 의 부분문자열 매칭을 정확한 실행 라인
어서션으로 바꾼다. `echo` 나 주석이 어서션을 만족시키는 문제를 막는다.
부모가 낡음(`6d04574d`).

## B. 재작업 필요

**#1240** `snowyukitty <270071858+snowyukitty@users.noreply.github.com>`
결함은 실재한다: `src/adapters/openai-chat.ts:961-967` 이
`JSON.parse(payload) as Record<string, unknown>` 로 캐스팅한 뒤 `:972` 에서
`chunk.error` 를 역참조하므로 `JSON.parse("null")` 이 그대로 도달한다. 동일 결함이
`src/adapters/google.ts:500-510`, `src/adapters/anthropic.ts:987-995`,
`src/web-search/parse.ts:158-163` 에 있다.

그러나 **종료 동작이 틀렸다.** 이슈 #1219의 리포터 정정에 따르면 `data: null` 은
유효 청크 사이에 나타난다. 종료하면 뒤따르는 finish 청크와 `[DONE]` 을 버린다.
OpenAI Chat과 Google의 비레코드 분기를 `return "continue"` 로 바꾸고, 구문적으로
잘못된 JSON에만 종료 동작을 남긴다.

**#1259** `luvs01 <luvs01@hanmail.net>` (커밋 `a0810bc3`)
`hygiene` 실패 사유는 코드가 아니다:

```
##[error] PR hygiene failed: unsponsored_surface
```

`.github/workflows/enforce-pr-target.yml` 이라는 보호된 워크플로 표면을 건드려서
maintainer 보안 검토와 `maintainer-sponsored` 라벨이 필요하다. 코드 자체는
정당하다 — 현재 base는 `enforce-pr-target.yml:647-666` 에서 한 페이지만 읽는다.
추가로 #1255와 `tests/helpers/enforce-pr-target-harness.ts` 의 페이지네이션
로직이 겹치므로 수동 합성이 필요하다.

## C. 위양성 — close

**PR #1155** myrosla — 고치려는 경로가 도달 불가.
`src/providers/registry.ts:1318-1326` 이 "bounded-JSON force ... is retired" 를
명시하고, `providerModelResponsesUpstreamStreaming()`(`:2248-2256`)에 opt-in 하는
프로덕션 항목이 없다. `src/web-search/loop.ts:364-366` 은 항상 `stream: true`,
`:539-544` 는 항상 `parseStream` 을 바인딩한다. 문서 변경분은 현재
`docs-site/.../sidecars.md:32-35` 와 모순된다.

**PR #1119** lidge-jun (maintainer 본인) — 유일한 코드 훅이 낡은
`tests/codex-catalog.test.ts` 추가인데, 주장하는 #1100 계약이 이미
`tests/codex-catalog.test.ts:2391-2451` 에 있다. GitHub은 DIRTY로 보고한다.

**이슈 #1100** — 회귀 커버리지가 `tests/codex-catalog.test.ts:2391-2451` 에 존재하며
리포터의 커스텀 이름/BigModel Coding Plan 형태도 `:2454-2489` 가 덮는다. 구현
이력은 `aa8851f38`, `2f242bb7c`, `07e7525b8`.

**이슈 #1128** — `src/server/responses/compact.ts:651-665` 가 내부 Responses 요청을
`stream: false` 로 구성하고 `:666-709` 가 JSON을 소비한다. 기원 커밋 `87e1d000b`.

**이슈 #1102** — 이미 구현·전달. `src/server/index.ts:499-540` 의 선택적 루프백
리스너, `src/codex/inject.ts:638-649` 의 전환, 실소켓 테스트
`tests/loopback-listener-integration.test.ts:108-122` 가 public 401 대 loopback 200을
증명한다.

> **#1176과 #1024는 여기서 제외됐다.** 초안은 둘을 위양성 close로 분류했으나
> 감사에서 뒤집혔다. #1176은 maintainer가 2026-08-08T02:15:06Z에 "v2.11.0에 타깃
> 수정 없음" 을 남기고 열어둔 상태이고, #1024는 계획 자신이 제안한 대조 실험을
> 수행하기 전이다. 두 건의 현재 처분은 **tracking 유지**이며 근거는
> `060_wp6_dispositions.md` §060-3에 있다. 이 절에서 close 근거를 찾지 말 것.

## D. 직접 수정 — WP5

**#1219** 네 파서 전부. `openai-chat.ts:961-972`, `google.ts:500-510`,
`anthropic.ts:987-995`, `web-search/parse.ts:158-163`. `unknown` 으로 파싱하고
속성 접근 전에 비레코드를 거부하되, 유효 JSON 패딩 프레임은 종료가 아니라 건너뛴다.

**#1245** `gui/src/pages/Startup.tsx:109` 이 갱신된 health를 받지만 `:250` 이 이전
오류를 유지하고 `gui/src/pages/startup-sections.tsx:146` 이 계속 렌더한다.
`fetchStartup` 에서 `next` 파싱 직후 `status === "protected"` 일 때 실패한
`installResult` 만 비운다. 회귀: `gui/tests/startup-install-result-reconciliation.test.tsx`.

**#1236** `bin/ocx.mjs:482-483` 의 최종 Node→Bun launcher spawn에 `windowsHide` 가
없다. 회귀: `tests/ocx-launcher-source.test.ts:16` 확장.

**#1230** `src/cli/index.ts:225` 가 `:226` 의 live-proxy 검사보다 먼저
`reconcileJournal()` 을 호출한다. `handleEnsure`(`:440-441`)도 같은 순서다. 양쪽 다
PID/liveness 블록 뒤로 이동. 회귀: `tests/cli-start-journal-order.test.ts`.

**#1196** `.github/scripts/issue-quality-core.cjs:83` 이 media 자식 여부 판정 전에
모든 들여쓰기 라인을 마스킹하고, `:100-107` 이 라인 위치로 복원하며(멀티라인 HTML이
접힌 뒤 위험), `:134` 가 정확한 placeholder까지 실질 텍스트로 본다. 토큰 기반
보호/복원으로 교체. 회귀: `.github/scripts/issue-quality.test.cjs:366,1249` 확장.

**#1218** — **이슈 종결됨(2026-08-08T03:40:15Z), 실행 대상 아님.** 아래는 기록용
분석이다. `fa821deb4` 는 null/200k 폴백만 고쳤고
(`src/claude/model-info.ts:133-139`), `src/codex/catalog/metadata.ts:56-64` 의
`NATIVE_GPT56_CONTEXT_WINDOW = 372_000` 은 그대로다. 이 값이 틀렸다는 독립 근거가
나오면 새 이슈로 제기한다.

**#1213** `src/server/management/agent-settings-routes.ts:838-845` 이 정적 프로파일을
호출하고 `src/claude/desktop-3p.ts:338-359` 가 전체 모델 목록을 쓴다.
`gui/src/pages/ClaudeDesktop.tsx:477-479` 에 파괴적 교체 확인이 없다. 복원 경로는
이미 안전해졌다(`native-integration-routes.ts:627-641`, `agent-settings-routes.ts:183-196`).

**#1229** `src/codex/inject.ts:107-114` 이 `openai_base_url` 만 덮고
`model_provider = "openai"` 를 유지한다. 전용 프로바이더 호환 모드가 없다.

**#1145** `src/providers/registry.ts:2023` 키드 Zen 항목에 note가 없다. 프리 티어는
`:2040-2048` 에 자체 note가 있지만 키드 rate-limit 안내가 아니다. 헤더 관련 주장은
라이브 429 없이는 미검증 — `src/server/responses/passthrough-error.ts:16-77` 은 유효
`Retry-After` 를 이미 보존/합성한다.

**#1059** `.github/workflows/ci.yml:413-438` 이 Windows를 dispatch-only로 둔다. 최근
실제 디스패치 `31095755263` 은 4개 shard 전부 실패했고, 최신 dev push 런
`31239522846` 은 Windows를 건너뛰었다. 현재 `ec8ceef` 에서 green은 **미검증**이다.

## E. tracking 유지

| 이슈 | 사유 | 근거 |
|---|---|---|
| #417 | 업스트림 미해결 | `openai/codex#35161` OPEN. 릴레이는 `src/server/live.ts:79-127` 에서 바이트 투명, 회귀 `tests/server-live.test.ts:648-680` |
| #92 | 업스트림 미해결 | `openai/codex#32031` OPEN. dev는 `src/server/responses/core.ts:1560-1564` 로 명시적 실패만 추가 |
| #904 | 재현 캡처 부재 | 릴레이 포렌식 훅 `src/server/live.ts:79-127` 존재, 실패 프레임 조합 미확보 |
| #796 | 라이브 확인 불가 | 호스트 게이트 수정은 `d3abf4345`(`src/adapters/openai-chat.ts:547-582`)로 반영됐으나 회귀 자체가 라이브 Ark 미검증을 명시(`tests/volcengine-ark-assistant-content.test.ts:16-18`) |
| #418 | 동일런 트레이스 부재 | `src/server/responses/collaboration.ts:321-330` 이 개선됐으나 custom-parent→custom-child 트레이스 없음. #92와 별개 |
| #1162 | 정적 증명 불가 | `src/adapters/cursor/live-transport.ts:175-180`, `cursor-errors.ts:83-100` 이 증상은 설명하나 핸드셰이크 원인은 미증명 |
| #1222 | 재현 환경 부재 | Windows 네이티브 크래시. 후보 커밋: `0408dfdd7`(네이티브 프로파일 소유권, 최유력), `254db138c`(PowerShell `execFile` 프로브), `14cc0d421`, `9d271d091`/`8b6f16134`(저확률) |

### #1222 반증 실험 설계

추정으로 패치하지 않는다. 리포터 환경에서 다음을 순서대로 확인한다.

1. 네이티브 프로파일 상태가 없는 새 `CODEX_HOME` 으로 시작 — 안정적이면 원인을
   네이티브 메인 소유권/복구로 좁힌다(`src/codex/native-profile-startup.ts:235`).
2. Codex 시작 동기화를 끈다 — 안정적이면 동기화 이후 app-server 프로브로 좁힌다
   (`src/cli/index.ts:380,389` → `src/codex/native-profile-processes.ts:60`).
3. listen 이후 대시보드/클라이언트 트래픽 없이 재현 — 그래도 크래시하면 eager-SSE
   후보를 기각한다.

재현 후 회귀: Windows 전용 `tests/windows-proxy-start-stability.test.ts` 로 패키지
launcher를 띄우고 35초 이상 `/healthz` 를 폴링해 단일 안정 Bun 자식 PID를 확인한다.
먼저 red를 만든 뒤 고친다.
