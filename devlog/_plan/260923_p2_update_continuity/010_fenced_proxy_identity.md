# 010 — Fenced proxy identity for manual restart and stop (#5496)

## What current `dev` already does

`src/server/index/package-tree-guard.ts` wires the integrity guard to `acceptSystemRestart`: a
replacement that stays stable for the debounce enters drain-and-restart, a service child re-checks
service-home ownership before draining and before handoff, a failed admission retries, and
`server.stop()` vetoes a pending callback. `tests/ci-workflows/package-tree-restart-ownership.test.ts`
covers those edges with fakes. That part is kept as is.

## Remaining gap

The fenced `/healthz` answers 503 `restart_required`. Three things then refuse it:

1. `proxyIdentityAt` (`src/server/proxy-liveness.ts`) returns null on any non-OK status, so
   `findLiveProxy` reports no proxy and `ocx restart` falls through to a start that cannot bind.
2. The fenced body carries no attestation proof, and `requestBoundSystemRestart`
   (`src/cli/system-restart-client.ts`) requires `proofResponse.ok` and `restartCapability`.
3. The version-skew guard compares the CLI version with the proxy's boot version. After a
   replacement those differ by construction, although the in-place respawn runs the files now on
   disk at the same path.

A PID in a 503 body is attacker-controlled for anyone holding the port, so it cannot be trusted by
itself.

## Design

Identity is bound to owned state the CLI can check, separately from readiness.

Server (`src/server/index/serve-options.ts`, fenced branch, `/healthz` only):
- add the attestation proof header when the request carries a challenge, computed exactly like
  the healthy branch (`createLocalAttestationProof(secret, challenge, process.pid, port)`), over
  the same port value the fenced body reports, which is the port the runtime record holds;
- add `restartCapability` and `installedVersion` (the version in the package manifest now on
  disk, read through the guard) to the body;
- the message names the command that works: `ocx restart` (or `ocx service restart`).

Guard (`src/lib/package-tree-integrity.ts`): optional `installedVersion()` on the guard interface;
the runtime guard reads `package.json` version (bounded semver or undefined); the option
`readInstalledVersion` is a test seam. `package-tree-guard.ts` forwards it.
Review follow-up: a readable manifest is not an install-completion signal, so `installedVersion()`
stays undefined until the guard's stability debounce has seen the same replacement identity for the
full interval, and again whenever the tree has moved since.

CLI liveness (`src/server/proxy-liveness.ts`):
- `LivenessIo.acceptPackageTreeFenced` (opt-in). When set and the 503 body is an opencodex
  `restart_required` body with `error.code === "package_tree_changed"` and an integer pid,
  `proxyIdentityAt` reads the owned runtime record for that pid (`readRuntimeFn(pid)`), requires
  `record.pid === pid`, `record.port === port` and an attestation secret, sends a fresh
  challenge to `/healthz`, and verifies the proof with `verifyLocalAttestationProof`.
  Any failure returns null (unverifiable identity is refused).
- the result and `LiveProxy` carry `packageTreeFenced: true`.
- default callers keep today's behaviour: a fenced proxy is not "live" for ensure, update health
  waits or replacement waits.

Restart client (`src/cli/system-restart-client.ts`):
- accept a 503 proof response only for a fenced body; everything else in the proof check is
  unchanged;
- for a fenced body compare the CLI version with `installedVersion`; a missing or unbounded value
  rejects with `restart_package_tree_unsettled` (retry after the install finishes);
- the pre-POST recheck passes `acceptPackageTreeFenced`.

Callers that opt in: `ocx restart` discovery (`src/cli/index.ts` `handleProxyRestart`), the
`ocx stop` orphan fallback, service stop's orphan fallback and post-stop liveness in
`src/service/orchestration.ts`. `reportRestartFailure` gets a line for the new rejection code
through a helper in `system-restart-client.ts` so `src/cli/index.ts` stays under its cap.

## Tests (new sibling files)

- `tests/server/proxy-liveness-package-tree-fence.test.ts`: attested fenced identity is found only
  with the opt-in; wrong secret, missing record, record pid/port mismatch, expected-pid mismatch and
  a non-fence 503 are all refused.
- `tests/cli/system-restart-client-package-tree.test.ts`: fenced restart is accepted when the
  installed version matches, rejected on skew and on an unsettled tree, and a non-fence 503 is
  still rejected.
- `tests/ci-workflows/package-tree-fenced-restart.test.ts`: real `startServer` in order — boot
  (200), replace the observed tree, fenced 503, automatic admission, manual discovery through the
  real `findLiveProxy` and real `requestBoundSystemRestart` against the live listener (accepted as
  already draining), one scheduled handoff, exactly one exit, and a service child that lost the
  service home never hands off.

## Structure

`structure/ops/docs-and-release.md` "Package-tree integrity fence" gains the identity rule: the
fenced `/healthz` stays attestable, liveness accepts it only by opt-in and only with a proof
from the owned runtime record, and restart compares against the installed version.
