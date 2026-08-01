# 020 — Windows spawn hygiene: launcher + call-site adoption (D2, D3, D4; wp2)

Three spawn sites fail on Windows npm installs (`.cmd` shims need a shell post
CVE-2024-27980) or assume `sh`. Audit round 1 ruled `codexExecInvocation()` NOT generally
reusable (bare names → `shell:false`; `shell:true` + args array has no escaping). This
phase adds a real launcher and adopts it.

## Change map

| File | Op | What |
|------|----|------|
| `src/lib/win-exec.ts` | NEW | resolver + CMD escaping + invocation builders (pure, DI-friendly) |
| `tests/win-exec.test.ts` | NEW | unit tests for resolution/escaping/invocation shapes |
| `src/cli/claude.ts` | MODIFY | spawn via `commandInvocation("claude", args)`; 9009 hint |
| `src/cli/v2.ts` | MODIFY | resolve `codex` through launcher (fixed-token args) |
| `src/server/management-api.ts` | MODIFY | same as v2.ts for the toggle fallback |
| `src/adapters/cursor/native-exec-desktop.ts` | MODIFY | platform shell via `shellInvocation(command)` |
| `tests/claude-cli.test.ts` | MODIFY | win32 invocation-shape + arg-preservation cases |
| `tests/codex-v2-gate.test.ts` | MODIFY | win32 invocation case for `runCodexFeatures` |
| `tests/cursor-desktop-exec.test.ts` | MODIFY | win32 shell-shape cases (both commands) |

## NEW `src/lib/win-exec.ts` (design, copy-paste level)

```ts
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** cross-spawn escaping (lib/util/escape.js): quote arg for cmd.exe /d /s /c. */
export function escapeCmdArg(arg: string, doubleEscape = false): string {
  let out = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  out = `"${out}"`.replace(CMD_META, "^$1");
  return doubleEscape ? out.replace(CMD_META, "^$1") : out;
}
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

export interface ResolveDeps { env?: Record<string, string | undefined>; exists?: (p: string) => boolean }

/** Bare command -> first existing PATH x PATHEXT hit on win32; otherwise unchanged. */
export function resolveWindowsCommand(command: string, deps: ResolveDeps = {}): string {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  if (extname(command) || command.includes("\\") || command.includes("/") || isAbsolute(command)) return command;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

export interface SpawnInvocation {
  file: string; args: string[];
  options: { shell?: boolean; windowsVerbatimArguments?: boolean };
}

/** Platform-safe invocation preserving argument boundaries (cross-spawn parse.js). */
export function commandInvocation(
  command: string, args: readonly string[],
  platform: NodeJS.Platform = process.platform, deps: ResolveDeps = {},
): SpawnInvocation {
  if (platform !== "win32") return { file: command, args: [...args], options: {} };
  const resolved = resolveWindowsCommand(command, deps);
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args: [...args], options: {} };
  const env = deps.env ?? process.env;
  const line = [escapeCmdCommand(resolved), ...args.map(a => escapeCmdArg(a, true))].join(" ");
  return {
    file: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/** `sh -c` analog per platform; command string content VERBATIM, outer quotes for /s. */
export function shellInvocation(
  command: string, platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): SpawnInvocation {
  if (platform !== "win32") return { file: "sh", args: ["-c", command], options: {} };
  return {
    file: env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    options: { windowsVerbatimArguments: true },
  };
}
```

Note: `escapeCmdArg(_, true)` double-escapes because the target is a `.cmd` shim
(cmd parses the line twice) — exactly cross-spawn's `isCmdShim` branch. `.exe` targets
never take this path (plain `shell:false` spawn preserves args natively).

## Diff — `src/cli/claude.ts:179` (D2)

```diff
-    const child = spawn("claude", args, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
+    const inv = commandInvocation("claude", args);
+    const child = spawn(inv.file, inv.args, { stdio: "inherit", env: env as NodeJS.ProcessEnv, ...inv.options });
     child.on("error", (err: NodeJS.ErrnoException) => { ... });  // unchanged
     child.on("exit", (code, signal) => {
+      // cmd.exe reports command-not-found as exit 9009; keep the install hint reachable on win32.
+      if (process.platform === "win32" && code === 9009) {
+        console.error("❌ `claude` CLI not found. Install it first: npm install -g @anthropic-ai/claude-code");
+      }
       resolve(signal ? 1 : code ?? 0);
     });
```

(+ `import { commandInvocation } from "../lib/win-exec";`)

## Diff — `src/cli/v2.ts:27-31` and `src/server/management-api.ts:613-617` (D3)

Fixed-token args (`["features", action, "multi_agent_v2"]`), so the launcher is used for
resolution + boundary-safe invocation; `CODEX_CLI_PATH` (may be an explicit `.cmd`/path)
flows through unchanged:

```diff
 const command = process.env.CODEX_CLI_PATH?.trim() || "codex";
-exec(command, ["features", action, "multi_agent_v2"]);
+const inv = commandInvocation(command, ["features", action, "multi_agent_v2"]);
+exec(inv.file, inv.args, inv.options);
```

`V2CliDeps.execFile` signature widens to `(file: string, args: string[], options?: ...)`;
the management-api inline fallback gets the identical treatment (its `execFileSync`
options merge `inv.options`).

## Diff — `src/adapters/cursor/native-exec-desktop.ts:128` (D4)

```diff
-    const child = spawn("sh", ["-c", command], {
+    const inv = shellInvocation(command);
+    const child = spawn(inv.file, inv.args, {
       cwd: config.cwd,
       env: config.env ? { ...process.env, ...config.env } : process.env,
       stdio: ["pipe", "pipe", "pipe"],
+      ...inv.options,
     });
```

Contract (docs): `desktopExecutor` commands are platform-native shell syntax — POSIX sh
on macOS/Linux, CMD on Windows. Effective Windows form for a quoted exe path:
`cmd.exe /d /s /c ""C:\Program Files\executor.exe" --json"` (audit round-2 blocker).

## Tests (activation table owners)

- `tests/win-exec.test.ts` (NEW): resolution (.exe beats .cmd via PATHEXT order; explicit
  `CODEX_CLI_PATH` with extension untouched; bare name miss → unchanged), escaping
  (spaces, embedded quotes, trailing backslashes, `%PATH%`, `&&`, `^`), invocation shapes
  (.exe → plain; .cmd → ComSpec + `/d /s /c` + outer-quoted line + verbatim flag; posix →
  passthrough).
- `tests/claude-cli.test.ts`: injected-platform win32 case asserting exact cmd.exe argv
  for `ocx claude`; arg-preservation case `["chat", "hello world", "a\"b", "50%"]`.
  (Requires exporting a pure `claudeSpawnInvocation(args, platform, deps)` or passing
  platform/deps through — implementer's choice, tests own the shape either way.)
- `tests/codex-v2-gate.test.ts`: `runCodexFeatures` win32 invocation via injected
  `execFile` capturing `(file, args, options)`.
- `tests/cursor-desktop-exec.test.ts`: `shellInvocation` shapes for BOTH
  `computerUseCommand` and `recordScreenCommand` fixtures, incl. quoted exe path +
  metachars; existing POSIX e2e tests unchanged.

## Accept criteria

- All new invocation-shape tests green; existing POSIX behavior byte-identical
  (`sh -c` on darwin/linux, same argv). Full gates at C.
- Honest residual: real-Windows smoke test cannot run from this macOS host; all win32
  behavior is proven at invocation-shape level via injected seams. Follow-up recorded in D.

## Out of scope

- `bin/ocx.mjs` / `src/update/index.ts` npm spawns (fixed tokens, already shell-gated,
  proven in the field); `codexExecInvocation()` callers inside catalog.ts (fixed tokens,
  documented convention) — not defects, left untouched.
## Implementation-P amendments (wp2, 2026-07-15)

### wp2 audit round-1 fold-backs (4 blockers, all accepted)

1. **Shim-only double-escape (High):** `doubleEscape` is NOT unconditional — mirror
   cross-spawn exactly: `const IS_CMD_SHIM = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;`
   `escapeCmdArg(a, IS_CMD_SHIM.test(resolved))`. Global npm shims
   (`%APPDATA%\npm\claude.cmd`) and custom `CODEX_CLI_PATH` batch files get SINGLE
   escaping. Tests cover both: `.bin\x.cmd` double-escaped, `C:\npm\claude.cmd`
   single-escaped.
2. **win32 path grammar (Med):** `resolveWindowsCommand` uses `node:path`'s `win32`
   namespace internally (`win32.delimiter`, `win32.join`, `win32.extname`,
   `win32.isAbsolute`) — it only ever runs for win32, so host-POSIX grammar must not
   leak in. Tests use real Windows-shaped PATH strings (`C:\bin;D:\tools`).
3. **v2 default executor options merge (High):** copy-paste level —
   `execFileSync(file, args, { stdio: ["ignore","pipe","pipe"], timeout: 15_000,
   windowsHide: true, ...options })`; identical merge in the management-api inline
   fallback. `V2CliDeps.execFile` third param optional so existing 2-arg injected fns
   stay assignable.
4. **9009 hint owning test (Med):** extract pure
   `claudeNotFoundHint(code, signal, platform): string | null` (hint only when
   `platform==="win32" && code===9009 && !signal`); exit handler prints it when
   non-null. Owning test: pure-function cases incl. signal-exit suppression.
   (ENOENT handler keeps owning the non-win32/not-found path.)

Stale check: all four call-site anchors re-verified after wp1's commit fe1a5ea2 (only
inbound.ts/tests moved). Owner-test reconnaissance refined the integration choices the
doc left to the implementer:

- **D3 consolidation:** `src/cli/v2.ts` exports `codexFeaturesInvocation(action,
  platform?, deps?)` → `commandInvocation(CODEX_CLI_PATH || "codex", ["features",
  action, "multi_agent_v2"], ...)`. Both `runCodexFeatures` and the management-api
  inline toggle fallback consume it — one source of truth, pure and win32-testable
  (tests/codex-v2-gate.test.ts "cli surface" describe already injects execFile).
- **D2 test ownership:** the call site reduces to `commandInvocation("claude", args)`;
  tests/claude-cli.test.ts asserts the exact win32 cmd.exe argv + arg preservation by
  calling the same pure function with injected env/exists (fake PATH with claude.cmd).
- **D4 test ownership:** `runExternalJson` gains no spawn DI; instead
  tests/cursor-desktop-exec.test.ts asserts `shellInvocation` shapes (win32 + posix)
  for BOTH command fixtures incl. quoted exe path + metachars, and the existing POSIX
  e2e tests prove the sh path stays byte-identical.
