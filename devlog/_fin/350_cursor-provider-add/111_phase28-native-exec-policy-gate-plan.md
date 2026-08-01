# 350.111 — Cursor Native-Exec Deny-by-Default Policy Gate (work-phase 28)

Date: 2026-06-27
Branch: dev
Work phase: close the **#1 release-blocking** finding from the GPT Pro plain review (260627) — the live
Cursor native-exec bridge executes server-requested file writes/deletes, shell commands, and fetches
with **no policy boundary**.

> Status: **PLAN** (remediation band `111`–`118`, opens on the GPT Pro review of push `e0d6312`).
> This is the first and highest-priority plan. C4-class (security / destructive ops) — needs explicit
> user opt-in before any non-`deny` mode ships.

---

## 1. Easy explanation

Right now, when a real Cursor server tells opencodex "write this file" / "delete that folder" /
"run this shell command" / "fetch this URL", opencodex **just does it** — anywhere on disk, any
command, any URL. There is no on/off switch and no "only inside this folder" fence. A live Cursor
turn can therefore touch the whole machine. The fix is a **deny-by-default policy**: every native
operation is refused unless the user explicitly turns it on, and writes/reads are fenced to a
workspace root. Refusals are returned as the **protobuf typed rejection** Cursor already understands,
so the turn never hangs — it just gets told "tool not available".

## 2. Pre-write evidence (current code + reference)

### Current opencodex — direct execution, no gate
- `src/adapters/cursor/native-exec.ts:47-76` — `handleCursorNativeExec` dispatches **every** case
  (`readArgs`, `writeArgs`, `deleteArgs`, `lsArgs`, `grepArgs`, `shellArgs`, `shellStreamArgs`,
  `backgroundShellSpawnArgs`, `writeShellStdinArgs`, `fetchArgs`, `mcpArgs`, … `computerUseArgs`,
  `recordScreenArgs`) straight to its executor. No policy param.
- `src/adapters/cursor/native-exec-fs.ts:70-95` `writeExec` → `mkdirSync(...,{recursive})` +
  `writeFileSync(resolve(args.path), …)` — arbitrary absolute path, auto-creates parents.
- `src/adapters/cursor/native-exec-fs.ts:97-125` `deleteExec` → `rmSync(path,{recursive:true,force:true})`
  — recursive force delete of any resolved path.
- `src/adapters/cursor/native-exec-shell.ts:31` `spawnSync(args.command,{shell:true,…})`;
  `:71`, `:115` `spawn(args.command,{shell:true})` — full shell, any command.
- `src/adapters/cursor/native-exec-network.ts:14-15` `fetchImpl(args.url)` + `response.text()` — any
  host (incl. localhost / private / metadata IPs), unbounded body.
- `src/adapters/cursor/live-transport.ts:199-202` — the live path calls `handleCursorNativeExec(...)`
  with **no deps/policy** and writes the replies back to the stream.
- `src/adapters/cursor/exec-policy.ts` — MISLEADING name: it only serves the **legacy mock transport**
  (`cursorExecResult`, `CURSOR_EXEC_CASES_DENIED`); it is NOT consulted by the live path. (grep: the
  live transport imports `native-exec`, never `exec-policy`.)

### jawcode reference — gated, typed rejection by default
(from research of `jawcode/packages/ai/src/providers/cursor.ts`)
- jawcode does **not** execute natively in the AI provider. Server exec is dispatched through optional
  `execHandlers`; a missing handler returns a **typed rejection**:
  `resolveExecHandler` → `{ execResult: buildRejected("Tool not available") }`
  (`jawcode cursor.ts:1256-1258`).
- It imports `ReadRejectedSchema`, `WriteRejectedSchema`(`DeleteRejectedSchema`),
  `ShellRejectedSchema`, `LsRejectedSchema`, `DiagnosticsRejectedSchema`, … and builds e.g.
  `buildReadRejectedResult(path, reason)` → `ReadResultSchema{ result:{case:"rejected", value:{path,reason}} }`
  (`jawcode cursor.ts:1376-1382`).
- Unimplemented bridges (`backgroundShellSpawnArgs`, `fetchArgs`) hardcode `reason:"Not implemented"`
  rejections (`jawcode cursor.ts:1100-1114`, `1128-1139`).
- **Conclusion:** the safe default is "decline with a typed rejection", and opencodex already imports
  the same generated schemas (it builds the *success* variants in `native-exec-fs.ts`), so the
  `rejected` case is available on the same `*ResultSchema`.

## 3. Decision

Introduce a real `CursorExecPolicy` consumed by the **live** path. Default = **deny everything**.
Reuse the generated `rejected` result variants for refusals (jawcode parity) — never throw, never
hang the turn. The existing `exec-policy.ts` (legacy mock) is left untouched; the new policy lives in
a new file to avoid conflating the two transports.

## 4. Diff-level plan

### NEW `src/adapters/cursor/native-exec-policy.ts`

```ts
export type CursorExecMode = "deny" | "readOnly" | "workspaceWrite" | "trustedFullAccess";

export interface CursorExecPolicy {
  mode: CursorExecMode;
  workspaceRoot?: string;     // absolute; required for any read/write/ls/grep
  allowShell: boolean;        // default false
  allowFetch: boolean;        // default false
  allowDelete: boolean;       // default false even in workspaceWrite
  allowMcp: boolean;
  allowComputerUse: boolean;
  allowScreen: boolean;
  maxReadBytes: number;       // default 1_000_000
  maxOutputBytes: number;     // default 1_000_000
  allowedFetchHosts?: string[]; // empty => none
}

export const DEFAULT_CURSOR_EXEC_POLICY: CursorExecPolicy = {
  mode: "deny", workspaceRoot: undefined,
  allowShell: false, allowFetch: false, allowDelete: false,
  allowMcp: false, allowComputerUse: false, allowScreen: false,
  maxReadBytes: 1_000_000, maxOutputBytes: 1_000_000, allowedFetchHosts: [],
};

// Per exec case → required capability check. Returns a deny reason or null (allowed).
export function cursorExecDenyReason(execCase: string, policy: CursorExecPolicy): string | null { … }

// Resolve a requested path against the workspace fence. Rejects abs-outside, `..` escape,
// symlink escape, and missing workspaceRoot. Returns the safe absolute path or throws a tagged
// PolicyPathError (mapped to a typed rejection by the caller).
export function resolveInsideWorkspace(policy: CursorExecPolicy, requested: string): string { … }
```

Mode → capability matrix:
| case | deny | readOnly | workspaceWrite | trustedFullAccess |
|------|------|----------|----------------|-------------------|
| read / ls / grep | reject | allow (in root, capped) | allow | allow |
| write | reject | reject | allow (in root) | allow |
| delete | reject | reject | reject unless `allowDelete` | allow |
| shell* / backgroundShell / stdin | reject | reject | reject unless `allowShell` | allow if `allowShell` |
| fetch | reject | reject | reject unless `allowFetch` | allow if `allowFetch` |
| mcp / computerUse / recordScreen | reject | reject | reject unless flag | allow if flag |
| requestContext / diagnostics / kv-blob | **always allowed** (benign protocol) | … | … | … |

### MODIFY `src/adapters/cursor/native-exec.ts`
- `handleCursorNativeExec(execMsg, deps, policy = DEFAULT_CURSOR_EXEC_POLICY)`.
- At the top of each case, call `cursorExecDenyReason(execCase, policy)`; if non-null, return the
  **typed rejection** for that case (`ReadResultSchema{rejected}`, `WriteResultSchema{rejected}`,
  `DeleteResultSchema{rejected}`, `ShellResultSchema{... }`, etc.) instead of dispatching.
- For allowed read/write/ls/grep, pass `policy.workspaceRoot` + caps into the fs executors.
- `requestContextArgs`, `diagnosticsArgs`, and KV blob handling stay allowed regardless of mode.
- Return a small audit signal (see `117`): the set of exec cases that were **requested** this turn and
  whether each was `executed` or `denied`, so the adapter error message can stop lying (finding #3).

### MODIFY `native-exec-fs.ts` / `native-exec-shell.ts` / `native-exec-network.ts`
- `*Exec(execMsg, policy)` — fs ops resolve through `resolveInsideWorkspace`; cap reads at
  `maxReadBytes` and set `truncated:true`; never `rmSync` recursive unless `allowDelete`.
- shell ops: keep but only reachable when `allowShell` (gate is in `native-exec.ts`); add timeout +
  output cap + process cleanup; keep `shell:true` behind `trustedFullAccess` documentation.
- fetch: only reachable when `allowFetch`; block loopback/link-local/private/metadata hosts unless on
  `allowedFetchHosts`; stream with a `maxOutputBytes` cap instead of unconditional `response.text()`.

### MODIFY `src/adapters/cursor/live-transport.ts`
- Thread a `policy: CursorExecPolicy` field on `LiveCursorTransport` (from `input.provider` config,
  default deny) and pass it into `handleCursorNativeExec(...)` at `:200`.

### MODIFY `src/adapters/cursor/transport.ts` + provider config
- Read `provider.cursorExecPolicy` (new optional `OcxProviderConfig` field) → build a
  `CursorExecPolicy`; absent ⇒ `DEFAULT_CURSOR_EXEC_POLICY` (deny). Document in config.

## 5. Out of scope (separate later phases)
- Wiring opencodex's own executor hooks (so allowed modes do real work safely) — `112`+ track auth,
  this phase only adds the **gate** and the typed rejections. A follow-up may map allowed cases to a
  sandboxed executor.
- MCP/computer-use/screen real execution — denied by default here; enabling is a separate C4 decision.

## 6. Verification plan (non-destructive)
- NEW `tests/cursor-native-exec-policy.test.ts`:
  - default policy denies `writeArgs/deleteArgs/shellArgs/shellStreamArgs/backgroundShellSpawnArgs/fetchArgs`
    and returns the typed `rejected` result (no fs/network touched — assert with a temp dir that
    nothing was created and a mock `fetch` that was never called).
  - `readOnly` allows read/ls/grep **only inside** a temp `workspaceRoot`; `../` and absolute-outside
    paths reject; oversized read truncates.
  - `allowDelete:false` rejects delete even in `workspaceWrite`.
  - `requestContextArgs` + `diagnosticsArgs` still succeed in `deny` mode.
- `bun test tests/cursor-*.test.ts tests/router.test.ts` → no regression.
- `bun x tsc --noEmit` → exit 0.
- NO live Cursor stream, NO real shell/file/delete/fetch.

## 7. Cross-references
- GPT Pro review 260627 — finding **#1 (Critical)**, both review passes.
- jawcode `packages/ai/src/providers/cursor.ts:1256-1258, 1376-1382, 1100-1139` — typed-rejection default.
- `112` (auth forwarding) · `113` (lifecycle) · `117` (false-safety error text) · `118` (index/test map).
