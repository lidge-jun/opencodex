# Cursor Provider Live RCA — Codex exec heartbeat stall

Date: 2026-07-02
Owner: Boss RCA; implementation to gpt-5.5 employee.

## Symptom

`codex exec -m cursor/composer-2.5` and `codex exec -m cursor/claude-4.6-sonnet` route to ocx, receive `response.created`, then hang/reconnect while the proxy emits only `response.heartbeat`.

## Captured request

Captured Codex REQ#1: `/private/tmp/claude-501/-Users-jun--cli-jaw-3466/72f7168d-93c5-42a1-8529-a6a7e025ac09/scratchpad/reqbody_1.json`.

Facts:
- model: `cursor/claude-4.6-sonnet`
- tools: 17 total; shell tool is `function` named `exec_command`; hosted `web_search` and `image_generation` are present in raw Codex but parser drops hosted tools.
- final user text: `Run: echo OCX_CX_S46 via your shell tool, report stdout.`

## Disconfirmed hypotheses

- Not raw tool-call support: one-tool direct `/v1/responses` requests can emit function calls.
- Not hosted tools alone: hosted tools are dropped before Cursor and variants without them still stall.
- Not top-level fields: starting from a working minimal `run_shell` request, adding `reasoning`, `include:[reasoning.encrypted_content]`, `store:false`, `text`, `client_metadata`, `prompt_cache_key`, and Codex `instructions` all still completed.
- Not MCP empty: this failure is first-turn model planning stall, before continuation/MCP output.

## Positive live findings

Working baseline:
- `run_shell` tool, simple `{cmd}` schema, user text `Use run_shell to run: echo OCX. Report stdout.` succeeds.

Stall triggers:
- `exec_command` name, even with simple schema, can heartbeat-only.
- Full Codex `exec_command` schema can heartbeat-only.
- Sonnet stalls when final user says only `your shell tool`, even if the tool is named `run_shell` and instructions contain a general alias note.

Validated patch candidate:
- Transform Cursor-facing `exec_command` tool to `run_shell` with a compact schema containing at least `cmd` and optional `workdir`.
- Add a short Cursor-only system/instruction note: shell commands use `run_shell` with `{cmd}`.
- For the active final user message, when `exec_command` is available and the text looks like a shell/command request but does not mention `run_shell`, append a short hint: `Use run_shell for this shell command.`
- On the return path, map Cursor tool name `run_shell` back to Responses/Codex name `exec_command` before emitting `function_call` events.

Live proof using the full captured request shape, with only the candidate transform applied:
- `cursor/composer-2.5`: completed, emitted `run_shell {"cmd":"echo OCX_CX_S46"}`.
- `cursor/claude-4.6-sonnet`: completed, emitted `run_shell {"cmd":"echo OCX_CX_S46"}`.

## Implementation target

Files likely touched:
- `src/adapters/cursor/tool-definitions.ts`
- `src/adapters/cursor/protobuf-events.ts`
- `src/adapters/cursor/protobuf-request.ts`
- `src/adapters/cursor/live-transport.ts` if state/schema mapping needs explicit alias handling
- focused tests under `tests/cursor-*.test.ts`

Suggested API shape:

```ts
export const CODEX_EXEC_COMMAND_TOOL = "exec_command";
export const CURSOR_RUN_SHELL_TOOL = "run_shell";

export function cursorToolWireName(tool: OcxTool): string {
  const original = namespacedToolName(tool.namespace, tool.name);
  return !tool.namespace && tool.name === CODEX_EXEC_COMMAND_TOOL ? CURSOR_RUN_SHELL_TOOL : original;
}

export function responsesToolNameFromCursorWire(name: string): string {
  return name === CURSOR_RUN_SHELL_TOOL ? CODEX_EXEC_COMMAND_TOOL : name;
}
```

When building Cursor tool definitions for `exec_command`, use the alias name and compact schema:

```ts
parameters: {
  type: "object",
  properties: {
    cmd: { type: "string", description: "Shell command to execute." },
    workdir: { type: "string", description: "Working directory for the command." }
  },
  required: ["cmd"],
  additionalProperties: false
}
```

Return-path mapping points:
- `recordToolCall` should accept advertised alias names but store/emit the original Responses name.
- `mapSyntheticMcpExecToToolEvents` stateless path should also map `run_shell` to `exec_command`.
- `toolSchemas` should remain keyed by Cursor wire alias so arg normalization still works.

Prompt mapping points:
- Add Cursor-only shell alias note to system prompt/root prompt when request has `exec_command`.
- Rewrite or append active user text only for command-like requests and only when it lacks `run_shell`.

Acceptance:
- Existing Cursor unit tests remain green.
- New tests prove: `exec_command` is advertised as `run_shell`; `run_shell` returned by Cursor emits `exec_command`; active shell request gets alias hint; non-command user text is not polluted.
- Live verification: `codex exec -m cursor/composer-2.5 ...` and `codex exec -m cursor/claude-4.6-sonnet ...` both complete tool-call roundtrip.
