# WP2 — PR #429 Cursor 프롬프트 오염 제거 + 빈 shell 호출 거부

대상: PR #429 (Aciredy), head `f408f348`.

## 보안 경계 재분류 (A-gate blocker 3, STRICT)

최초 안은 "보안 경계 없음"이라고 단정했으나 이는 오판이다.

`MAINTAINERS.md:22-23`은 인증·자격증명·GitHub Actions·릴리스 자동화·의존성 설치에
더해 **"and other security-boundary changes"**를 명시적으로 포함한다. 이 변경이
검증을 추가하는 지점은 모델이 만들어낸 인자가 shell 실행 도구로 넘어가는 경계다.
즉 신뢰할 수 없는 입력이 실행 경로로 진입하는 자리이며, 방향이 강화(hardening)라도
경계 자체는 보안 경계다.

분류: **shell-tool 입력 경계 하드닝**. 인증/자격증명/워크플로/릴리스/의존성은
건드리지 않는다.

결과적으로 이 work-phase는 목표 정의의 "보안 경계 PR은 직접 병합하지 않고 리뷰 결과만
남기고 사용자 판단으로 되돌린다"에 해당한다. **자체 병합하지 않는다.**
구현 계약은 아래에 그대로 유지하되, 실행은 사용자 승인 후로 미룬다.

## 충돌 상황

`git merge-tree`가 3파일 텍스트 충돌을 보고한다.

```
src/adapters/cursor/protobuf-events.ts
src/adapters/cursor/tool-definitions.ts
tests/cursor-blob.test.ts
```

원인은 이 PR이 #402의 `shell_command`/`exec_command` 이중 alias 계약보다 앞서 작성됐기
때문이다. PR을 그대로 적용하지 않고, dev의 현재 계약 위에 **의도만** 재구현한다.
보존해야 할 것: `protobuf-events.ts`의 alias 해석과 `cursorToolNameMap`,
`tool-definitions.ts`의 두 shell alias·시스템 가이던스·카탈로그 필터·인자 정규화.
제거할 것: 사용자 메시지 변조 경로 하나뿐이다.

## MODIFY `src/adapters/cursor/protobuf-request.ts`

before:

```ts
import {
  appendCursorGenericToolUseHint,
  appendCursorShellAliasHint,
```

after:

```ts
import {
  appendCursorGenericToolUseHint,
```

before:

```ts
const text = lastRole === "user" || lastRole === "developer"
  ? appendCursorShellAliasHint(request.tools, appendCursorGenericToolUseHint(request.tools, rawText))
  : rawText;
```

after:

```ts
const text = lastRole === "user" || lastRole === "developer"
  ? appendCursorGenericToolUseHint(request.tools, rawText)
  : rawText;
```

## MODIFY `src/adapters/cursor/tool-definitions.ts`

DELETE: `CURSOR_SHELL_ALIAS_USER_HINT` 상수 전체, 그리고
`looksLikeShellCommandRequest`, `activeTextMentionsExecCommand`,
`shouldAppendCursorShellAliasHint`, `appendCursorShellAliasHint` 네 함수.

KEEP (삭제 금지): `CURSOR_SHELL_ALIAS_SYSTEM_NOTE`, `CURSOR_GENERIC_TOOL_USE_USER_HINT`,
`CODEX_SHELL_BRIDGE_TOOL_NAMES`, `isCodexShellBridgeToolName`, 모든 alias 해석 헬퍼.

시스템 노트는 남는다. 제거 대상은 사용자 턴 텍스트에 주입되던 힌트뿐이다.

## MODIFY `src/adapters/cursor/protobuf-events.ts`

`tool-definitions.ts` import에 `isCodexShellBridgeToolName`을 추가한다.

before (`dev:src/adapters/cursor/protobuf-events.ts:364`):

```ts
function commitToolCall(state: CursorProtobufEventState, callId: string, finalArgs: string): CursorServerMessage[] {
  const open = state.openToolCalls.get(callId);
  if (!open) return [];
  const out: CursorServerMessage[] = [{ type: "tool_call_start", id: callId, name: open.name }];
```

after:

```ts
function commitToolCall(state: CursorProtobufEventState, callId: string, finalArgs: string): CursorServerMessage[] {
  const open = state.openToolCalls.get(callId);
  if (!open) return [];

  if (isCodexShellBridgeToolName(open.name)) {
    let parsed: unknown;
    try {
      parsed = finalArgs ? JSON.parse(finalArgs) : {};
    } catch {
      parsed = null;
    }
    const args = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    // Accept whichever canonical field carries a real command: `shell_command` normalizes to
    // `command`, while a cmd-required `exec_command` schema is preserved as `cmd`
    // (tool-definitions.ts:185-213). Nullish coalescing would pick a blank `command` over a
    // valid `cmd`. This guard blocks empty calls; normalization stays the existing path's job.
    const candidates = [args.command, args.cmd];
    const hasCommand = candidates.some(
      value => typeof value === "string" && value.trim().length > 0,
    );
    if (!hasCommand) {
      state.openToolCalls.delete(callId);
      state.completedToolCalls.add(callId);
      return [{
        type: "error",
        message: `Cursor emitted ${open.name} without a non-empty command; the tool call was dropped.`,
      }];
    }
  }

  const out: CursorServerMessage[] = [{ type: "tool_call_start", id: callId, name: open.name }];
```

## 회귀 테스트

### 인자 판정 정책 (A-gate blocker 4)

최초 안의 `args.command ?? args.cmd`는 두 alias의 canonical 계약을 잘못 모델링한다.
`src/adapters/cursor/tool-definitions.ts:185-213`의 `shellBridgeArgNormalizeSchema`는
`exec_command`가 `cmd`를 required로 선언하면 **canonical `cmd`를 그대로 보존**한다
(`tests/cursor-tool-definitions.test.ts:118-143`이 이를 잠근다). 반면
`shell_command`는 `command`로 재작성된다.

따라서 `??`는 두 가지를 잘못 처리한다. `command`가 공백이고 `cmd`가 유효할 때
공백을 택하고, 반대로 canonical `cmd`가 비었는데 비canonical `command`에 값이 있으면
통과시킨다.

정책을 명시적으로 정한다: **어느 필드든 비어 있지 않은 문자열이 하나라도 있으면 통과.**

```ts
const candidates = [args.command, args.cmd];
const hasCommand = candidates.some(
  value => typeof value === "string" && value.trim().length > 0,
);
if (!hasCommand) { /* reject */ }
```

이 가드의 목적은 스키마 준수 강제가 아니라 **빈 호출 차단**이다. 어느 쪽 필드로 오든
실행할 커맨드가 있으면 통과시키고, 정규화 책임은 기존 경로에 맡긴다.
두 필드가 충돌하는 경우(한쪽만 유효)의 정책을 테스트로 문서화한다.

APPEND: `tests/cursor-tool-arg-decoding.test.ts`

A-gate blocker 5 반영: 최초 5케이스는 전부 args 맵에 항목이 있어 `allowEmptyArgs: true`가
무의미했고, `toolSchemas`를 주지 않아 `cmd → command` 정규화 경로도 밟지 않았다.
아래처럼 확장한다.

| 케이스 | 목적 |
|---|---|
| `exec_command` + `{cmd: "echo ok"}` | 정상 통과 |
| `exec_command` + `{cmd: "   "}` | 공백 거부 |
| `shell_command` + `{command: "echo ok"}` | 정상 통과 |
| `shell_command` + `{command: ""}` | 빈 문자열 거부 |
| `exec_command` + `{cmd: 42}` | 비문자열 거부 |
| **`exec_command` + `args: {}`** | 인자 맵 자체가 빈 경우 (`allowEmptyArgs` 실제 활성화) |
| **`shell_command` + `args: {}`** | 같은 경로, 다른 alias |
| **schema 기반 정규화 케이스** | `toolSchemas`를 주어 `cmd → command` 재작성 후에도 판정이 유지되는지 |
| **`mapCursorProtobufServerMessage` 완료 경로** | `protobuf-events.ts:434-460`의 두 번째 `commitToolCall` 호출부 |

거부 케이스는 이벤트뿐 아니라 **상태**도 단언한다:
`state.openToolCalls.has(callId) === false`, `state.completedToolCalls.has(callId) === true`.

```ts
// The two types come from DIFFERENT modules — CursorServerMessage lives in types.ts:34,
// not in protobuf-events.ts. Add both imports to tests/cursor-tool-arg-decoding.test.ts:
import type { CursorProtobufEventState } from "../src/adapters/cursor/protobuf-events";
import type { CursorServerMessage } from "../src/adapters/cursor/types";

/** Rejection is one `error` event and no tool item; the call must also be closed out. */
function expectRejected(
  events: readonly CursorServerMessage[],
  state: CursorProtobufEventState,
  callId: string,
  toolName: string,
): void {
  expect(events).toEqual([{
    type: "error",
    message: `Cursor emitted ${toolName} without a non-empty command; the tool call was dropped.`,
  }]);
  expect(state.openToolCalls.has(callId)).toBe(false);
  expect(state.completedToolCalls.has(callId)).toBe(true);
}

function expectAccepted(
  events: readonly CursorServerMessage[],
  callId: string,
  toolName: string,
): void {
  expect(events[0]).toEqual({ type: "tool_call_start", id: callId, name: toolName });
  expect(events.at(-1)).toEqual({ type: "tool_call_end", id: callId });
}

test("shell bridge aliases reject empty or malformed commands across both wire fields", () => {
  // `args: {}` cases are why `allowEmptyArgs: true` is set — without them the option is inert.
  const cases = [
    { tool: "exec_command", args: { cmd: jsonBytes("echo ok") }, valid: true },
    { tool: "exec_command", args: { cmd: jsonBytes("   ") }, valid: false },
    { tool: "shell_command", args: { command: jsonBytes("echo ok") }, valid: true },
    { tool: "shell_command", args: { command: jsonBytes("") }, valid: false },
    { tool: "exec_command", args: { cmd: jsonBytes(42) }, valid: false },
    { tool: "exec_command", args: {}, valid: false },
    { tool: "shell_command", args: {}, valid: false },
    // Conflicting fields: a blank `command` must not veto a valid `cmd`. Nullish coalescing
    // would reject this; the any-non-empty-candidate policy accepts it.
    { tool: "exec_command", args: { command: jsonBytes(" "), cmd: jsonBytes("git status") }, valid: true },
  ] as const;

  for (const [index, entry] of cases.entries()) {
    const callId = `shell_${index}`;
    const state = createCursorProtobufEventState({ clientToolNames: [entry.tool] });
    const args = create(McpArgsSchema, {
      name: entry.tool,
      toolName: entry.tool,
      toolCallId: callId,
      providerIdentifier: "opencodex-responses",
      args: entry.args,
    });

    const events = mapSyntheticMcpExecToToolEvents(args, "fallback", {
      allowEmptyArgs: true,
      state,
    });

    if (entry.valid) expectAccepted(events, callId, entry.tool);
    else expectRejected(events, state, callId, entry.tool);
  }
});

test("rejection survives cmd-to-command schema normalization", () => {
  // A `shell_command` schema rewrites `cmd` into `command` (tool-definitions.ts:185-213).
  // The guard must still see an empty value after that rewrite.
  const callId = "shell_normalized";
  const state = createCursorProtobufEventState({
    clientToolNames: ["shell_command"],
    // `toolSchemas` is a Map, not a plain object (protobuf-events.ts:161-165).
    toolSchemas: new Map<string, unknown>([[
      "shell_command",
      {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    ]]),
  });
  const args = create(McpArgsSchema, {
    name: "shell_command",
    toolName: "shell_command",
    toolCallId: callId,
    providerIdentifier: "opencodex-responses",
    args: { cmd: jsonBytes("  ") },
  });

  const events = mapSyntheticMcpExecToToolEvents(args, "fallback", {
    allowEmptyArgs: true,
    state,
  });

  expectRejected(events, state, callId, "shell_command");
});

```

### interaction 완료 경로 테스트는 다른 파일에 넣는다

`protobuf-events.ts:434-460`의 두 번째 `commitToolCall` 호출부를 밟으려면
`interaction()` / `mcpToolCall()` 프레임 헬퍼가 필요한데, 이들은
`tests/cursor-protobuf-events.test.ts:25-51`에 **파일 로컬**로 정의돼 있어
다른 테스트 모듈에서 import할 수 없다. 헬퍼를 복제하지 말고 테스트를 그 파일에 추가한다.

APPEND: `tests/cursor-protobuf-events.test.ts`

```ts
test("the interaction-completion path rejects an empty bridge call", () => {
  // The synthetic MCP path (protobuf-events.ts:317-324) is not the only commit site;
  // this drives the interaction-update site at :434-460.
  const state = createCursorProtobufEventState({ clientToolNames: ["exec_command"] });

  // Established pattern from this file's existing call sites (:91, :112, :129).
  const toolCall = mcpToolCall("exec_command", { cmd: "" });
  const events = mapCursorProtobufServerMessage(interaction({
    case: "toolCallCompleted",
    value: create(ToolCallCompletedUpdateSchema, {
      callId: "call_1",
      modelCallId: "model_1",
      toolCall,
    }),
  }), state);

  expect(events.filter(event => event.type === "tool_call_start")).toEqual([]);
  expect(events.some(event =>
    event.type === "error" && event.message.includes("without a non-empty command"),
  )).toBe(true);
  // `mcpToolCall` hardcodes toolCallId "call_1".
  expect(state.openToolCalls.has("call_1")).toBe(false);
  expect(state.completedToolCalls.has("call_1")).toBe(true);
});
```

`ToolCallCompletedUpdateSchema`는 이 파일이 `:12`에서 이미 import한다.
`create`도 마찬가지다. 추가 import는 필요 없다.

RED→GREEN 근거: 수정 전에는 빈/잘못된 인자도 평범한 `start`/`end` 쌍이 되어
모든 `valid:false` 케이스의 `expectRejected`가 첫 단언에서 실패한다. 정규화 테스트와
interaction 테스트도 같은 이유로 실패한다.

## 활성화 시나리오

새 조건 분기는 `isCodexShellBridgeToolName(open.name)` 게이트와 그 안의
`hasCommand` 판정이다. 위 3개 `test()` 블록이 **10개 행위 케이스**로 두 분기와 두 호출
지점을 모두 밟는다 (테이블 8건 + 정규화 1건 + interaction 1건):
alias 2종 × 필드명 2종 × (빈/공백/타입오류/누락/충돌), 스키마 정규화 경로,
interaction 완료 경로. 관찰 가능한 효과는 `tool_call_start` 대신 단일 `error`가 나오고
`openToolCalls`에서 제거되며 `completedToolCalls`에 등록되는 것이다.

## 커밋

```
fix(cursor): stop injecting shell-alias hints and reject empty bridge calls (#429)

Co-authored-by: Markus Dunk <markus@markusdunk.com>
```

## 검증

```bash
bun test --isolate tests/cursor-tool-arg-decoding.test.ts tests/cursor-blob.test.ts tests/cursor-protobuf-events.test.ts
bun run typecheck
```

A-gate blocker 2: `tests/cursor-protobuf.test.ts`는 **존재하지 않는 파일**이다.
실제 파일명은 `tests/cursor-protobuf-events.test.ts`다. bun은 없는 인자를 조용히 무시해
2파일 40테스트만 돌았고, 관련 상태/정규화 33테스트가 통째로 빠졌다.

테스트 수 기준 (A-gate R2 blocker 4): **73은 변경 전 baseline**이다(3파일).
이 work-phase는 테스트를 3개 추가하므로 완료 후 기대치는 **76**이다.
73이 그대로 나오면 테스트가 실제로 추가되지 않았다는 신호다.

## 기존 테스트 수정 (A-gate blocker 1, Critical)

`tests/cursor-blob.test.ts:313-330`의
`"adds exec_command prompt hints for active shell requests when native exec is available"`가
`:330`에서 삭제 대상 힌트를 그대로 요구한다.

```ts
expect(actionText(bytes)).toContain("Use the Codex shell bridge tool listed this turn");
```

이 줄을 남기면 구현 직후 RED로 끝난다. 테스트를 아래 방향으로 고친다.

- 이름을 `"sends system shell guidance without mutating the user request"`로 변경
- 시스템 노트 단언(`"Shell commands use"`, `"exec_command"`)은 유지
- 사용자 액션 텍스트는 `toContain`이 아니라 **정확 일치**로 바꿔, 어떤 문구도
  덧붙지 않았음을 증명한다

```ts
expect(actionText(bytes)).toBe("Run: echo OCX via your shell tool, report stdout.");
```

PR head `f408f348`이 이미 같은 방향의 테스트 재작성을 포함한다.
