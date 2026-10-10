# 000 — `--restart-codex` leaves an app-server alive on Linux

## The report

```
Stopping Codex app-server process(es): 1782906, 1783602, 1783863 (active turns may be interrupted).
Stopped Codex app-server PID(s): 1783602, 1783863
Codex app-server PID(s) still running after SIGTERM: 1782906. Stop them manually if the model list stays stale.
```

Host: `cli-jaw-server` (reachable as `clisu-oracle`), aarch64 Ubuntu, Codex 0.142.5
installed through npm, opencodex v2.32.1-preview.20260825 from a source checkout.

## What is actually running there

`ps -eo pid,ppid,args` on the host, trimmed to the app-server tree:

```
1884131       1  node /usr/local/bin/codex -c features.code_mode_host=true app-server --listen unix://
1884188 1884131  …/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex -c … app-server --listen unix://
1884276 1884271  node /usr/local/bin/codex app-server proxy
1884814 1884276  …/codex-linux-arm64/vendor/…/bin/codex app-server proxy
1933835 1933830  node /usr/local/bin/codex app-server proxy
1933985 1933835  …/codex-linux-arm64/vendor/…/bin/codex app-server proxy
```

Every app-server is a **pair**: an npm wrapper running under `node`, and the vendored
native binary it spawns as its child.

## The defect, measured rather than inferred

Running the shipped matcher live on that host:

```
$ bun -e 'import {listCodexAppServerProcesses} from "./src/codex/app-server-processes.ts"; …'
MATCHED: 5
   1884188 …/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex …
   1884814 …/codex-linux-arm64/vendor/…/bin/codex app-server proxy
   1933985 …/codex-linux-arm64/vendor/…/bin/codex app-server proxy
   1945058 …
   1945383 …
```

Five matches, **all of them children**. Not one `node /usr/local/bin/codex app-server`
parent is in the list. So `--restart-codex` signals the child and leaves its supervisor
untouched; the supervisor is still holding the socket, and the user is told a PID
survived SIGTERM.

The cause is in `isCodexAppServerCommandLine` (`src/codex/app-server-processes.ts:249`):

```ts
if (isCodeModeHostProcess(tokens)) return true;   // handles `node <path>/codex-code-mode-host`
if (!isCodexExecutableToken(tokens[0]!)) return false;  // <- `node` fails here
```

`isCodeModeHostProcess` already accepts an interpreter-then-target pair
(`isInterpreterToken(tokens[0]) && isCodeModeHostToken(tokens[1])`, line 240). The plain
app-server path never got the same treatment. `isInterpreterToken` exists and is used
exactly once. **The asymmetry is the bug** — not the SIGTERM policy, which is working as
designed.

## Scope boundary

IN

- `isCodexAppServerCommandLine`: accept `<interpreter> <codex-executable> … app-server`.
- A regression in `tests/codex-app-server-processes.test.ts`, driven red first.
- This devlog unit.

OUT

- **Escalating to SIGKILL on Unix.** The code says so at line 1027 and it is right: a
  restart click does not consent to a hard kill, and survivors are reported instead.
  Widening the matcher fixes the miss without touching that consent boundary.
- Killing by process *tree*. The parent and child are matched independently once the
  matcher is correct; a `/T`-style sweep is Windows-only behavior for a different reason.
- The `lidge-gemma` 502 and the `cursor` catalog-drop lines in the same log. Different
  subsystems, not this defect.

## The change

```ts
// after: if (isCodeModeHostProcess(tokens)) return true;
if (isInterpreterToken(tokens[0]!) && tokens.length > 1 && isCodexExecutableToken(tokens[1]!)) {
  tokens = tokens.slice(1);
}
if (!isCodexExecutableToken(tokens[0]!)) return false;
```

Dropping the interpreter token and re-running the existing scan is what keeps the
subcommand walk (`advancePastCodexGlobalOption`, then require `app-server`) intact — so
`node /usr/local/bin/codex exec 'hello'` stays unmatched for the same reason
`codex exec 'hello'` does.

## The guard that must not regress

`tests/codex-app-server-processes.test.ts:426` asserts:

```ts
expect(isCodexAppServerCommandLine("node worker.js codex app-server")).toBe(false);
```

That must stay false. The difference is **position**: `worker.js` is not a codex
executable, so `tokens[1]` fails `isCodexExecutableToken` and the pair never forms.
Only `node <something-named-codex> app-server` matches. The same reasoning protects
line 428's `node worker.js codex-code-mode-host`.

## Accept criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | The npm wrapper shape matches | `isCodexAppServerCommandLine("node /usr/local/bin/codex app-server proxy")` is true |
| 2 | The later-argument guard still rejects | `node worker.js codex app-server` stays false |
| 3 | The regression is protective | it fails against the current matcher before the fix lands |
| 4 | Nothing else in the file regresses | `bun test ./tests/codex-app-server-processes.test.ts` green |
| 5 | Types hold | `bun x tsc --noEmit` clean |
| 6 | Real host, real processes | live probe on `clisu-oracle` lists the `node …/codex app-server` parents |
| 7 | The reported symptom is gone | `ocx sync --restart-codex` there reports no survivors |

## Loop spec

- Archetype: spec-satisfaction repair. The verifier is the regression plus the live probe.
- Stop condition: criteria 1-7 hold and the PR is open with CI green.
- Write scope: one source file, one test file, this devlog unit, one branch, one PR.
  No writes to `dev` or `main`; no merge.
- Escalation: if the parents turn out to be excluded deliberately, that is `NOOP` with
  evidence rather than a forced change.

