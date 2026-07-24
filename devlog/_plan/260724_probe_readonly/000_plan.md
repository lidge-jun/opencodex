# 260724 Probe-Readonly Hotfix — 000 Plan (C2, compact)

Discovered mid-loop (LOOP-UNIT-CHAIN-01 insert, work-phase wp-probe-readonly).

## Problem

`ocx status --json` promises read-only behavior
(tests/codex-plugins-doctor.test.ts:312 asserts CODEX_HOME unchanged), but
on machines with a real `codex` binary on PATH, #359's runtime probe runs
`codex --version` with the user's env — including CODEX_HOME — and the
real Codex CLI creates `$CODEX_HOME/tmp` as a side effect
(src/codex/runtime.ts:241-250, probe via codexExecInvocation).
Result: tests/codex-plugins-doctor.test.ts fails locally (16 pass / 1
fail), and the prepush full suite rejects dev pushes on this machine.
Confirmed pre-existing: reproduces on clean origin/dev b77cdcb9 without
any loop commits. CI stays green because CI runners have no codex binary.

## Fix (diff-level)

src/codex/runtime.ts — MODIFY the probe execution (~241-250):
- Before execFile, create a throwaway dir
  `mkdtempSync(join(tmpdir(), "ocx-codex-probe-"))` INSIDE the existing
  try block (A-gate fold): probeVersion is a total function that never
  throws — if mkdtemp itself fails (tmpdir unwritable/exhausted), return
  `{ ok: false, reason: "probe sandbox unavailable" }` instead of
  throwing or falling back to the inherited env (which would resurrect
  the side effect).
- Run the probe with `CODEX_HOME=<throwaway>` merged over the resolved env
  so any side effects of the probed binary land in the throwaway, never in
  the user's real CODEX_HOME.
- `finally`: `rmSync(throwaway, { recursive: true, force: true })` in a
  nested try/catch (Windows transient EBUSY) so cleanup failure never
  masks the probe result.
- Keep everything else identical (timeout, stdio, version parse, redacted
  error). Probe failures must still return the same { ok: false, reason }
  shapes; cleanup failure must not mask the probe result.
- Deps seam: reuse existing deps pattern (`deps.env`); add optional
  `deps.mkdtemp`/`deps.rm` ONLY if tests need injection — prefer direct
  os tmpdir use since the test asserts real fs behavior anyway.

## Activation scenario (C-ACTIVATION-GROUNDING-01)

tests/codex-plugins-doctor.test.ts — the existing read-only assertion is
the regression pin: it must pass on a machine WITH a codex binary on PATH
(this machine reproduces the failure). No new test file needed; optionally
extend with an explicit assertion that no `tmp` dir appears.

## Verify

bun run typecheck; bun test tests/codex-plugins-doctor.test.ts; then full
bun run test (prepush gate) green on this machine.

## Out of scope

Changing what the probe validates, #359's runtime persistence semantics,
the shim.
