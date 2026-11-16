# Signed standalone updates — draft unit

**Status:** depends on signed supply, update-stop admission, package/guardian
recovery and linked update contracts. The current orchestrated plan maps a
non-Desktop standalone installation to unknown (`src/update/orchestrated-entry.ts:128`);
this unit must not change that refusal until the new owner is proven.

## Outcome and proposed file map

Support an explicitly owned standalone executable on the existing release
targets (`scripts/standalone-targets.ts:7`). The owner downloads a signed exact
platform artifact, verifies it and a signed previous recovery artifact, stages
both outside the live executable and uses the same policy, idle reservation,
receipt-backed stop and durable recovery contracts as the package unit.
Unknown, foreign, source and externally managed paths remain refused.

| Operation | Proposed path | Required change |
| --- | --- | --- |
| NEW | `src/update/standalone-owner.ts`, `src/update/standalone-stage.ts` | Resolve and bind the selected real executable and install owner; verify the signed exact target and recovery material; expose an owner-held stage without executing downloaded bytes. |
| NEW | `src/update/standalone-replace.ts` and a signed recovery helper | Perform a same-owner replacement and rollback using existing mutation controls and the update-stop authority that `020` must first design and prove. On Windows, use a verified external helper that waits for the executing image to exit; no uncontained replacement or unverified helper. |
| MODIFY | `src/update/orchestrated-plan.ts`, `src/update/orchestrated-entry.ts`, `src/cli/capability-contracts.ts` | Advertise a separate versioned automatic capability only after its owned standalone path is implemented; preserve existing `ocx.update.plan/1` and result behavior. |
| MODIFY | `scripts/build-standalone.ts`, `desktop/scripts/verify-release-assets.ts`, release workflow within its existing permissions | Produce and verify signed target/recovery artifacts and the exact compatibility metadata. No release is published by this task. |
| NEW | `tests/update/update-standalone-automatic.test.ts`, `tests/cli/cli-standalone-update-owner.test.ts` | Domain-registered, isolated fixtures for signed staging, owner changes, idle admission, process termination, crash at each swap, rollback and health. |
| MODIFY | `structure/runtime.md`, `structure/ops/service-and-sidecars.md`, relevant release and user docs plus translations | Describe actual supported owners, platforms and recovery. |

The standalone build is a multi-file installation: it includes the compiled
executable, a target-specific native keyring addon and `gui/dist`
(`scripts/build-standalone.ts:84`, `:95`). Replacing only the executable does
not establish a matching signed release. The selected adapter owns an explicit
managed installation directory containing versioned complete signed generations
and a stable launcher/selection record; it verifies the complete inventory,
including the addon and GUI, before a cutover. A legacy loose executable or
foreign directory first needs an explicit owner-guided bootstrap into that
layout; do not infer ownership or delete neighboring files. The bootstrap and
its failure/recovery tests are part of this unit, not a deferred exclusion.

Use the signed guardian and operation journal from `030`: stage an exact target
generation and separately authenticated prior generation, acquire the `020`
installation fence, prove runtime/process exit, and publish one durable
generation selection under the owner. On POSIX, prove same-filesystem atomic
publication and recovery of the selection; on Windows, the verified guardian
waits for the executing image and observes its own replacement operation before
readback. If the platform cannot establish selection atomicity or durable
recovery, refuse that owner's automatic update and keep its parity row open.
Validate the real launcher, selected generation, native addon, GUI and serving
version together after restart; a matching executable version alone is not
health. Tests cover loose-layout bootstrap, unrelated neighboring files,
cross-volume refusal, interrupted selection, guardian death and signed prior
generation restoration on every supported release target.

## Activation and evidence

- Valid signed exact-platform bytes stage in a temporary owner-controlled home;
  missing/wrong signatures, wrong architecture, altered stage, ambiguous owner
  and absent signed recovery material refuse before runtime stop.
- Busy or unknown activity defers. A successful owner-bound stop precedes any
  replacement, and the previous executable remains recoverable until target
  health and the probation period complete.
- Simulate interruption before/after each durable journal, rename or helper
  boundary, lost response and surviving process. Verify either the previous
  signed executable is restored or an honest uncertain state is retained;
  never run a second installer on an unconfirmed outcome.
- Exercise each supported OS/architecture through isolated tests and relevant
  native CI. Require the separate security PASS, typecheck, privacy/structure,
  Lab boundary, test-layout/file-size guards and exact-head CI. Commands and
  platform-specific helper implementation remain to be concretized and audited.
