# 040 — Phase 4: Windows termination ladder + full verification

Depends on: phases 1-3 landed and green.
Produces: the DONE evidence for this unit.
Rejected alternatives and reasoning: `001_design_alternatives.md` §4, §6.

## Scope

| Path | Action |
|---|---|
| `src/lib/windows-elevation.ts` | MODIFY (add taskkill resolver) |
| `src/codex/app-server-processes.ts` | MODIFY (termination only) |
| `tests/codex-app-server-processes.test.ts` | MODIFY |
| `tests/windows-elevation.test.ts` | MODIFY |
| `devlog/_fin/260815_gui_codex_restart/050_execution_record.md` | NEW at close |

OUT: enumeration logic, the classifier, GUI files, CLI flags.

## Invariants

1. Unix behavior is byte-identical to today. The existing test
   "restartCodexAppServers signals all first, shared wait deadline, no SIGKILL"
   (`tests/codex-app-server-processes.test.ts:218-249`) must pass **unmodified**.
2. The Windows executable path is resolved from a trusted system directory with a
   test-override slot, matching `resolveTrustedWindowsPowerShellExe`
   (`src/lib/windows-elevation.ts:192-203`) and
   `resolveTrustedWindowsSchtasksExe` (`:206-212`) — **not** the looser
   `process.env.SystemRoot` interpolation at `src/lib/process-control.ts:157`.
3. The Windows branch is driven in tests through an injected io, not by the real
   `process.platform`. `CodexAppServerProcessIo`
   (`src/codex/app-server-processes.ts:79-89`) already carries `platform` and
   `kill`; it gains two seams: `execFile` for the Windows branch and `processKill` for the
   fallback and Unix branches.

## The decided asymmetry (invariant)

Windows uses `taskkill /PID <pid> /T /F`; Unix stays SIGTERM-only. The comparison
that produced this decision is in `001_design_alternatives.md` §4 and is not
repeated here.
## MODIFY `src/lib/windows-elevation.ts`

Add beside the schtasks resolver (`:206`), including its `ElevationExeOverrides`
field and the `setTrustedWindowsElevationExecutablesForTests` slot (`:185-189`):

```ts
/** Absolute path to System32\\taskkill.exe from a trusted system directory. */
export function resolveTrustedWindowsTaskkillExe(): string {
  if (elevationExeOverridesForTests?.taskkill) {
    return elevationExeOverridesForTests.taskkill;
  }
  const candidate = join(resolveTrustedWindowsSystemDirectory(), "taskkill.exe");
  return assertTrustedSystemExecutable(candidate, "taskkill.exe");
}
```

## MODIFY `src/codex/app-server-processes.ts`

Extend the io interface (`:79-89`):

```ts
  /** Windows termination seam. Tests drive the taskkill branch without a real exec. */
  execFile?: (file: string, args: readonly string[]) => void;
  /**
   * Signal seam for the fallback and Unix branches. Without it, injecting `kill`
   * bypasses defaultKillCodexAppServer entirely, so the taskkill-failure fallback
   * could never be observed.
   */
  processKill?: (pid: number, signal: NodeJS.Signals) => void;
```

Replace the default `kill` binding at `:667`:

```ts
  const kill = io.kill ?? ((pid, signal) => {
    defaultKillCodexAppServer(pid, signal, io);
  });
```

Extend the existing import at `src/codex/app-server-processes.ts:13`. `execFileSync`
is already imported at `:10`, so only the resolver is added:

```ts
import {
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsTaskkillExe,
} from "../lib/windows-elevation";
```

New helper:

```ts
/**
 * Windows process.kill(SIGTERM) is already an unconditional termination, not a
 * graceful signal (see src/lib/process-control.ts:150). Using taskkill /T there
 * adds child cleanup to a kill that was hard either way, and keeps app-server
 * children from being orphaned when the Codex window is closed without a quit
 * affordance.
 *
 * The asymmetry with Unix is deliberate and must not be "fixed" into symmetry:
 * on Unix a SIGKILL escalation asks a harsher consent than a restart click gives,
 * so survivors are reported instead (see restartCodexAppServers' result shape).
 */
function defaultKillCodexAppServer(
  pid: number,
  signal: NodeJS.Signals,
  io: CodexAppServerProcessIo = {},
): void {
  const platform = io.platform ?? process.platform;
  const signalProcess = io.processKill ?? ((target, sig) => { process.kill(target, sig); });
  if (platform !== "win32") { signalProcess(pid, signal); return; }
  const exec = io.execFile
    ?? ((file, args) => {
      execFileSync(file, [...args], { stdio: "ignore", timeout: 5_000, windowsHide: true });
    });
  try {
    exec(resolveTrustedWindowsTaskkillExe(), ["/PID", String(pid), "/T", "/F"]);
  } catch {
    // Fall back to the previous behavior rather than reporting a failure the old
    // code would not have reported.
    signalProcess(pid, signal);
  }
}
```

## Tests

`tests/codex-app-server-processes.test.ts` additions:

| Scenario | Trigger | Observable proof |
|---|---|---|
| Windows uses taskkill | `io.platform="win32"` + `io.execFile` spy + `io.processKill` spy | exec spy called with `/PID`, `/T`, `/F`; **`processKill` spy never called** |
| taskkill failure falls back | `io.execFile` throws | `processKill` spy called once with SIGTERM |
| Linux unchanged | `io.platform="linux"` | `processKill` spy called with SIGTERM only, no SIGKILL, exec spy never called |
| existing Unix test | unmodified | still green |

`tests/windows-elevation.test.ts`: the resolver returns a System32-anchored path
and honors the test override, mirroring the existing PowerShell resolver tests.

The fallback case is the one that must actually fire — it is what keeps a Windows
regression from being worse than the code it replaces.

## Verification (this unit's DONE evidence)

Local, all with fresh output:

```bash
bun run typecheck
bun run test
bun run privacy:scan
cd gui && bun run lint && bun run lint:i18n && bun test && bun run build
```

Linux cross-check on `lidge` — procfs enumeration
(`src/codex/app-server-processes.ts:244-268`) is the path Linux desktops and CI
containers take and cannot be observed from macOS:

```bash
ssh lidge 'cd ~/Developer/opencodex && ~/.bun/bin/bun run typecheck \
  && ~/.bun/bin/bun test tests/codex-app-server-processes.test.ts \
     tests/codex-app-server-restart-service.test.ts'
```

Windows is not directly runnable in this session. Its behavior is covered by the
io-injected unit tests above and by the Windows CI runner on `dev`. That limitation
is stated in the D summary rather than papered over.

## Delivery

The repository owner directed a direct `git push --no-verify origin dev`. Direct
pushes are reserved for maintainer-owned integration work and still carry the same
CI and documentation requirements (`MAINTAINERS.md:64-65`), so the instruction is
within the owner's authority.

It does not waive security review. Management-API changes are a security boundary
(`src/AGENTS.md:20`), and security-sensitive changes are to be reviewed by both
maintainers when practical (`MAINTAINERS.md:51-52`). Static gates do not substitute
for that review. Delivery therefore requires, beyond the gates above:

- an explicit security-review note in `050_execution_record.md` naming the auth
  surface touched, the principals that can reach it, and what it can and cannot do;
- **a completed maintainer security review of the pushed commit, with its verdict
  and disposition recorded in `050_execution_record.md`.** A request alone does not
  satisfy `MAINTAINERS.md:51-52`; the unit is not DONE until the review has an
  outcome. If the review has not returned by the end of the session, the terminal
  outcome is `NEEDS_HUMAN` for that criterion, and the D summary says so instead of
  claiming completion;
- the D summary stating plainly that review is post-push, not pre-merge.

## Accept criteria

1. Windows termination uses a System32-anchored `taskkill /T /F` with a fallback.
2. Unix behavior unchanged; the existing test passes unmodified.
3. All four new branch tests fire their branch and observe its effect.
4. Every command in the Verification block is green with fresh output.
5. `git push --no-verify origin dev` completes and `origin/dev` matches local HEAD.
6. `050_execution_record.md` records outcomes, residual risks, the security-review
   note, and what was not verified.
7. Maintainer security review of the pushed commit has RETURNED and its verdict
   plus disposition are recorded. An unreturned review makes this criterion
   `NEEDS_HUMAN`, not satisfied.

## Verifier commands

| Command | Reads this change? |
|---|---|
| `bun test tests/codex-app-server-processes.test.ts tests/windows-elevation.test.ts` | yes — direct arguments |
| `bun run typecheck` | yes — `src` and `tests` |
| `bun run test` | yes — whole suite |
| `ssh lidge ... bun test ...` | yes — same files on procfs |

## Bypass record

- Tier: E4 (CI-enforced across Linux, Windows, macOS runners).
- Executing surface: GitHub Actions on `dev`.
- Known bypass: `--no-verify` skips local hooks on push, as the repository owner
  authorized; repository CI still runs on the pushed commit.
- Residual risk: a Windows-only runtime defect that the io-injected tests do not
  model reaches `dev` and is caught by the Windows CI runner rather than before it.
- Wording downgrade: the local push gate is an **early warning**. Final enforcement
  layer: repository CI on `dev`.

## Platform termination (WP4)

`restartCodexAppServers` now terminates through `defaultKillCodexAppServer`,
which branches by platform:

| Platform | Termination | Rationale |
|---|---|---|
| Windows | `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F`, resolved from a trusted system directory | `process.kill(pid, "SIGTERM")` on Windows is already an unconditional terminate of one process. `/T` is not an escalation — it adds the child cleanup that kill lacks, which matters most here because Windows has no Ctrl+Q and users close the window instead of quitting |
| Linux | `process.kill(pid, "SIGTERM")` only | procfs enumeration is the Linux path; SIGTERM really is graceful there, so a follow-up SIGKILL would ask a harsher consent than a restart click gives |
| macOS | `process.kill(pid, "SIGTERM")` only | same reasoning as Linux |

The asymmetry is deliberate. Survivors are reported as `partially_stopped`
rather than escalated.

If `taskkill` fails on Windows, the code falls back to `process.kill` so the new
path can never be worse than the one it replaced. The executable is resolved from
a trusted system directory rather than PATH, matching `resolveTrustedWindowsPowerShellExe`
— an unqualified `taskkill` is a hijack surface.

