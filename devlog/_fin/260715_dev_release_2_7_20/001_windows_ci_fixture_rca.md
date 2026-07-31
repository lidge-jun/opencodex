# Windows CI fixture root-cause record

## Red evidence

- Candidate: `c048705248be6e55d4ab12745186d9351bbeb6dc`
- Cross-platform CI: `https://github.com/lidge-jun/opencodex/actions/runs/29420930374`
- Failed job: Windows full suite, job `87370883261`
- Failures: the computer-use success/error-payload cases and record-screen start-success case in `tests/cursor-desktop-exec.test.ts`.
- Symptom: the external executor exited with code 1 and `The system cannot find the path specified.` instead of returning the fixture JSON.

## Hypotheses and falsifiers

1. Leading: the fixture is POSIX-only. It injects `cat >/dev/null; printf ...`, while the corrected production path now executes Windows commands with `cmd.exe`. Falsifier: make the fixture use valid `cmd.exe` built-ins and observe the same three failures in exact-SHA Windows CI.
2. Alternative: `shellInvocation` constructs an invalid CMD `/s /c` outer-quote wrapper. Falsifier: existing invocation unit tests plus the repaired fixture execute successfully on Windows.
3. Alternative: stdin handling, environment, or working-directory propagation regressed. Falsifier: a command that drains stdin and emits JSON through platform built-ins passes the unchanged behavior assertions.

## Repair boundary

- Keep production spawning behavior unchanged.
- Preserve every behavior assertion.
- On Windows, drain stdin with `more >nul`, then emit the fixed JSON with `echo`; retain the existing POSIX fixture elsewhere.
- Correct the stale public comment that says commands always run through `sh -c`.
- Green proof requires the focused local suite and a new exact-candidate Windows CI run; a blind rerun of the failed SHA is not sufficient.
