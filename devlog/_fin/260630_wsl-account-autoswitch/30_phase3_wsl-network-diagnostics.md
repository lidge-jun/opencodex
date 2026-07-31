# 30 - Phase 3: WSL networking diagnostics

Purpose: give a WSL2 user (and us) a single command that explains *why* WHAM
quota never populated, instead of leaving auto-switch silently stuck on
`unknown=100`. This is root-cause #2 in the MOC. The command reports paths,
filesystem type, proxy env, and a live WHAM reachability probe. It does not
touch networking - diagnosis only.

## Command surface decision

No `doctor` verb exists today. The CLI command table is a single `switch
(command)` in src/cli.ts:370-494 (`init`, `start`, `stop`, `status`, `ensure`,
`login`, `sync`, `service`, `codex-shim`, `update`, ...). The fallthrough at
src/cli.ts:492-494 prints `Unknown command` and usage.

Decision: add a new top-level `ocx doctor` verb. It is read-only and parallels
the existing `status` handler, so it slots in as a sibling `case "doctor"`
rather than overloading `status` (which is process/port oriented via
`collectStatus`, imported at src/cli.ts:18).

## Tier-2 proven facts (cite, do not re-search)

- WSL defaults to NAT networking; mirrored mode targets IPv6/VPN compatibility.
  (MS WSL networking: https://learn.microsoft.com/en-us/windows/wsl/networking)
- `autoProxy=true` is required for WSL to inherit Windows' HTTP proxy. (same)
- Bun `fetch` honors `$HTTP_PROXY`/`$HTTPS_PROXY` only if they are present in the
  WSL process env, and supports a per-call `proxy` option.
  (Bun docs: https://bun.com/docs/guides/http/proxy)

Implication: a Windows-side proxy or VPN can leave the WSL process env with no
`*_PROXY` set, so Bun `fetch` to `chatgpt.com` quietly fails or hangs, and the
8s `AbortSignal.timeout(8000)` in src/codex-auth-api.ts:195 / :242 fires. Both
WHAM fetch paths swallow the error and return `quota: null`
(src/codex-auth-api.ts:223-225, :258-263), so the symptom is invisible.

## What the command reports

1. Resolved state dirs and existence:
   - `CODEX_HOME` via src/codex-paths.ts:25 (`CODEX_HOME`), plus `auth.json`
     existence the way `readCodexTokens` checks it
     (src/codex-auth-collision.ts:8-12).
   - `OPENCODEX_HOME` via `getConfigDir()` (src/config.ts:148-150, resolver at
     :21-27) and whether `config.json` exists (`getConfigPath`,
     src/config.ts:152-154).
2. Filesystem type of each state dir: detect drvfs / `/mnt/*` mounts (the
   `/mnt/c` risk surface called out in MOC root-cause #4). Read `/proc/mounts`
   and match the longest mount prefix covering the resolved path; flag
   `fstype === "drvfs"` or a `/mnt/<drive>` path.
3. Proxy-related env vars actually visible to this process: `HTTP_PROXY`,
   `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (and lowercase variants). Report
   present/absent only - never print credentials embedded in a proxy URL.
4. Live WHAM reachability probe to `https://chatgpt.com/backend-api/wham/usage`
   (the exact URL used in src/codex-auth-api.ts:193, :239) with timing and a
   classified error code. Uses the main token from `readCodexTokens()` when
   present; otherwise probes unauthenticated and reports the HTTP status (a 401
   still proves the network path is open).

## Reference: exact diagnostic shell commands (from investigation)

These are the manual commands the TS implementation mirrors. They are reference
only; `ocx doctor` does not shell out.

```sh
# DNS resolution for the WHAM host
getent hosts chatgpt.com

# TLS + headers reachability with verbose connect trace and timing
curl -Iv --max-time 8 https://chatgpt.com/backend-api/wham/usage

# Bun fetch probe - matches the runtime path (env-based proxy, 8s timeout)
bun -e 'const t=performance.now();
try {
  const r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    signal: AbortSignal.timeout(8000),
  });
  console.log("status", r.status, "ms", Math.round(performance.now()-t));
} catch (e) {
  console.log("error", (e && e.name) || String(e), "ms", Math.round(performance.now()-t));
}'

# State dir filesystem type (drvfs => Windows-mounted)
findmnt -no FSTYPE,TARGET --target "$HOME/.codex"
findmnt -no FSTYPE,TARGET --target "$HOME/.opencodex"

# Proxy env actually visible to the WSL process
env | grep -iE '^(http|https|all|no)_proxy=' || echo 'no *_PROXY set'
```

## Proposed TS implementation outline

NEW `src/doctor.ts`

- `export async function runDoctor(): Promise<void>` - prints a sectioned,
  ASCII report and exits 0 (diagnostics never fail the process).
- `collectPaths()`: build rows for `CODEX_HOME` (src/codex-paths.ts:25),
  `CODEX_HOME/auth.json`, `OPENCODEX_HOME` (`getConfigDir`), and
  `OPENCODEX_HOME/config.json` (`getConfigPath`), each with `exists`
  (`existsSync`) and resolved absolute path.
- `detectFsType(path)`: parse `/proc/mounts` (absent off-Linux -> "n/a"),
  pick the longest mount-point prefix of `path`, return `{ fstype, mount,
  isDrvfs, isMntDrive }`. `isMntDrive` matches `^/mnt/[a-z]/`.
- `collectProxyEnv()`: map the four proxy keys (upper + lower case) to
  present/absent booleans; do not echo values.
- `probeWham()`: replicate the runtime fetch shape from
  src/codex-auth-api.ts:193-196 - same URL, `AbortSignal.timeout(8000)`, and
  `Authorization`/`ChatGPT-Account-Id` headers from `readCodexTokens()` when
  available. Return `{ ok, status, durationMs, errorName }`. Classify:
  `timeout` (AbortError), `connect_error` (TypeError/ENOTFOUND/ECONNREFUSED),
  `http_<status>`, or `ok`.
- Render hints, not fixes: if `isDrvfs` -> note `/mnt/*` state-dir risk; if the
  probe failed and no `*_PROXY` is set -> note Windows proxy/VPN + `autoProxy`;
  if DNS-shaped error -> note WSL NAT/DNS.

MODIFY `src/cli.ts`

- Add `case "doctor": { const { runDoctor } = await import("./doctor");
  await runDoctor(); break; }` next to `case "status"` (src/cli.ts:396-398),
  using the same lazy-import pattern as `update`/`init`.
- Add a `doctor` usage entry alongside the other verbs in src/cli-help.ts.

## Test plan

NEW `tests/doctor.test.ts`

- Path report: set `OPENCODEX_HOME`/`CODEX_HOME` to a temp dir (mirror the
  `beforeEach` env isolation in tests/codex-routing.test.ts:63-73); assert the
  report marks `config.json`/`auth.json` absent, then present after writing.
- `detectFsType`: feed a synthetic `/proc/mounts` fixture string to the parser
  (factor it to accept content) and assert `/mnt/c/...` -> `isDrvfs` /
  `isMntDrive`, and a normal `/home/...` ext4 line -> not flagged.
- `collectProxyEnv`: set/unset `HTTPS_PROXY` and assert present/absent without
  leaking the value into output.
- `probeWham`: inject a fake `fetch` (timeout reject, TypeError reject, 401, 200)
  and assert classification + that `durationMs` is recorded.
- Typecheck: `bun x tsc --noEmit`.

## Non-goals

- No auto-fixing of networking: never set proxy env, never rewrite `.wslconfig`,
  never enable mirrored mode.
- No moving or relocating state dirs off `/mnt/*` (that warning is Phase 50).
- No quota mutation: the probe must not call `updateAccountQuota` or otherwise
  feed the rotation engine; it is observe-only.
- No new dependency; use Bun's built-in `fetch` and `node:fs` only.

## Build record

- Pending implementation.
