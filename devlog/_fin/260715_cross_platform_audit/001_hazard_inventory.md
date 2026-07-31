# 001 — Cross-platform hazard inventory (survey record)

Source: read-only survey by sol explorer subagent (id 019f6516-fd7b-72f3-b60e-068274fcc6d0,
2026-07-15), 6 hazard classes, plus main-session spot-checks and empirical rebuttal probes.

## Confirmed defects

### D1 — skill-elision basename fails on Windows separators (HIGH)

- `src/claude/inbound.ts:183`: `const base = dir.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";`
- Input: first line of the skill text block, `Base directory for this skill: <dir>` —
  a Claude Code client path. On Windows: `C:\Users\...\claude-api`.
- Effect: basename extraction returns the whole lowercased path, never matches
  `DEFAULT_BLOCKED_SKILLS`, so the ~790K-char bundle rides through to routed models on
  every turn. Live incident: user's session JSONL row 14 = 789,683 chars; usage.jsonl
  showed ~297K-token inputs to gpt-5.6-sol.
- Repo precedent for the fix: `src/codex/inject.ts:311` normalizes with
  `path.replace(/\\/g, "/")` before splitting.

### D2 (survey P4-1) — `spawn("claude", ...)` without Windows `.cmd` handling (HIGH)

- `src/cli/claude.ts:179`: `spawn("claude", args, { stdio: "inherit", env })`.
- On Windows, npm installs `claude.cmd`; Node/Bun cannot launch `.cmd` shell-less
  (post-CVE-2024-27980 behavior). The repo already documents this convention at
  `src/codex/catalog.ts:610-614` and handles it in `bin/ocx.mjs:97-148` and
  `src/update/index.ts:53-64` — this site predates/missed the convention.
- Effect: `ocx claude` fails with ENOENT on Windows npm installs.

### D3 (survey P4-2) — bare `codex` spawn bypasses `codexExecInvocation()` (HIGH)

- `src/cli/v2.ts:27-31` and `src/server/management-api.ts:613-617`: 
  `const command = process.env.CODEX_CLI_PATH?.trim() || "codex"; execFileSync(command, [...])`.
- Same `.cmd` failure class as D2; the shared handler already exists at
  `src/codex/catalog.ts:615-633` (`codexExecInvocation`) but is not used here.

### D4 (survey P4-3) — `spawn("sh", ["-c", command])` on Windows (MEDIUM)

- `src/adapters/cursor/native-exec-desktop.ts:128`: desktop executor runs user-configured
  `computerUseCommand`/`recordScreenCommand` via `sh -c`; ordinary Windows has no `sh`.
- Scope note: only reachable when a provider config sets `desktopExecutor` commands
  (cursor native-exec desktop lane).
- The `child.kill("SIGKILL")` half of the survey finding is REBUTTED (see below).

### D5 (survey P1-1) — `relPath()` home-prefix boundary + case semantics (LOW)

- `src/codex/project-config-warnings.ts:225-230`: 
  `abs.toLowerCase().startsWith(home.toLowerCase())` then `abs.slice(home.length)`.
- Two flaws: no component boundary (`C:\Users\bob2\x` renders as inside `~` for home
  `C:\Users\bob`), and case-insensitive comparison on case-sensitive POSIX filesystems.
- Display-only (warning path rendering); low severity.

## Rebutted survey findings (recorded, not dropped)

### R1 — survey P5-1/P5-2: CRLF breaks TOML-lite parsing — REFUTED

Claim: trailing `\r` after values defeats the kv/bool/number regexes in
`src/codex/project-config-warnings.ts:57-72` and `src/codex/features.ts:67-79`.
Empirical probe (bun eval, 2026-07-15, main session): all six cases MATCH with `\r`
present — quoted value, bare value, bool body (m-flag), table header, features header
line-split, numeric value — because JS `\s`/`\s*$` absorbs `\r` and `[^\s#]+` stops
before it. Verdict: SAFE. (Residual: adding CRLF fixtures to tests is cheap insurance,
optional, not a defect fix.)

### R2 — survey P4-3 (half): `child.kill("SIGKILL")` not portable — REFUTED

Node (and Bun) on Windows map `SIGKILL` to `TerminateProcess`; `kill("SIGKILL")` is a
documented supported termination path. Only the `sh -c` spawn half of P4-3 stands (D4).

## Safe-by-construction inventory (survey, spot-checked)

- `src/codex/inject.ts:311` — normalizes `\` before split. `src/codex/home.ts:97-128` —
  deliberate `path.posix` on WSL mount paths. `src/cli/doctor.ts:55,70,236` — `/proc`
  reads gated to Linux/DI.
- Virtual `provider/model` ids and URL pathnames legitimately use `/`:
  `src/codex/catalog.ts:518,837,1359,1425`, `src/router.ts:167`,
  `src/claude/agents-inject.ts:55`, `src/server/index.ts:261,364,475`,
  `src/server/management-api.ts:1209`, `src/adapters/kiro-images.ts:21,110` (MIME).
- Env/home hygiene: `homedir()` defaults throughout; `src/lib/gcp-adc.ts:73` handles
  APPDATA; `src/codex/plugins-doctor.ts:111` checks LOCALAPPDATA/PROGRAMFILES/APPDATA;
  `src/server/system-env.ts:76,93` HOME reads are darwin-gated.
- Spawn hygiene present elsewhere: `bin/ocx.mjs:97-148`, `src/update/index.ts:53-64`
  (npm.cmd), `src/lib/process-control.ts:100-105` (taskkill.exe),
  `src/lib/open-url.ts:14-20` (open/rundll32/xdg-open), `src/service.ts` (launchd/
  Task Scheduler/systemd split), `src/codex/shim.ts` (per-platform shims).
- CRLF-aware readers: `src/usage/log.ts:96`, `src/usage/debug.ts:51,79` use `/\r?\n/`;
  JSONL readers tolerate `\r` as JSON whitespace (`src/codex/history-provider.ts:255-263`).
- Test masking noted: `tests/cursor-desktop-exec.test.ts:22-24` uses POSIX-only commands
  (cat/printf), so the suite can't exercise the D4 Windows path — 020 tests must inject
  platform instead of relying on host behavior.
