# Windows/Linux Deploy Stability — Loop 2 Plan (P)

- **Date:** 2026-07-02 · **Branch:** cursor-fixes · **Class:** C3
- **Input:** Codex whole-lifecycle RCA (15 ranked defects) + loop-1 backlog (F8).
- **Loop 2 scope (focused):** R4, R6, R11, R14, F8. Deferred to loop 3: R1/R2/R3/R5
  (port/identity/re-bake lifecycle redesign — needs joint design with macOS audit
  results), R7 (start lock), R8 (update-while-running), R9 (rename retry), R10 (`%*`
  reparse), R12/F9 (Linux non-systemd), R13 (WS CI lane), R15 (cursor sh -c).

## Changes (diff level)

**R4 — `src/codex-catalog.ts`: `.cmd` catalog probe is spawned shell-less → EINVAL, silently
swallowed (`catch { /* try next */ }`), so npm-only Codex installs never load the bundled
catalog on Windows.**
- New pure helper `codexExecInvocation(command: string, args: string[], platform = process.platform): { file: string; args: string[] }`
  (exported for tests): on win32 when `command` ends `.cmd`/`.bat` (case-insensitive) →
  `{ file: <SystemRoot>\System32\cmd.exe, args: ["/d", "/s", "/c", `"${command}" ${args.join(" ")}`] }`
  (args here are the fixed literals `debug models --bundled`; command is quoted). Otherwise
  passthrough.
- `runCodexDebugModels` uses the helper. Injectable `deps.execFileSync` unchanged.

**R6 — `src/process-control.ts`: graceful stop always posts to 127.0.0.1 even when the
server binds a different concrete host (`::1`, LAN IP).**
- New exported pure helper `gracefulStopHost(hostname: string | undefined): string`:
  `undefined`/""/"localhost"/wildcards ("0.0.0.0", "::", "[::]")/"127.0.0.1" → "127.0.0.1";
  "::1"/"[::1]" → "[::1]"; other IPv6 → bracketed; else the literal host.
- `stopProxyGracefully` reads `hostname` from the runtime state (`RuntimePortState`
  already records it, `config.ts:341-345`; `GracefulStopIo.readRuntime` return type gains
  `hostname?: string`).

**R11 — `src/oauth/callback-server.ts`: redirect URI advertises `localhost` (registered with
providers; must stay) but the listener binds IPv4-only 127.0.0.1 — Windows browsers
resolving localhost→::1 first hit refusal/wrong-server/timeouts.**
- Dual-bind: when `callbackHostname` is `localhost` and `callbackBindHostname` is
  `127.0.0.1`, additionally bind `::1` on the SAME resolved port, best-effort
  (try/catch — IPv4-only hosts skip silently). Both listeners share the fetch handler;
  both stopped in `finally` and on port-fallback re-create.
- New exported pure helper `loopbackBindHostnames(callbackHostname, bindHostname): string[]`
  for tests; `#createServer` returns the listener array.

**R14 — `src/config.ts` + `src/codex-paths.ts`: `OPENCODEX_HOME`/`CODEX_HOME` don't expand
`~`.**
- New exported `expandUserPath(raw: string): string` in `config.ts`: `~` alone or leading
  `~/`/`~\` → `homedir()` + rest; all else unchanged (no `%VAR%`/`$VAR` expansion — shells
  own that; documented in the helper comment).
- Apply in `resolveConfigDir()` (config.ts:21-27) and `resolveCodexHome()`
  (codex-paths.ts:5-23). No cycle: codex-paths → config is a new edge; config imports only
  node builtins/zod/types.

**F8 — `src/codex-shim.ts`: Git-Bash's extensionless `codex` sh launcher is not shimmed on
Windows (only .exe blocks, .cmd/.ps1 shimmed) → autostart silently absent for Git-Bash
users.**
- `findWindowsCodexTargets`: in each PATH dir also probe bare `codex` (exists, not shim,
  not directory) and add as a target alongside cmd/ps1.
- `writeShim` on win32: extensionless wrapper → `buildUnixCodexShim` with paths converted
  to forward slashes (new local `gitBashPath(p)` = backslash→slash; Git-Bash accepts
  `C:/...`), skip chmod on win32.

## Tests (bun test on macOS)

- `tests/codex-catalog*.test.ts` or new `tests/codex-exec-invocation.test.ts`:
  `codexExecInvocation` — `.cmd`/`.bat` on win32 → cmd.exe wrapper with quoted command;
  `.exe` on win32 and everything on posix → passthrough.
- `tests/process-control-graceful.test.ts` (extend): `gracefulStopHost` table; graceful
  stop URL uses runtime hostname `[::1]` / LAN IP; default stays 127.0.0.1.
- new `tests/oauth-callback-binds.test.ts`: `loopbackBindHostnames` matrix (localhost+127 →
  both; explicit redirectUri unchanged; non-loopback bind → single).
- `tests/config*.test.ts` or new: `expandUserPath` (`~`, `~/x`, `~\x`, `~user` untouched,
  absolute untouched); `getConfigDir()` honors `OPENCODEX_HOME=~/…`.
- `tests/codex-shim.test.ts` (extend): source-scan for bare-`codex` probing +
  forward-slash unix shim on win32; `gitBashPath` conversions via generated shim content
  (buildUnixCodexShim with `C:/...` inputs execs quoted forward-slash paths).

## Verification gate (C)
`bun x tsc --noEmit` + full `bun test ./tests/` (baseline 1255 pass / 0 fail).

## A verdict — FAIL, corrections applied

1. R4: adopted the repo `shell:true` convention (src/update.ts, bin/ocx.mjs) instead of a
   hand-built cmd.exe wrapper; the command path is pre-quoted since shell:true joins argv
   verbatim and npm paths commonly contain spaces.
2. R11: both single-server assumptions updated — `login()` finally stops the full listener
   array; the port-fallback path reads `servers[0].port`.
3. F8: the Unix shim's embedded token-file path is also forward-slash converted
   (`buildUnixCodexShim` gained an injectable tokenFile param).

## Audit questions (A)
1. `codexExecInvocation` cmd.exe quoting: `/s /c` + fully-quoted command string — confirm
   the composed line survives spaces & `&` in the command path.
2. Does anything else consume `#createServer`'s return shape / stop path in
   callback-server subclasses (grep providers) that dual-bind could break?
3. `expandUserPath` in `resolveCodexHome` runs at module load with `statSync` validation —
   confirm no test currently sets `CODEX_HOME=~...` expecting an error.
4. Existing tests exact-matching `execFileSync(command, args...)` call shape in
   codex-catalog (grep tests for `debug models --bundled` / execFileSync stubs whose
   expectations would change).
