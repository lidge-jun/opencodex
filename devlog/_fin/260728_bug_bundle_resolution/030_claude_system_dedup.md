# 030 — WP4: **폐기** — Claude Code system 중복 가드 (이슈 #545)

> **A 게이트에서 폐기됨 (2026-07-28, Critical 블로커 1).**
> 이 문서의 초안은 잘못된 전제 위에 있었다. 아래 §폐기 근거를 먼저 읽을 것.
> WP4는 실행하지 않는다. 로드맵에서 제외되고 goalplan wp4는 폐기 처리한다.

## 폐기 근거

초안의 전제: "`skipSystemPromptPrefix`는 클라이언트가 **이미 정체성 문구를
넣었으니 더 붙이지 말라**는 신호다."

**뒤집혔다.** 이 플래그는 Claude Code가 CLI 공용 system 프리픽스를 **붙이지
않는다**는 뜻이다. 즉 분류기 요청은 정체성 문구를 **갖고 오지 않는다.**
`hasClaudeCodeIdentityPrefix(system)`은 영원히 false를 반환하고 새 분기는 한
번도 발화하지 않는다 — 그런데 제안된 단위 테스트는 상수를 자기 자신에게
먹이므로 **통과한다.** C-ACTIVATION-GROUNDING-01이 정확히 막으려는 위양성이다.

독립적인 두 번째 반증: 문자열이 애초에 다르다.

| | 값 |
| --- | --- |
| 우리 상수 (`src/oauth/anthropic.ts:15`) | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` |
| Claude Code 실제 프리픽스 | `You are Claude Code, Anthropic's official CLI for Claude.` |

초안의 위험 절이 "우리 상수와 클라이언트 문구가 완전히 같아야" 판정이 맞는다고
썼는데, 바로 그 조건이 성립하지 않는다.

## 결정적 근거 — 메인테이너가 이미 판정했다

이슈 #545에서 리포터가 제안한 것이 정확히 이 수정이다("B (완화): inbound
system에 이미 Claude Code identity가 있으면 중복 prepend 생략"). 메인테이너
(`Ingwannu`)가 **아웃바운드 캡처를 받은 뒤** 답한 내용:

> The capture confirms that OpenCodex preserves both caller controls all the way
> to Anthropic: `max_tokens: 64` and `stop_sequences: ["</block>"]` are present on
> every outbound request. (…) The 66-character system difference is also accounted
> for by **the required Claude OAuth identity block** plus block joining; it is not
> an unexplained truncation or dropped field.

> We cannot safely fix that by raising the caller's explicit budget, **removing the
> OAuth identity instruction**, or pretending an incomplete response completed.

즉 정체성 블록은 **Claude OAuth가 요구하는 필수 요소**로 확인됐고, 그걸 빼는
방향은 이미 안전하지 않다고 판정됐다. 우리 계획은 판정된 방향을 다시 하려던
것이었다.

## 이슈 #545의 실제 잔여 문제

메인테이너 정리: Claude Desktop 3P의 Auto Mode 분류기가 클라이언트가 명시한
64토큰 예산 안에 닫는 태그를 못 내는 경우가 있고, Desktop이 같은 요청을 5회
반복한다. 이건 **호환성 문제**지 우리 번역 손실이 아니다. 라벨도
`provider-compatibility`로 좁혀져 있다.

우리가 안전하게 할 수 있는 일이 남아 있는지는 별도 조사 대상이며, 이번 유닛의
스코프가 아니다. 이슈는 열린 채로 둔다.

---

## (이하 폐기된 초안 — 이력 보존용)

대상: `src/adapters/anthropic.ts`
이슈: #545 `Claude Desktop 3P Auto Mode classifier retries after 64-token Anthropic OAuth outputs`
판정 근거: `260727_owner_decision_ledger/010_bug_bundle_fixability.md` §이슈 #545
계층: 어댑터

## 문제

```ts
// src/adapters/anthropic.ts:616-624 (현재)
if (isOAuth) {
  // Claude OAuth (Pro/Max) requires the first system block to be the Claude Code identity.
  body.system = [
    { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
    ...(system ? [{ type: "text", text: system }] : []),
  ];
}
```

OAuth 경로면 **인바운드 system을 보지 않고 무조건** 정체성 블록을 맨 앞에
넣는다. `CLAUDE_CODE_SYSTEM_INSTRUCTION`은
`"You are a Claude agent, built on Anthropic's Claude Agent SDK."`
(`src/oauth/anthropic.ts:15`).

Claude Code의 Auto Mode 분류기는 `skipSystemPromptPrefix`로 요청을 보낸다 —
즉 **자기가 이미 정체성 문구를 넣었으니 더 붙이지 말라**는 신호다. 그런데
Desktop 3P는 gateway key(`ocx`) 경로라 `wantsNativePassthrough()`
(`src/server/claude-messages.ts:93`)를 타지 않고 이 어댑터로 들어온다. 결과적으로
분류기 요청이 **요청하지 않은 system 블록을 하나 더** 받는다.

분류기는 `max_tokens: 64`, `stop_sequences: ["</block>"]`로 짧은 XML 판정을
기대한다. 앞에 문구가 더 붙으면 64토큰 안에 태그가 안 닫힐 확률이 올라가고,
닫히지 않으면 파싱 실패로 **같은 요청을 최대 5회 재시도**한다. 리포터 집계로는
`out=64` 502가 1,084건, 길이 5 클러스터가 112개다.

## 리포터 주장 중 성립하지 않는 것 (010에서 확인)

수정 범위를 좁히기 위해 명시한다. 다음 셋은 **우리 버그가 아니다**:

| 주장 | 실제 |
| --- | --- |
| `max_tokens`가 소실 | `src/claude/inbound.ts:435`에서 `max_output_tokens`로 보존 |
| `stop_sequences`가 소실 | `:440`에서 `stop`으로 보존 |
| effort 손실 | `:479` `thinking.type:"disabled"` 보존 — 클라이언트가 끈 결과 |
| Part C | 이미 `7fcaa9119`로 머지됨 |

따라서 이 work-phase는 **중복 prepend 하나만** 고친다.

## 왜 "OAuth면 무조건"이 애초에 있었나

Claude OAuth(Pro/Max)는 첫 system 블록이 Claude Code 정체성이어야 요청을
받는다. 그래서 무조건 넣는 것이 안전한 기본값이었다. 문제는 **이미 있는 경우**를
검사하지 않는다는 것이다. 이미 있으면 넣지 않아도 계약이 충족된다.

## 변경 (diff-level)

### MODIFY `src/oauth/anthropic.ts`

정체성 판정을 상수 옆에 둔다 — 상수를 아는 모듈이 판정도 소유해야 한다.

```diff
 export const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
+
+/**
+ * Whether an inbound system prompt already opens with the Claude Code identity.
+ * Claude Code's Auto Mode classifier sends `skipSystemPromptPrefix` precisely because it
+ * already carries the identity; prepending a second copy pushes its 64-token XML verdict
+ * past `max_tokens` and it retries the same request up to 5 times (issue #545).
+ * Compared on a trimmed prefix so trailing edits by the caller do not defeat the check.
+ */
+export function hasClaudeCodeIdentityPrefix(system: string | null | undefined): boolean {
+  if (typeof system !== "string") return false;
+  return system.trimStart().startsWith(CLAUDE_CODE_SYSTEM_INSTRUCTION);
+}
```

### MODIFY `src/adapters/anthropic.ts`

```diff
-import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION, applyClaudeToolPrefix, stripClaudeToolPrefix } from "../oauth/anthropic";
+import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION, applyClaudeToolPrefix, hasClaudeCodeIdentityPrefix, stripClaudeToolPrefix } from "../oauth/anthropic";
```

```diff
       if (isOAuth) {
         // Claude OAuth (Pro/Max) requires the first system block to be the Claude Code identity.
-        body.system = [
-          { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
-          ...(system ? [{ type: "text", text: system }] : []),
-        ];
+        // When the caller already opens with that identity (Claude Code's Auto Mode classifier
+        // sends skipSystemPromptPrefix for exactly this reason), a second copy is not required
+        // by the contract and costs output budget the caller has capped at 64 tokens — the
+        // classifier then retries the same request up to 5 times (issue #545).
+        body.system = hasClaudeCodeIdentityPrefix(system)
+          ? [{ type: "text", text: system as string }]
+          : [
+              { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
+              ...(system ? [{ type: "text", text: system }] : []),
+            ];
       } else if (system) {
```

> `system as string` — `hasClaudeCodeIdentityPrefix`가 true를 반환하려면
> `typeof system === "string"`이어야 하지만 TS가 좁혀주지 않는다. B 단계에서
> 타입 가드 시그니처(`system is string`)로 바꿔 캐스트를 없앨지 판단한다.

### NEW `tests/claude-system-identity-dedup.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION, hasClaudeCodeIdentityPrefix } from "../src/oauth/anthropic";

describe("hasClaudeCodeIdentityPrefix", () => {
  test("detects the identity at the head of an inbound system prompt", () => {
    expect(hasClaudeCodeIdentityPrefix(CLAUDE_CODE_SYSTEM_INSTRUCTION)).toBe(true);
    expect(hasClaudeCodeIdentityPrefix(`${CLAUDE_CODE_SYSTEM_INSTRUCTION}\n\nYou are an expert...`)).toBe(true);
    expect(hasClaudeCodeIdentityPrefix(`  \n${CLAUDE_CODE_SYSTEM_INSTRUCTION}`)).toBe(true);
  });

  test("does not fire on an unrelated or mid-string occurrence", () => {
    expect(hasClaudeCodeIdentityPrefix("You are a helpful assistant.")).toBe(false);
    expect(hasClaudeCodeIdentityPrefix(`Preamble. ${CLAUDE_CODE_SYSTEM_INSTRUCTION}`)).toBe(false);
    expect(hasClaudeCodeIdentityPrefix(null)).toBe(false);
    expect(hasClaudeCodeIdentityPrefix(undefined)).toBe(false);
  });
});
```

어댑터 레벨 검증은 기존 하니스를 재사용한다 — B 단계에서
`tests/anthropic-hardening.test.ts`의 `buildRequest` 호출 패턴을 확인해
같은 방식으로 두 케이스를 추가한다:

| 케이스 | 인바운드 system | 기대 `body.system` |
| --- | --- | --- |
| 중복 회피 | 정체성으로 시작 | 길이 1, 텍스트 = 인바운드 원문 |
| 기존 동작 보존 | 일반 프롬프트 | 길이 2, `[0]` = 정체성 |
| 기존 동작 보존 | 없음 | 길이 1, `[0]` = 정체성 |
| key 모드 무관 | 아무거나 | 정체성 삽입 없음 |

### 활성화 증거 (C-ACTIVATION-GROUNDING-01)

이 변경은 **새 조건부 분기**를 만든다. 발화/비발화 양쪽이 필요하다:

- 발화: 인바운드 system이 정체성으로 시작 → `body.system.length === 1`
- 비발화: 일반 system → `body.system.length === 2`, `[0].text ===` 정체성

"전체 green"은 불충분하다. 두 케이스가 `buildRequest`를 실제로 호출해
`body.system` 배열을 직접 검사한다.

## 위험

**Claude OAuth가 요청을 거부할 수 있는가?** 계약은 "첫 system 블록이 Claude
Code 정체성일 것"이다. 중복 회피 경로에서도 첫 블록이 정체성으로 시작하므로
계약은 유지된다. 다만 우리 상수와 클라이언트 문구가 **완전히 같아야** 판정이
맞는다 — `startsWith` 정확 일치를 쓰는 이유다. 느슨한 매칭(부분 문자열,
대소문자 무시)은 오탐 시 계약 위반으로 이어지므로 쓰지 않는다.

## 스코프 경계

IN: `hasClaudeCodeIdentityPrefix` 신설, 어댑터 OAuth 분기 1곳, 테스트.
OUT: `src/vision/anthropic-describe.ts:143`, `src/web-search/anthropic-executor.ts:153`
— 같은 상수를 쓰지만 **우리가 만든 요청**이라 인바운드 system이 없다. 중복
가능성이 없으므로 건드리지 않는다.
OUT: `src/claude/inbound.ts`의 파라미터 번역 — 010에서 정상 확인됨.
OUT: 재시도 정책 자체 — 재시도는 Claude Code 쪽 동작이다.

## 수용 기준

- `bun run typecheck` 통과
- `bun test tests/claude-system-identity-dedup.test.ts` 전건 통과
- 어댑터 레벨 4케이스 통과
- `bun test tests/anthropic-hardening.test.ts tests/claude-*.test.ts` 회귀 없음
