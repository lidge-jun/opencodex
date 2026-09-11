# 001 - Darwin surface inventory

Read-only sweep of every `darwin`, `macOS`, `Keychain`, `launchctl`, `osascript`,
`/Applications` and `plist` reference under `src/` and `scripts/`, classified for
portability. Verdicts: PORTABLE, DOCUMENT-ONLY, ALREADY-HANDLED.

## Already handled - no work needed

These carry real win32 and linux branches today. Listed so a future reader does
not re-open them.

| Site | Why it is fine |
|---|---|
| `src/lib/open-url.ts:14` | Three-way branch; `rundll32 url.dll,FileProtocolHandler` on win32, `xdg-open` on linux, with an ENOENT listener so a headless host cannot kill the proxy |
| `src/integrations/cursor-detect.ts:69` | `/Applications` is one of three branches; win32 scans `LOCALAPPDATA\\Programs` and `ProgramFiles`, linux scans `/opt` and `~/.local/share` |
| `src/integrations/cursor-effort-table.ts:45` | `Contents/Resources/app` vs `resources/app`, the correct Electron layout for each |
| `src/claude/desktop-3p-paths.ts:47` | Pure resolver with `APPDATA`/`LOCALAPPDATA` and `XDG_CONFIG_HOME` branches |
| `src/oauth/kiro-credentials.ts:166,224` | Full win32 and linux branches for the session DB and executable |
| `src/oauth/local-token-detect.ts:78` | Keychain returns null off darwin and falls through to `.credentials.json`, which is what Claude Code writes on Windows and Linux |
| `src/claude/auth-detect.ts:207` | Metadata-only presence probe; "absent" off darwin is correct because the file source covers those platforms |
| `src/oauth/anthropic.ts:172` | Error text only; prints the file-only variant off darwin |
| `src/service.ts:3454` and around | Three-backend dispatch: launchd, Task Scheduler/WinSW, systemd user unit |
| `src/codex/app-server-processes.ts:523,626,676` | Named win32 and linux branches with their own timeout bounds |
| `src/codex/log-guard/path-safety.ts:13` | `/var` to `/private/var` alias normalization is genuinely macOS-shaped; a Windows canonical comparator sits alongside it |
| `src/providers/key-store.ts:33` | Not darwin-gated at all; `@napi-rs/keyring` maps to Credential Manager and libsecret |

## The real gaps

### 1. `src/server/system-env.ts` - five refusals, one subsystem

| Line | Function | Behavior off darwin |
|---|---|---|
| 142 | `installShellHook` | `{ installed: false, reason: "not macOS" }` |
| 159 | `uninstallShellHook` | `{ removed: false, reason: "not macOS" }` |
| 223 | `reconcileShellHook` | `{ changed: false, state: "absent", reason: "not macOS" }` |
| 372 | `injectSystemEnv` | `{ injected: false, reason: "not macOS" }` |
| 489 | `revertSystemEnv` | `{ reverted: false, reason: "not macOS" }` |

What it does on macOS: writes `~/.opencodex/claude-env.sh` (platform-neutral),
appends a marked hook line to `~/.zshrc`, and injects `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, conditionally `ANTHROPIC_AUTH_TOKEN`,
plus seven lever keys into the launchd user domain via `launchctl setenv`.

Ownership and rollback are stronger than the surface suggests, and any port must
preserve them: a tracking file `~/.opencodex/system-env-port` (0600) holds pid,
port and `injectedKeys`; revert unsets ONLY tracked keys so a pre-existing user
value survives; `injectedKeys` is re-persisted after every single `setenv` so a
crash mid-injection still leaves a complete undo list; lever keys are user-wins
(`injectLever` skips a key already present); revert refuses on ownership mismatch;
and `rollbackInjectedKeys` rewrites tracking with only the keys whose unset failed
so a partial rollback stays resumable.

Callers: `ocx start` (`src/cli/index.ts:443` and the already-running path at 537),
`syncCleanup` at 378, `ocx stop` at 957, `ocx uninstall` at 1239, and
`applySystemEnvToggle` from `agent-settings-routes.ts:1384`.

Verdicts: the SHELL HOOK half (142/159/223) is PORTABLE and cheap - the writer is
already platform-neutral and the marker install/remove/verify logic is already
written; the only blocker is the `!== "darwin"` guard plus a hardcoded `~/.zshrc`.
The ENV INJECTION half (372/489) is PORTABLE but expensive and carries a real
security question: moving `ANTHROPIC_AUTH_TOKEN` from a per-boot launchd domain
into a persistent `HKCU\\Environment` hive changes secret exposure, which AGENTS.md
routes to explicit security review. It is deliberately NOT in this unit.

### 2. `src/oauth/meta-muse.ts:136` - the only hard throw

`loginMetaMuse` throws on every non-darwin platform with a message blaming the
macOS Keychain. Measurement in `002` shows the message states the wrong reason.
Verdict: DOCUMENT-ONLY for Windows, PORTABLE for Linux pending a measured pointer.

### 3. `scripts/ocx-restart.sh` - no Windows counterpart

Bash-only detached restart helper for agent sessions. `restart-codex-desktop-app.ps1`
is a different tool. The `darwin` mention inside it is only a `setsid` fallback.
Verdict: PORTABLE, small.

### 4. `src/server/management/agent-settings-routes.ts:1091`

`autoConnectSupported` hardcodes `platform === "darwin"`. Honest today, since the
capability really is macOS-only, and the GUI fails closed on it. Three distinct
things must not be conflated when any of this moves: launchctl ENV INJECTION
(macOS only), writing the `claude-env.sh` SHELL FILE (deferred to its own unit,
`050`), and the SHELL HOOK that sources it. `autoConnectSupported` names the
first. A port of the second or third needs its own field rather than overloading
this one, because `tests/claude-management-api.test.ts:653-664` correctly pins
this flag false off darwin.

## One latent hazard worth recording

`src/cli/index.ts:1240` and `:1245` allowlist the literal reason strings
`"not macOS"` and `"not installed"` so `ocx uninstall` treats them as benign. A
future backend returning a different reason string turns a benign no-op into a
failed uninstall step.

Audit round 3 showed this is not a free refactor: four exact `toEqual`
assertions pin the current return objects
(`tests/claude-shell-hook.test.ts:63,79,107,173`), and a discriminant applied to
"every refusal path" would classify genuine failures (`no HOME`,
`read/write failed`) as benign skips. It belongs WITH the port that needs it, as
a discriminated union designed against those call sites - deferred to `050`,
not part of any phase in this unit.
