# Signed pnpm-owned updates — draft unit

**Status:** follows the common signed supply, idle admission and npm-owned
stage/recovery work. The existing pnpm updater mutates its selected global
owner through pnpm and uses pnpm again for rollback
(`src/update/pnpm-global-install.mjs:464`, `:513`, `:564`). A signed npm-shaped
tree cannot be renamed into pnpm's virtual store and treated as pnpm ownership.

## Proposed implementation slice

1. Add `src/update/pnpm-prepared-install.mjs` and declaration sibling. Resolve
   the existing `PnpmGlobalOwner`, its global root, bin root, virtual-store and
   lock inputs through the existing owner helpers; refuse ambiguous or changed
   ownership. Bind those facts and the exact signed candidate to an owner-held
   operation record.
2. Build a disposable pnpm global layout from the verified local signed
   dependency closure with lifecycle scripts disabled and network unavailable.
   Compare all resulting package/store entries and generated bin links against
   the signed inventory and the selected owner. Never write to the live global
   group during preparation. The exact pnpm invocation and relocatable layout
   are an explicit experiment and audit blocker, not a presumed supported flag.
3. Before activation, reacquire the existing home sync/update guard and service
   ownership lease. Obtain installation-wide coordination only after `020`
   designs and proves it; revalidate policy, stage and selected pnpm owner, then use
   the `020` update-stop reservation. Use a manager-mediated selected-owner
   transition, journaled before each operation; do not describe it as an atomic
   group/bin swap. Bind and verify the generated shims, selected final store,
   complete publisher inventory and process exit before declaring installation.
   Keep signed previous archives, store identity and metadata for recovery until
   target health and probation complete.
4. Extend `src/update/orchestrated-pnpm.mjs` and the automatic coordinator with
   a separately versioned prepared operation; preserve the existing explicit
   pnpm command and strict output schemas while requiring verified supply.
   Unsupported versions/layouts refuse
   with an actionable state rather than falling back to an online install.

Modify `tests/update/update-pnpm.test.ts` and add domain-registered
`tests/update/update-pnpm-prepared.test.ts` plus any required platform fixture.
Use temporary global roots, a local test key, fake or isolated manager process
and network-denial assertions. Exercise missing/altered artifacts, lifecycle
script refusal, symlinks/shims, changed global owner, uncertain process exit,
concurrent sync, crash before/after group transition, verified rollback and
health. No test touches the real global installation.

Update `structure/ops/service-and-sidecars.md`, other mapped owners and user
docs/translations. Run red-to-green focused tests, typecheck, privacy/structure,
test-layout/file-size and Lab boundary checks, relevant native/CI coverage,
and a separate independent security PASS. Actual supported pnpm versions,
offline preparation command, platform layout, writer exclusion and durable
manager-mediated transition must be proved before automatic activation.

## Isolated feasibility observation

On 2026-11-07, the host's pnpm reported `12.18.0`. A macOS `sandbox-exec`
fixture denied network and writes outside its private temporary root; separate
probes confirmed those denials. Adding a local inert fixture with
`--global --ignore-scripts --ignore-pnpmfile` and a fixture-owned store did not
run its postinstall. The first attempt refused because its isolated bin path
was not on `PATH`; after correcting that path, pnpm exited 1 with
`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` / `Operation not permitted`, including
when the fixture state directory was supplied. No real global install was
touched. This shows only that this first sandbox configuration did not complete
the operation; it does **not** establish a pnpm defect or prove pnpm cannot
stage offline. A later run with fixture-owned `XDG_RUNTIME_DIR`, store and state
paths exited 0 without running the postinstall. The decisive configuration
change and original lock location were not established.

A separate probe used the already-installed pnpm `11.10.0` directly, with a
fresh fixture-owned global home/store, `--global --offline --ignore-scripts
--ignore-pnpmfile`, and the same network/outside-write sandbox. It exited 0,
and the inert fixture's postinstall sentinel remained absent. The resulting
global group contained a package symlink into the separate fixture store and
generated bin files. This is positive evidence for one local no-dependency
fixture only: it does not establish relocatability, signed dependency closure,
atomic live-group activation or recovery. A further pnpm 11 fixture changed
versions 1.0.0 → 1.1.0 → 1.0.0 offline with the sentinel absent. Copying its
global home without the separate store broke the package link; its generated
bin script still pointed into the original fixture. These observations do not
prove a safe relocation or a crash-safe live update.

Pre-audit research investigated a manager-supported transition and recovery
with a locally signed dependency fixture. Exact commands, publisher-signed
versus manager-generated bytes, store/bin ownership, interruption and cleanup
evidence are retained under `.tmp/`; no real install was touched.

The follow-up isolated investigation on macOS arm64 with pnpm 11.10.0 used a
signed local two-package fixture, a private store kept at its final path and a
selected-owner offline manager re-add. Preparation, activation and restoration
completed in that fixture; three controlled process interruptions exposed
intermediate group/bin states and the previous signed fixture was subsequently
restored. This selects manager-mediated re-add plus a durable owner-held journal
as the implementation direction, **not** an atomic switch or proof of safe
production activation. Bind exact signed prior/candidate archives and store,
global and bin identities, recheck policy/owner/idle, prove process-tree exit,
verify the complete installed graph and generated wrappers before any candidate
execution, and reconcile every interrupted transition before another installer.
Require installation-scoped exclusion from `020`, safe owned cleanup, verified
recovery, real OpenCodex executable closure and platform/version tests. No
unproven layout is automatically eligible; the detailed negative evidence
remains in the private research packet.

For the observed pnpm 11.10.0 fixture, classify the global manifest, lock,
`.modules.yaml`, manager index and global/internal bin wrappers as generated
state, separate from signed package files. The adapter permits only the
version-specific schema and exact wrapper templates it has tested, with each
resolved command and symlink bound to the selected final store and signed
payload. Other pnpm versions, store formats, wrapper forms or platforms remain
unavailable until their own fixtures prove the same contract. Persist the
validated generated-state digest for drift/recovery readback; do not accept
unknown files merely because they are under the store. Test changed metadata,
unexpected executable/link, owner path changes and manager-specific recovery
without executing candidate code until the full output verifies.
