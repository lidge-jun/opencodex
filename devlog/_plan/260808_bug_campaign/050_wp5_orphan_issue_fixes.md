# 050 — WP5: PR 없는 버그 이슈 직접 수정

선행: WP2 (SSE 계약이 먼저 정리되어야 어댑터 계열이 안정된다).

대상은 리포터가 증거를 냈는데 아무도 PR을 열지 않은 결함들이다. 각각 독립이라
병렬 PR로 연다.

## 050-1 · #1245 GUI Startup Safety stale error

새 브랜치 `codex/260808-startup-install-result-reconcile`

### 결함

새로고침이 health 데이터는 교체하지만 이전 `installResult` 를 조정하지 않는다.
대체 설치가 성공한 뒤에도 실패 메시지가 무기한 남는다.

- `gui/src/pages/Startup.tsx:109` 이 갱신된 health를 받는다
- `:250` 이 이전 오류를 그대로 유지한다
- `gui/src/pages/startup-sections.tsx:146` 이 그것을 항상 렌더한다

### 수정

MODIFY `gui/src/pages/Startup.tsx` — `fetchStartup` 에서 `next` 파싱 직후:

```diff
 const next = await res.json() as StartupHealthData;
+if (next.status === "protected") {
+  setInstallResult(current => current?.kind === "error" ? null : current);
+}
```

성공 확인 메시지는 보존하고, health가 독립적으로 보호 상태를 증명했을 때만
낡은 실패 UI를 지운다.

NEW `gui/tests/startup-install-result-reconciliation.test.tsx` —
`gui/tests/startup-revisit-cache.test.tsx` 의 Happy DOM 픽스처 스타일을 따른다.
`install-shim` 실패를 만든 뒤 `status: "protected"` 를 반환하는 새로고침을
시뮬레이션하고, 실패 텍스트가 사라지는지 어서션.

GUI 스크린샷 필수. `bun run lint:gui` 필수.

활성화 증거: 조건부 정리 분기가 실제로 발화해야 한다. 수정 전 red 확인.

## 050-2 · #1236 — 폐기, PR #1268 채택

> 게이트 2차 실행에서 **PR #1268**(Ingwannu, head `4c40c569d`)이 같은 수정을
> 이미 하고 있음이 확인됐다. `bin/ocx.mjs` 최종 spawn에 `windowsHide: true` 를
> 넣고, `tests/ocx-launcher-source.test.ts` 에서 그 spawn 호출을 잘라내어
> 확인하는 것까지 우리 계획과 동일하다. **직접 구현하지 않는다.** 상세는 `013`.

<details>
<summary>폐기된 직접 구현 계획 (기록용)</summary>

새 브랜치 `codex/260808-launcher-windows-hide`

### 결함

최종 Node에서 Bun으로의 launcher spawn에 `windowsHide` 가 없다. 헤드리스 부모에서
프록시를 시작하면 콘솔 창이 보인다.

`bin/ocx.mjs:482-483` 이 `stdio: "inherit"` 를 쓰는데 옵션 객체에 `windowsHide` 가
없다.

### 수정

MODIFY `bin/ocx.mjs`:

```diff
 const child = spawn(bun, [...], {
   stdio: "inherit",
+  windowsHide: true,
   env: {
```

MODIFY `tests/ocx-launcher-source.test.ts` — `:16` 의 기존 테스트가 하듯 최종
`spawn(bun, [cliPath...])` 호출을 잘라내어 그 옵션 객체 안에 `windowsHide: true`
가 있는지 어서션.

한 줄 변경이지만 Windows 사용자 체감이 큰 항목이다.

</details>

## 050-3 · #1230 — 축소, PR #1269 채택 + handleEnsure 보완

> 게이트 2차 실행에서 **PR #1269**(Ingwannu, head `8b7831ead`)가 `handleStart` 의
> 순서를 정확히 우리 계획대로 고치고 있음이 확인됐다. 다만 **`handleEnsure` 를
> 빠뜨렸다** — dev의 `src/cli/index.ts:441` 이 `:447` 의 liveness 확인보다 먼저
> `reconcileJournal()` 을 호출하는 문제가 그대로 남는다.
>
> **새 계획:** #1269를 채택하되 `handleEnsure` 보완을 요청한다. 기여자가 원치
> 않으면 후속 PR로 처리한다. 어느 쪽이든 **#1230은 두 함수가 모두 고쳐지기
> 전까지 닫지 않는다.** 상세는 `013`.
>
> 회귀 테스트도 제안한다: #1269는 소스 문자열 순서를 보는 정적 테스트라
> 리팩터링에 약하다. 아래 동작 테스트, 특히 음성 대조군을 함께 권한다.

<details>
<summary>원래 직접 구현 계획 (보완 요청의 근거로 유지)</summary>

새 브랜치 `codex/260808-start-journal-order`

### 결함

`start` 와 `ensure` 모두 liveness 감지 **전에** journal을 조정한다. 이미 정상
동작 중인 프록시가 있어도 journal 복원이 먼저 일어나 `config.toml` 을 되돌리거나
카탈로그를 지운다.

- `src/cli/index.ts:225` 가 `:226` 의 live-proxy 검사보다 먼저 `reconcileJournal()`
- `handleEnsure` 의 `:440-441` 도 같은 순서

### 수정

MODIFY `src/cli/index.ts` — `handleStart`:

```diff
 const requestedPort = parsePortOption();
-if (!currentExternalCodexModelProvider()) reconcileJournal();
 const existingPid = readPid();
 if (existingPid) {
   const live = await findLiveProxy();
   if (live) { ... exit ... }
   removePid(existingPid);
 }
+if (!currentExternalCodexModelProvider()) reconcileJournal();
```

`handleEnsure` 의 `:441` 도 `findLiveProxy()` 조기 반환 블록 아래로 이동한다.
그러지 않으면 autostart 시도가 같은 파괴적 순서를 유지한다.

NEW `tests/cli-start-journal-order.test.ts` — 격리된 `OPENCODEX_HOME`/`CODEX_HOME`,
죽은 journal PID, 별도로 띄운 정상 프록시 PID를 준비한다. 두 번째 `ocx start` 와
`ocx ensure` 가 `config.toml` 복원이나 카탈로그 삭제 없이 "이미 실행 중" 으로
종료하는지 어서션. 음성 대조군도 포함: 죽은 PID에 리스너가 없으면 여전히 조정된다.

활성화 증거: 음성 대조군이 핵심이다. 조정 자체를 없앤 게 아니라 순서만 바꿨음을
증명해야 한다.

</details>

## 050-4 · #1196 issue-quality media 정규화

새 브랜치 `codex/260808-issue-quality-media-normalization`

### 결함 (실측 확인됨)

조사 중 현재 코어에 픽스처를 직접 돌려 확인했다.

- `clean("<video>No response</video>")` 가 HTML 문자열 그대로 남는다
- 들여쓴 `<source>`/`<img>` 를 가진 멀티라인 `<picture>` 가 media-only로 인식되지 않는다

원인 셋:

- `.github/scripts/issue-quality-core.cjs:83` 이 media 자식 여부를 판정하기 전에
  모든 들여쓰기 라인을 마스킹한다
- `:100-107` 이 라인 위치로 복원한다. 멀티라인 HTML이 접힌 뒤에는 위치가 어긋나
  보호된 코드가 손상될 수 있다
- `:134` 가 비어 있지 않은 fallback 텍스트를 전부 실질 텍스트로 본다. 정확한
  placeholder도 포함된다

### 수정

MODIFY `.github/scripts/issue-quality-core.cjs`:

```diff
-const protectedText = protectIndentedCodeLines(text);
+const protectedText = protectCodeSpans(text);
 ...
-return restoreIndentedCodeLines(referenceStripped, protectedText.lines);
+return restoreCodeSpans(referenceStripped, protectedText.spans);
```

`protectCodeSpans` 요구사항:

1. 펜스 코드 라인과 일반 들여쓰기 코드 라인을 각각 고유한 불투명 토큰으로 치환하고
   토큰에서 원본 라인으로 가는 맵을 유지한다
2. 들여쓰지 않은 `<picture>`, `<video>`, `<audio>` 블록 **안에** 있는 동안에는
   들여쓰기 라인을 마스킹하지 않는다
3. 복원은 토큰 전역 치환으로 한다. 출력 라인 인덱스를 절대 쓰지 않는다

`stripHtmlMedia`:

```diff
 const innerStripped = ...
-return innerStripped.length === 0 ? " " : match;
+return innerStripped.length === 0 || isPlaceholderOnlyValue(innerStripped)
+  ? " "
+  : match;
```

MODIFY `.github/scripts/issue-quality.test.cjs` — `:366` 과 정규화 섹션 `:1249` 에
추가: video/audio/picture의 감싼 placeholder, 실제 fallback 캡션, 중첩 멀티라인
media 자식, 펜스 HTML 바이트 단위 보존, media처럼 보이는 일반 들여쓰기 코드 보존,
접힌 media 블록 전후의 보호 라인에 `\0` 잔여 없음, 전체 `validateIssue` 픽스처.

## 050-5 · #1218 네이티브 컨텍스트 창 값 — 실행하지 않음

**이슈가 2026-08-08T03:40:15Z에 CLOSED 되었다** (이 캠페인 밖에서 종결).
따라서 이 항목은 실행하지 않는다.

아래 분석은 기록으로만 남긴다. `src/codex/catalog/metadata.ts:56-64` 의
`NATIVE_GPT56_CONTEXT_WINDOW = 372_000` 값이 실제로 틀렸다는 독립적 근거가
나오면 새 이슈로 다시 제기한다. 이미 닫힌 이슈에 코드 작업을 얹지 않는다.

<details>
<summary>원래 분석 (참고용)</summary>

새 브랜치 `codex/260808-native-context-window-value`

### 남은 결함

`fa821deb4` 가 null/200k 폴백을 고쳐 `src/claude/model-info.ts:133-139` 가
`nativeOpenAiContextWindow(slug)` 를 넘기게 됐다. 하지만 값 자체는 그대로다.

`src/codex/catalog/metadata.ts:56-64` 의 `NATIVE_GPT56_CONTEXT_WINDOW = 372_000`
이 낡았다.

### 수정

MODIFY `src/codex/catalog/metadata.ts:56` — 업스트림 계약 확인 후 정확한 값으로.

**선행 확인 필요:** 372k와 272k 중 어느 쪽이 현재 업스트림 계약인지 1차 출처로
확인한다. 확인 전에는 값을 바꾸지 않는다. 이슈 리포터는 272k를 주장하지만
검증이 필요하다.

</details>

## 050-6 · #1145 opencode-zen rate limit 고지

새 브랜치 `codex/260808-zen-rate-limit-note`

MODIFY `src/providers/registry.ts:2023-2037` — 키드 Zen 항목에 `note` 추가.
프리 티어는 `:2040-2048` 에 자체 note가 있지만 키드 rate-limit 안내가 아니다.

**범위 제한:** 리포터의 "15-20 RPM" 수치는 현재 프로바이더 증거로 뒷받침되지
않는다. 헤더 관련 주장도 라이브 429 없이는 미검증이며,
`src/server/responses/passthrough-error.ts:16-77` 은 이미 유효 `Retry-After` 를
보존/합성한다. 따라서 **일반 오류 전달 로직은 건드리지 않고**, 현재 증거로
뒷받침되는 범위의 안내만 문서화한다.

## 050-7 · #1213 Claude Desktop 카탈로그 교체 확인

새 브랜치 `codex/260808-claude-desktop-replace-confirm`

### 남은 결함

복원 경로는 이미 안전해졌다(`native-integration-routes.ts:627-641` 이 자격증명
없는 표준 프로파일을 고른 뒤 소유 프로파일을 제거하고,
`agent-settings-routes.ts:183-196` 이 외부/무소유 프로파일에 자동 적용을 거부).

남은 것은 **사전 경고 부재**다. `gui/src/pages/ClaudeDesktop.tsx:477-479` 의
Save-and-apply 버튼에 파괴적 카탈로그 교체 확인이 없다.
`src/server/management/agent-settings-routes.ts:838-845` 이 정적 프로파일을
호출하고 `src/claude/desktop-3p.ts:338-359` 가 전체 모델 목록을 쓴다.

### 수정

MODIFY `gui/src/pages/ClaudeDesktop.tsx:477` — 적용 전 명시적 교체 경고/확인 추가.
서버 측에 승인 상태를 영속화한다.

GUI 스크린샷 필수.

## 050-8 · #1229 namespaced 라우팅 모델 거부

### 050-7 활성화 시나리오 (감사 블로커 6)

| 경로 | 트리거 | 관찰 |
|---|---|---|
| 거부 | 확인 대화에서 취소 | 카탈로그 미교체, 서버 호출 없음 |
| 승인 | 확인 대화에서 진행 | 교체 정상 수행 |
| 승인 영속화 | 승인 후 재방문 | 서버에서 승인 상태를 읽어 재확인 요구 안 함 |

거부 경로가 핵심이다. 확인 UI를 붙여놓고 거부해도 교체가 진행되면 무의미하다.

### 050-7 테스트 seam (감사 라운드 2 블로커 4)

시나리오만으로는 실행할 수 없어 구체적 파일과 어서션을 지정한다.

서버 측 영속화 위치: `src/server/management/agent-settings-routes.ts` 의
Save-and-apply 핸들러(`:838-845` 부근)에 승인 상태를 읽고 쓰는 필드를 추가한다.
저장 위치는 기존 agent settings 설정 객체이며, 새 필드는 PLAN-FIELD-CHAIN-01에
따라 생성/직렬화/역직렬화(미지 값은 미승인으로 취급)/소비자 전 체인을 명시한다.

NEW `gui/tests/claude-desktop-replace-confirm.test.tsx`

- 거부: 확인 대화에서 취소 클릭 후 `fetch` 목이 apply 엔드포인트로 **호출되지
  않았음**을 어서션 (호출 횟수 0)
- 승인: 진행 클릭 후 apply 엔드포인트가 정확히 1회 호출됨
- 영속화: 승인 응답 후 재마운트 시 확인 대화가 나타나지 않음

MODIFY `tests/claude-management-api.test.ts`

감사에서 확인: `tests/agent-settings-routes.test.ts` 는 존재하지 않는다.
Claude Desktop 관리 apply 동작을 실제로 덮는 기존 스위트는
`tests/claude-management-api.test.ts` 이므로 여기에 넣는다.

- 미승인 상태에서 apply 요청 시 서버가 승인 요구로 응답
- 승인 상태 저장 후 재요청 시 통과
- 설정에 해당 필드가 없는 기존 사용자는 미승인으로 취급 (마이그레이션 안전성)

새 브랜치 `codex/260808-dedicated-provider-mode`

### 결함

`src/codex/inject.ts:107-114` 이 `openai_base_url` 만 덮고
`model_provider = "openai"` 를 유지한다. 전용 프로바이더 호환 모드가 없어서,
복원된 namespaced 모델이 OCX에 도달하기 전에 ChatGPT/OpenAI 모델로 제시된다.

### 수정

MODIFY `src/codex/inject.ts` — 주입 결정에 명시적 모드를 도입한다. 롤백과 resume
히스토리 커버리지도 추가.

이 변경은 Codex 설정 주입 경로를 건드리므로 회귀 위험이 크다. 기존
`tests/codex-inject*.test.ts` 전량 green 필수.

활성화 시나리오 (감사 블로커 6):

| 경로 | 트리거 | 관찰 |
|---|---|---|
| 기본 모드 | 전용 모드 미설정 | 기존과 동일하게 `model_provider = "openai"` 유지 (회귀 없음) |
| 전용 프로바이더 모드 | 모드 활성화 | namespaced 모델이 OpenAI 모델로 제시되지 않음 |
| 롤백 | 모드 해제 | 원래 설정 복원, resume 히스토리 무손상 |

### 050-8 테스트 seam (감사 라운드 2 블로커 4)

"기존 `tests/codex-inject*.test.ts` 전량 green" 은 회귀 방지책이지 이 변경의
증거가 아니다. 구체적 어서션을 지정한다.

NEW `tests/codex-inject-dedicated-provider.test.ts`

- 기본: 전용 모드 미설정 시 생성된 `config.toml` 에
  `model_provider = "openai"` 가 그대로 있음 (문자열 단위 어서션)
- 전용 모드: 활성화 시 `model_provider` 가 전용 값으로 바뀌고 `openai_base_url`
  이 함께 정합하게 설정됨
- 롤백: 모드 해제 후 파일이 활성화 이전 내용과 바이트 단위로 동일
- resume 보존: 롤백 후 기존 resume 히스토리 DB 항목이 그대로 읽힘

롤백의 바이트 단위 비교가 핵심이다. "복원했다" 는 주장은 남은 찌꺼기 키를
숨길 수 있다.

## 050-9 · #1059 Windows 전체 스위트

새 브랜치 `codex/260808-windows-suite-status`

### 현재 상태 (실측)

`.github/workflows/ci.yml:413-438` 이 Windows를 dispatch-only로 둔다. 최근 실제
디스패치 런 `31095755263` 은 4개 shard 전부 실패했고, 최신 dev push 런
`31239522846` 은 Windows를 건너뛰었다. 현재 `ec8ceef` 에서 green은 **미검증**이다.

### 처리

이 이슈는 코드 수정이 아니라 상태 규명이 먼저다. Windows 디스패치를 현재 head에서
한 번 돌려 실제 실패 목록을 확보한 뒤, 그 결과를 이슈에 기록한다. 실패가 소수면
개별 수정 PR로, 다수면 별도 work-phase로 승격한다(LOOP-UNIT-CHAIN-01).

## WP5 수용 기준 (게이트 2차 실행 후 갱신)

구성: **직접 구현 5건 / 채택 2건 / 보류 2건.** #1230의 `handleEnsure` 후속은
기여자가 보완을 거절할 때만 추가된다(조건부 여섯 번째).

**직접 구현 (신규 PR 생성):**

- 050-1(#1245 GUI), 050-4(#1196 issue-quality), 050-7(#1213 Claude Desktop),
  050-8(#1229 dedicated mode) — WP4와 병렬 가능
- 050-6(#1145 Zen note)은 WP4 완료 후 (`registry.ts` 공유)
- 각 PR `bun install` 후 `bun run typecheck` exit 0, 대상 테스트 green
- GUI 변경(050-1, 050-7)에 스크린샷과 `bun run lint:gui`
- 조건부 분기 추가 항목(050-1, 050-7, 050-8)은 각 활성화 표의 증거 확보

**채택 (신규 PR 생성 없음):**

- 050-2 → **#1268 채택.** CI green 확인 후 머지 승인 요청. 착지 시 #1236 close
- 050-3 → **#1269 채택 + 보완.** `handleEnsure` 수정을 요청하고, 기여자가
  거절하면 그때만 후속 PR을 만든다. **#1230은 두 함수가 모두 고쳐지기 전까지
  닫지 않는다**

**보류:**

- 050-5(#1218)는 이슈가 외부에서 CLOSED — 실행하지 않음
- 050-9(#1059)는 Windows 디스패치 결과 확보 후 처분 결정
