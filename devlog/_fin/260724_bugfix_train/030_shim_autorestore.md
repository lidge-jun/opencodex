# 030 — Cycle 3: codex-shim auto-restore after external Codex update

> Evidence baseline: `origin/dev` / `d9e06c8dd08df6635f5ca042bf6aa469fe1a10a8` (2026-07-24).
> This is a diff-level implementation design, not an implementation patch.

## Loop spec

- Loop archetype: **spec-satisfaction repair** for issue #320 part 2.
- Success condition: a previously installed OpenCodex Codex shim that a completed external
  `@openai/codex` npm update replaced is restored by the next real `ocx` command without requiring
  `ocx codex-shim install`.
- Verifier: `bun run typecheck`, `bun run test`, and `bun run privacy:scan`, plus the focused
  activation scenarios and the healthy-probe timing check in this document.
- Bounds: one bugfix slice; no daemon, watcher, dependency, auth-flow, release, or GUI work.
- Escalation: return to A/maintainer review rather than widening the patch if (a) the healthy probe
  cannot stay below 5 ms typical, (b) a platform requires process enumeration or a filesystem
  watcher, (c) replacement stability cannot be established without waiting, or (d) any proposed
  diagnostic would read or print credential contents. A security reviewer must explicitly approve
  the final diff before merge because the shim state is colocated with `auth.json`.

## Objective and evidence

Issue #320 part 2 is a lifecycle gap, not a missing repair primitive:

- `installCodexShim()` already recognizes a tracked wrapper replaced by a non-shim, moves the new
  launcher into the owned backup, and writes a fresh shim (`src/codex/shim.ts:445-487`).
- `diagnoseCodexShim()` already reports the exact stale condition as `present but not an opencodex
  shim` (`src/codex/shim.ts:546-577`).
- The repair path is only called explicitly from `ocx codex-shim install`
  (`src/cli/index.ts:659-665`) or after OpenCodex's own updater succeeds
  (`src/update/index.ts:255-267`). An external Codex npm update reaches neither call site.
- The published `ocx` entry always reaches `src/cli/index.ts`; the runtime SOT identifies that file
  as the CLI entry and `src/codex/shim.ts` as the shim lifecycle owner
  (`structure/01_runtime.md:7-16`).
- Credential handling and other security-boundary changes require explicit security review
  (`MAINTAINERS.md:16-25`). `loadConfig()` hardens both config and adjacent `auth.json`
  (`src/config.ts:645-650`), so the startup probe must use the read-only diagnostics loader and must
  never read auth data.

## Scope

### IN

- Auto-restore only a **previously installed, validly tracked** shim after its tracked wrapper path
  has been replaced by a complete, stable, non-OpenCodex launcher.
- Run a bounded, read-only probe on ordinary `ocx` CLI startup and synchronously execute the existing
  repair transaction only on the rare confirmed-replacement path.
- Add opt-out controls: `config.codexShimAutoRestore` and
  `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`.
- Preserve macOS/Linux, native Windows, Git-Bash, and WSL safety behavior.
- Warn on successful automatic repair and on repair failure; never change the requested command's
  exit behavior because repair failed.
- Update runtime SOT, root README copies, and docs-site CLI/configuration copies in every maintained
  locale so no published page retains the old “manual install/update only” claim.

### OUT

- **Issue #320 part 1, the native Codex login gate, is UPSTREAM and explicitly OUT.** No auth/login,
  `auth.json`, account-pool, or token behavior changes.
- Fresh shim installation. Missing/corrupt state, a missing wrapper, a missing backup, a platform
  mismatch, and an untracked Codex executable remain explicit/manual repair cases.
- `codex.exe` wrapping. Windows discovery intentionally refuses a real `.exe`
  (`src/codex/shim.ts:176-207`).
- Background filesystem watcher, npm-process scanner, polling timer, sleep/retry loop, service
  install, proxy lifecycle, GUI control, dependency, release, or schema migration.
- Changing `codexAutoStart`; it controls whether an installed shim runs `ocx ensure`
  (`src/config.ts:772-774`, `src/types.ts:530-531`) and is not the lifecycle-repair opt-out.

## Design decisions

### 1. Hook point: ordinary CLI startup

**Choose:** invoke a best-effort helper in `src/cli/index.ts` after the existing version/help early
exits and before `switch (command)` (`src/cli/index.ts:44-60`, `src/cli/index.ts:540`). Skip explicit
destructive/repair lifecycle commands: top-level `uninstall`/`remove`, and `codex-shim install`,
`uninstall`, or `remove`. Keep `codex-shim status` eligible so it reports the repaired state.

| Candidate | Coverage | Cost / invasiveness | Decision |
| --- | --- | --- | --- |
| Every real `ocx` CLI startup | The next user command, even when no proxy starts | One state read plus bounded wrapper-prefix/metadata reads on the healthy path; no writes | **Chosen** |
| `ocx start` / serve hook | Only commands that start the foreground proxy | Misses `status`, `login`, `doctor`, service-managed/no-start workflows | Reject |
| Proxy startup | Only a newly created server process | Couples launcher mutation to server/auth startup and misses commands using an existing proxy | Reject |
| Filesystem watcher | Continuous detection | Long-lived resource, platform-specific semantics, update races, teardown and permission surface | Reject |

The hook is deliberately not placed in `bin/ocx.mjs`: the runtime SOT assigns that file bundled-Bun
bootstrap only (`structure/01_runtime.md:7-9`). Shim lifecycle remains owned by
`src/codex/shim.ts` (`structure/01_runtime.md:16`).

“Never block” means no network, subprocess, watcher, sleep, polling, or retry on startup, and no
repair failure may block/fail the requested command. The healthy check is synchronous but bounded so
the shim is known-restored before command dispatch. The rare repair transaction may add local rename
and write latency; making that detached would violate the “next command restored it” contract.

### 2. Restore reuses install behavior inside a real multi-wrapper transaction

**Choose:** extract the body of current `installCodexShim()` into a private
`installCodexShimInternal(options)` and keep the public no-argument signature unchanged. Explicit
install calls the internal function without a replacement guard. Auto-restore calls the same
internal function with the stable fingerprints captured by the probe. Do not copy the
backup/rename/write logic.

The current helpers preserve one path on failure, but `installCodexShim()` mutates siblings
sequentially (`src/codex/shim.ts:471-483`). That is not sufficient for the promised all-or-nothing
multi-wrapper repair. The guarded auto-restore path must therefore wrap the existing branch behavior
in a transaction-wide preflight and rollback journal:

1. `refreshShimFile()` recognizes a tracked non-shim wrapper (`src/codex/shim.ts:445-468`).
2. `replaceOwnedBackup()` remains the single-path primitive, but guarded multi-wrapper restore must
   retain its staged prior backup until the whole sibling set commits; deleting it after each sibling
   would make later rollback impossible.
3. `writeShim()` emits `.cmd`, `.ps1`, Git-Bash sh, or Unix sh content and applies Unix execute bits
   (`src/codex/shim.ts:397-419`).
4. `installCodexShim()` writes canonical state only after every planned sibling mutation succeeds.
   On any mid-sequence mismatch/write/rename failure, reverse the journal before returning/throwing
   and leave state bytes unchanged.

The accepted residual TOCTOU window is explicit: filesystem contents can change after transaction-
wide preflight. Revalidate each source fingerprint immediately before its own first rename; if that
late check fails after an earlier sibling was repaired, roll back the earlier sibling(s) in reverse
order and return `deferred`. A rollback failure is an explicit filesystem repair failure reported by
the CLI warning path, never a false `restored` result.

### 3. Opt-out names and precedence

- Config: `codexShimAutoRestore?: boolean`, default `true`.
- Environment: `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` disables auto-restore for that process.
- Effective rule: enabled only when the config value is not `false` **and** the env value is not
  exactly `"0"`. The env variable is an opt-out, not a force-enable; `=1` does not override config
  `false`.

The names follow current boundaries: persisted config uses camelCase boolean fields such as
`codexAutoStart` (`src/types.ts:526-531`), while public OpenCodex environment controls use the
`OPENCODEX_` prefix (`src/config.ts:308`, `src/cli/index.ts:134-135`). Internal shim recursion remains
the separate `OCX_SHIM_BYPASS` concern (`src/codex/shim.ts:254-260`, `src/codex/shim.ts:348-350`).

The common healthy/not-installed path never parses config. The shim owner first probes tracked state;
only a stable restore candidate invokes a lazy `enabled()` callback. That callback uses
`readConfigDiagnostics().config` (`src/config.ts:730-752`), not `loadConfig()`, so startup does not
chmod, back up, or read adjacent credential files.

### 4. Cross-platform contract

- macOS/Linux: preserve the executable-bit health check (`src/codex/shim.ts:91-99`) and Unix shim
  writer/chmod (`src/codex/shim.ts:415-418`). Symlink launchers are allowed only when the symlink and
  resolved target fingerprints are stable and the target is a non-empty regular file.
- Windows: operate only on the state-tracked `.cmd`, `.ps1`, and extensionless Git-Bash launcher set;
  writer selection and UTF-8 BOM behavior stay centralized in `writeShim()`
  (`src/codex/shim.ts:397-414`). Never discover or rename `codex.exe`.
- WSL: auto-restore performs no PATH rediscovery. It requires `state.platform === process.platform`,
  so Windows-owned state is not repaired from WSL. Fresh/manual discovery retains the existing WSL
  interop refusal (`src/codex/shim.ts:132-173`).
- Multi-wrapper state: all changed tracked launchers must pass stability checks before any one is
  mutated. A mixed “npm is still replacing siblings” state is deferred as one unit.

### 5. Completed/stable replacement check

Do not sleep and stat twice over time. A candidate is safe only when all of these hold in one bounded
probe:

1. `codex-shim.json` parses through existing `readState()` and its platform equals the runtime.
2. Every non-`preserveOnly` tracked entry still has its owned backup (or valid `realPath`), and every
   wrapper exists. Corrupt/missing state is not auto-repaired.
3. At least one tracked wrapper lacks the marker in a bounded prefix; intact wrappers remain healthy.
4. For each changed wrapper, `lstat` before and after the bounded read has the same
   device/inode/type/size/mtime; for symlinks, the followed target's corresponding fingerprint is
   also unchanged and is a non-empty regular file.
5. The newest `mtime`/`ctime` in those snapshots is at least `100 ms` old. This catches a just-created
   partial launcher without adding a startup wait. A younger/changing candidate returns `deferred`
   silently and is retried by the next command.
6. Immediately before **any** mutation, `installCodexShimInternal` rechecks every captured wrapper
   fingerprint transaction-wide. Any mismatch aborts with zero mutation. During application it also
   rechecks each source immediately before that sibling's first rename; a later mismatch rolls back
   all already-mutated siblings in reverse order. Concurrent `ocx` or npm activity therefore
   degrades to a later retry rather than leaving a partially refreshed wrapper set.

Use a named `CODEX_SHIM_REPLACEMENT_STABLE_MS = 100` and a bounded marker read (16 KiB is sufficient:
the generated marker is at the top of every builder at `src/codex/shim.ts:222-224`,
`src/codex/shim.ts:287-289`, and `src/codex/shim.ts:329-331`). Do not use current `isShim()` for the
startup probe because it reads the entire path (`src/codex/shim.ts:83-89`), which can be an updated
native launcher/binary. Explicit install and full diagnostics may retain their current behavior.

This is a stability check, not an npm-brand check: OpenCodex does not need to parse npm launcher
contents or enumerate npm processes. A replacement that is still being written is deferred; a stable
non-shim at an OpenCodex-owned tracked path is the exact existing repair trigger.

## Structural map

```text
src/cli/index.ts
  -> src/cli/codex-shim-autorestore.ts       best-effort CLI boundary
       -> src/config.ts                      lazy effective opt-out
       -> src/codex/shim.ts                  probe + guarded shared install transaction
            -> src/lib/bun-runtime.ts        existing shim writer dependency
            -> src/lib/service-secrets.ts    existing token-file path baked into shim

src/types.ts                                 persisted config type
tests/config.test.ts                         flag/env contract
tests/codex-shim.test.ts                     filesystem/platform/stability transaction
tests/codex-shim-autorestore.test.ts         CLI policy + activation boundary
```

Dependency direction remains CLI policy -> config/domain owners. No server/proxy module imports the
CLI helper, and shim code does not import CLI policy. Coupling is functional and one-way. No new
public package export is introduced.

## Exact file change map

### Production and tests

| Action | Exact path | Diff responsibility |
| --- | --- | --- |
| MODIFY | `src/types.ts` | Add typed persisted `codexShimAutoRestore?: boolean`. |
| MODIFY | `src/config.ts` | Validate/default the field; export env constant and effective opt-out helper. |
| MODIFY | `src/codex/shim.ts` | Add bounded probe, stable fingerprints, guarded internal install reuse, and `autoRestoreCodexShim()`. |
| NEW | `src/cli/codex-shim-autorestore.ts` | Own skip policy, lazy config callback, warnings, and catch-all non-fatal boundary. |
| MODIFY | `src/cli/index.ts` | Call helper after help/version exits and before command dispatch. |
| MODIFY | `tests/config.test.ts` | Cover default, config false, env `0`, and precedence/type validation. |
| MODIFY | `tests/codex-shim.test.ts` | Cover intact fast path, stable replacement, young/changing defer, platform guard, and real repair transaction. |
| NEW | `tests/codex-shim-autorestore.test.ts` | Cover CLI skip policy, warning-only failures, opt-out, and a spawned next-command activation. |

### Source of truth and public docs

| Action | Exact path(s) | Diff responsibility |
| --- | --- | --- |
| MODIFY | `structure/01_runtime.md` | Record CLI startup auto-restore ownership and no-watcher/stable-replacement invariant. |
| MODIFY | `README.md`, `README.ko.md`, `README.ja.md`, `README.zh-CN.md`, `README.ru.md` | Replace the contradictory “repair only on install/update” row and name both opt-outs. |
| MODIFY | `docs-site/src/content/docs/reference/cli.md`, `docs-site/src/content/docs/ko/reference/cli.md`, `docs-site/src/content/docs/ja/reference/cli.md`, `docs-site/src/content/docs/zh-cn/reference/cli.md`, `docs-site/src/content/docs/ru/reference/cli.md` | Describe next-command automatic repair, stable-update defer, warning-only failure, and manual fallback. |
| MODIFY | `docs-site/src/content/docs/reference/configuration.md`, `docs-site/src/content/docs/ko/reference/configuration.md`, `docs-site/src/content/docs/ja/reference/configuration.md`, `docs-site/src/content/docs/zh-cn/reference/configuration.md`, `docs-site/src/content/docs/ru/reference/configuration.md` | Add `codexShimAutoRestore` and `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`. |

### Deletes

- No production/test/docs file is deleted by the implementation.
- Planning scaffold `devlog/_plan/260724_bugfix_train/030_phase3.md` is replaced by this document,
  `devlog/_plan/260724_bugfix_train/030_shim_autorestore.md`.

## Diff-level code sketches

Line anchors below refer to baseline `d9e06c8d`; implementation line numbers will shift.

### `src/types.ts` — config contract

Before (`src/types.ts:526-531`):

```ts
/** Advertise supports_websockets so Codex opens the WS endpoint. Default false; set true to opt in. */
websockets?: boolean;
/** Generated API keys for external access to the proxy's /v1/responses endpoint. */
apiKeys?: Array<{ id: string; name: string; key: string; createdAt: string }>;
/** Auto-start/sync the proxy from the Codex shim before launching Codex. Default true. */
codexAutoStart?: boolean;
```

After:

```ts
/** Advertise supports_websockets so Codex opens the WS endpoint. Default false; set true to opt in. */
websockets?: boolean;
/** Generated API keys for external access to the proxy's /v1/responses endpoint. */
apiKeys?: Array<{ id: string; name: string; key: string; createdAt: string }>;
/** Auto-start/sync the proxy from the Codex shim before launching Codex. Default true. */
codexAutoStart?: boolean;
/** Restore a previously installed shim after a stable external Codex update replaces it. Default true. */
codexShimAutoRestore?: boolean;
```

### `src/config.ts` — schema/default/effective flag

Before (`src/config.ts:437-445`, `src/config.ts:772-805`):

```ts
const configSchema = z.object({
  // ...
  multiAgentGuidanceEnabled: z.boolean().optional(),
}).passthrough().superRefine((config, ctx) => {

export function codexAutoStartEnabled(config: Pick<OcxConfig, "codexAutoStart">): boolean {
  return config.codexAutoStart !== false;
}

export function getDefaultConfig(): OcxConfig {
  return {
    // ...
    codexAutoStart: true,
  };
}
```

After:

```ts
export const CODEX_SHIM_AUTO_RESTORE_ENV = "OPENCODEX_CODEX_SHIM_AUTO_RESTORE";

const configSchema = z.object({
  // ...
  multiAgentGuidanceEnabled: z.boolean().optional(),
  codexShimAutoRestore: z.boolean().optional(),
}).passthrough().superRefine((config, ctx) => {

export function codexShimAutoRestoreEnabled(
  config: Pick<OcxConfig, "codexShimAutoRestore">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return config.codexShimAutoRestore !== false && env[CODEX_SHIM_AUTO_RESTORE_ENV] !== "0";
}

export function getDefaultConfig(): OcxConfig {
  return {
    // ...
    codexAutoStart: true,
    codexShimAutoRestore: true,
  };
}
```

Place the schema key beside other top-level booleans, not as a post-parse cast. Keep the exported env
name canonical so docs/tests do not duplicate the literal.

### `src/codex/shim.ts` — probe and shared guarded install

Before (`src/codex/shim.ts:445-517`):

```ts
function refreshShimFile(file: ShimFileState): boolean {
  // ... current replacement/backup/write branches ...
}

export function installCodexShim(): { installed: boolean; message: string } {
  const existing = readState();
  if (existing) {
    const files = stateFiles(existing);
    let refreshed = false;
    for (const file of files) refreshed = refreshShimFile(file) || refreshed;
    // ... current allInstalled/state write/result ...
  }
  // ... current discovery/fresh install ...
}
```

After (signatures and control flow; retain current branch bodies verbatim inside the internal owner):

```ts
const CODEX_SHIM_PROBE_BYTES = 16 * 1024;
export const CODEX_SHIM_REPLACEMENT_STABLE_MS = 100;

interface ShimPathFingerprint {
  dev: number;
  ino: number;
  kind: "file" | "symlink";
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  target?: Omit<ShimPathFingerprint, "target">;
}

interface InstallCodexShimInternalOptions {
  expectedReplacements?: ReadonlyMap<string, ShimPathFingerprint>;
  allowFreshInstall: boolean;
}

export type CodexShimAutoRestoreResult =
  | { status: "not-installed" | "healthy" | "ineligible" | "deferred" | "disabled" }
  | { status: "restored"; message: string };

function readShimProbePrefix(path: string): string {
  // open/read/close at most CODEX_SHIM_PROBE_BYTES; never read a replaced binary in full.
}

function stableReplacementFingerprint(
  path: string,
  nowMs: number,
): ShimPathFingerprint | null {
  // lstat -> bounded read -> lstat; follow and fingerprint a symlink target.
  // Return null for changing, too-young, empty, non-file, unreadable, or dangling paths.
}

function refreshShimFile(
  file: ShimFileState,
  expectedReplacement?: ShimPathFingerprint,
): boolean {
  // Existing branch classification stays authoritative for explicit/manual install.
}

interface GuardedRefreshOperation {
  file: ShimFileState;
  expectedReplacement: ShimPathFingerprint;
  sourcePath: string;
  writesWrapper: boolean;
}

interface GuardedRefreshJournalEntry {
  operation: GuardedRefreshOperation;
  stagedOldBackupPath?: string;
  stagedOldWrapperPath?: string;
  replacementMovedToBackup: boolean;
  shimWritten: boolean;
}

function planGuardedRefreshTransaction(
  files: readonly ShimFileState[],
  expectedReplacements: ReadonlyMap<string, ShimPathFingerprint>,
): GuardedRefreshOperation[] | null {
  // BEFORE ANY rename/write: classify every changed sibling and fingerprint-check ALL
  // expected source paths. Return null on any mismatch/ineligible branch.
}

function applyGuardedRefreshTransaction(
  operations: readonly GuardedRefreshOperation[],
): boolean {
  // For each operation, recheck its source fingerprint immediately before mutation.
  // Stage any prior backup and any wrapper that would be overwritten under unique
  // transaction-owned names; move the replacement to backup; write the new shim; append
  // every completed rename/write to the journal.
  // On mismatch or failure, reverse the journal: remove the generated shim, move the
  // replacement backup back to sourcePath, restore the staged wrapper, then restore the
  // staged prior backup. Only after all siblings succeed may staged files be removed.
  // Return false for a cleanly rolled-back mismatch; throw an AggregateError if apply or
  // rollback has an unrecovered filesystem failure.
}

function installCodexShimInternal(
  options: InstallCodexShimInternalOptions,
): { installed: boolean; message: string } {
  // Existing installCodexShim body. When expectedReplacements exists, build the complete
  // operation list with planGuardedRefreshTransaction(), then apply it atomically through
  // applyGuardedRefreshTransaction(). Never call the old sequential refresh loop, never
  // write state before commit, and never enter fresh discovery when allowFreshInstall=false.
}

export function installCodexShim(): { installed: boolean; message: string } {
  return installCodexShimInternal({ allowFreshInstall: true });
}

export function autoRestoreCodexShim(options: {
  enabled: () => boolean;
  nowMs?: number;
}): CodexShimAutoRestoreResult {
  const state = readState();
  if (!state) return { status: "not-installed" };
  if (state.platform !== process.platform) return { status: "ineligible" };

  // Bounded marker/health probe. Return healthy without calling options.enabled().
  // Require complete tracked state; collect all stable non-shim fingerprints.
  // Return deferred before mutation if any changed sibling is young/changing.

  if (!options.enabled()) return { status: "disabled" };
  const result = installCodexShimInternal({
    allowFreshInstall: false,
    expectedReplacements,
  });
  return result.installed
    ? { status: "restored", message: result.message }
    : { status: "deferred" };
}
```

Implementation constraint: fingerprint mismatch must be represented as a non-mutating deferred
outcome, not be mistaken for “already installed.” A mismatch found after a sibling mutation must
first restore every journaled sibling and the prior state bytes, then return deferred. Throw only for
actual apply/rollback filesystem failures; the CLI boundary catches those.

### `src/cli/codex-shim-autorestore.ts` — non-fatal policy boundary (NEW)

Complete intended shape:

```ts
import { autoRestoreCodexShim } from "../codex/shim";
import {
  codexShimAutoRestoreEnabled,
  readConfigDiagnostics,
} from "../config";

export interface CodexShimAutoRestoreCliDeps {
  env: NodeJS.ProcessEnv;
  warn: (message: string) => void;
  restore: typeof autoRestoreCodexShim;
  readConfig: typeof readConfigDiagnostics;
}

const DEFAULT_DEPS: CodexShimAutoRestoreCliDeps = {
  env: process.env,
  warn: message => console.warn(message),
  restore: autoRestoreCodexShim,
  readConfig: readConfigDiagnostics,
};

export function skipsCodexShimAutoRestore(command: string | undefined, args: string[]): boolean {
  if (command === "uninstall" || command === "remove") return true;
  return command === "codex-shim" && ["install", "uninstall", "remove"].includes(args[1] ?? "");
}

export function maybeAutoRestoreCodexShim(
  command: string | undefined,
  args: string[],
  deps: CodexShimAutoRestoreCliDeps = DEFAULT_DEPS,
): void {
  if (skipsCodexShimAutoRestore(command, args)) return;
  try {
    const result = deps.restore({
      enabled: () => codexShimAutoRestoreEnabled(deps.readConfig().config, deps.env),
    });
    if (result.status === "restored") {
      deps.warn(`⚠️  ${result.message} (automatic repair after Codex update)`);
    }
  } catch (error) {
    deps.warn(
      `⚠️  Codex shim auto-restore failed; continuing without it: ${
        error instanceof Error ? error.message : String(error)
      }. Run 'ocx codex-shim install' after the Codex update finishes.`,
    );
  }
}
```

The final warning text may be tightened, but it must remain secret-free, identify the manual fallback,
and contain no stack, config contents, launcher contents, token, or account identifier.

### `src/cli/index.ts` — hook

Before (`src/cli/index.ts:39-60`, `src/cli/index.ts:540`):

```ts
import { maybeShowStarPrompt } from "./star-prompt";
import { maybeShowUpdatePrompt } from "../update/notify";

if (command !== undefined && command !== "help" && hasHelpFlag(args.slice(1))) {
  printSubcommandUsage(command);
  process.exit(0);
}

// ...
switch (command) {
```

After:

```ts
import { maybeAutoRestoreCodexShim } from "./codex-shim-autorestore";
import { maybeShowStarPrompt } from "./star-prompt";
import { maybeShowUpdatePrompt } from "../update/notify";

if (command !== undefined && command !== "help" && hasHelpFlag(args.slice(1))) {
  printSubcommandUsage(command);
  process.exit(0);
}

maybeAutoRestoreCodexShim(command, args);

// ...
switch (command) {
```

Do not put the hook before version/help exits: those paths currently terminate at
`src/cli/index.ts:47-60` and should stay read-only/instant. Do not put it inside `handleStart()`; that
would reduce coverage to the rejected start-only design.

### Docs sketches

Configuration row, translated equivalently in every docs-site locale:

```md
| `codexShimAutoRestore?` | `boolean` | `true` | Restore a previously installed Codex shim when a completed external Codex update replaces it. Set `false`, or set `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` for a process-level opt-out. |
```

CLI/README behavior replacement:

```md
If a completed external Codex update overwrites an installed shim, the next ordinary `ocx` command
backs up the new launcher and restores the shim. A launcher that is still changing is left untouched
and retried on a later command. Failures warn without failing the requested command; manual fallback:
`ocx codex-shim install`.
```

## Test plan

### Focused unit and integration tests

#### `tests/config.test.ts` (MODIFY)

1. Default config contains `codexShimAutoRestore: true`.
2. `codexShimAutoRestoreEnabled({})` and explicit `true` are enabled.
3. Config `false` disables with env unset or `=1`.
4. Env `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` disables config unset/true.
5. Invalid persisted values (`null`, `"false"`, `0`) fail diagnostics at
   `codexShimAutoRestore`, matching current boolean validation tests at `tests/config.test.ts:106-134`.

#### `tests/codex-shim.test.ts` (MODIFY)

Use temp `PATH`/`OPENCODEX_HOME`, install through public `installCodexShim()`, and restore environment
and files in `finally`, following the current real filesystem setup at
`tests/codex-shim.test.ts:280-320`.

1. Healthy installed shim -> `healthy`; `enabled()` is never called; wrapper/backup/state bytes and
   mtimes do not change.
2. Stable non-shim replacement (mtime/ctime beyond the 100 ms gate) -> `restored`; the replacement
   becomes the backup and wrapper contains the marker.
3. Just-written replacement -> `deferred`; no path changes. Age it, retry, then restore.
4. Fingerprint mismatch before guarded rename -> `deferred`; no backup or wrapper mutation.
5. **Mandatory transactional race — second sibling changes after the first is applied.** Name:
   `test("multi-wrapper restore rolls back when a later sibling fingerprint changes", () => { ... })`.
   Create stable changed `.cmd` and `.ps1` siblings and capture both fingerprints. Inject a narrow
   filesystem seam/hook that changes the second sibling after the first sibling's guarded repair has
   completed but before the second sibling's immediate pre-rename recheck. Assert result is
   `deferred`; first and second wrapper bytes, both prior backup bytes, execute bits where relevant,
   and state JSON are byte-for-byte/metadata-equivalent to their pre-transaction values; no staged
   transaction path remains; no `restored` message is emitted. This activates mid-sequence rollback,
   not only transaction-wide zero-mutation preflight.
6. Missing backup, missing wrapper, corrupt state, directory/dangling symlink, and state platform
   mismatch -> `ineligible`/`deferred`; never fresh-install.
7. Windows CI verifies `.cmd`, `.ps1`, and extensionless tracked siblings restore as one transaction;
   Unix CI verifies execute bit and symlink-target stability. WSL guard remains covered by existing
   tests at `tests/codex-shim.test.ts:323-370`.

#### `tests/codex-shim-autorestore.test.ts` (NEW)

1. Helper skips top-level uninstall/remove and shim install/uninstall/remove; it does not skip
   `codex-shim status` or ordinary commands.
2. Injected `restore` throw -> exactly one warning with manual fallback; helper returns normally.
3. Injected `restored` -> exactly one automatic-repair warning.
4. Injected `healthy`, `not-installed`, `disabled`, or `deferred` -> no warning.
5. Lazy config assertion: `readConfig` is not called when core reports healthy/not-installed.
6. Spawned activation: install a temp shim, replace it with a stable real launcher, run the next
   `ocx codex-shim status`, assert exit 0, repair warning on stderr, healthy shim status on stdout,
   marker at wrapper, and new launcher bytes in backup.

### Required activation scenarios

| Scenario | Setup | Trigger | Required observation |
| --- | --- | --- | --- |
| Shim replaced by real Codex binary | Valid installed state; overwrite tracked wrapper(s) with stable non-shim launcher(s) | Next ordinary `ocx` command | Wrapper auto-restored before dispatch; new launcher backed up; one warning; requested command exits normally. |
| Shim intact / zero-mutation overhead path | Valid healthy state | Any ordinary `ocx` command | Bounded state/prefix/metadata reads only; no config parse, rename, write, warning, subprocess, timer, or network. Typical probe <5 ms. |
| Restore failure | Stable candidate; injected/real filesystem failure | Ordinary `ocx` command | Warning includes manual fallback; command's own output and exit status are unchanged. |
| Opt-out set | Config false and, separately, env `=0` | Ordinary `ocx` command | Candidate remains untouched; no restore warning; explicit `ocx codex-shim install` still works. |
| npm update in progress | Changed wrapper is too young or fingerprint changes | Ordinary `ocx` command | Silent defer; no rename/write; later command after stability restores. |

### Performance proof

Add a small focused benchmark script invocation to the implementation devlog (not a permanent timing
assertion, which would be flaky in shared CI): create one Unix tracked wrapper or the three Windows
tracked wrappers, warm the module, run the healthy probe 1,000 times, report median and p95 using
`performance.now()`. Acceptance: median and p95 both `< 5 ms` on the maintainer test machine; no sample
performs a write. Keep the permanent test structural: assert `enabled()`/config and repair paths are not
called for healthy state.

## Verification (C)

Run in this order from repository root:

```bash
bun test --isolate tests/config.test.ts tests/codex-shim.test.ts tests/codex-shim-autorestore.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Expected: every command exits `0`; full tests report zero failures; privacy scan reports no credential,
personal-path, token, or account leakage. Also run the focused healthy-probe benchmark above on at least
one Unix host and use Cross-platform CI for Windows behavior. Do not claim cross-platform completion
from a macOS-only local run.

## Security-review checkpoint

This checkpoint is mandatory before merge under `MAINTAINERS.md:22-25`.

### Threat model

- Assets: the real Codex launcher, OpenCodex-owned launcher backup, shim state, nearby OpenCodex config
  directory, and credentials stored separately under that directory.
- Entrypoints: external npm launcher replacement, ordinary CLI startup, persisted config flag, env
  opt-out, and state JSON read from disk.
- Attacker/failure capabilities: interrupted or concurrent npm update; local process modifying tracked
  paths/state; symlink swap; concurrent `ocx` commands; malformed state; filesystem permission error.
- Trust boundary: filesystem contents and environment are runtime inputs. Auto-restore may mutate only
  paths already recorded by a valid prior shim install; it must not rediscover arbitrary PATH targets.
- Blast radius: tracked Codex launcher and owned backup only. No auth/account/token file may be read,
  written, serialized, or logged.

### Must-pass reviewer checks

- [ ] Auto-restore requires valid prior state, same platform, complete backups, stable fingerprints,
      and at least one tracked non-shim; it cannot fresh-install.
- [ ] All sibling fingerprints are revalidated before any mutation; a preflight mismatch causes zero
      mutation.
- [ ] Each sibling is revalidated again immediately before its first rename; a later mismatch rolls
      back already-mutated siblings, leaves state unchanged, and returns `deferred`.
- [ ] Symlink target must be a stable non-empty regular file; no directory/dangling-link traversal.
- [ ] Existing single-path rollback in `replaceOwnedBackup()` remains intact for manual install, and
      guarded auto-restore adds transaction-wide reverse-order sibling rollback.
- [ ] Windows `.exe` refusal and WSL interop guard remain intact (`src/codex/shim.ts:132-207`).
- [ ] Startup opt-out uses `readConfigDiagnostics()`, not `loadConfig()`, and never opens `auth.json`.
- [ ] Warning/error strings contain status and path-safe context only; no file contents, env dump,
      stack, token, account id, request body, or credential identifier.
- [ ] `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` and config false prevent automatic writes but do not weaken
      explicit install/uninstall semantics.
- [ ] `bun run privacy:scan`, focused negative tests, full tests, and Cross-platform CI are green.

## Acceptance checklist

- [ ] The chosen hook is before ordinary CLI dispatch and after help/version exits.
- [ ] Healthy/not-installed probes are bounded, read-only, lazy-config, and <5 ms typical.
- [ ] Stable external update replacement is restored through the same internal transaction used by
      `ocx codex-shim install`.
- [ ] Partial/changing update, race, or failure never breaks the requested command.
- [ ] Config and env opt-outs are typed, documented, and tested.
- [ ] macOS/Linux/Windows/Git-Bash/WSL guards are preserved.
- [ ] Issue #320 part 1 remains untouched and documented as upstream/out of scope.
- [ ] Runtime SOT, all root README locales, and all docs-site CLI/config locales agree.
- [ ] Explicit security review is recorded before merge.
