# 020 — Updater leftovers and failure guidance (#5624)

## What is and is not established

- The current npm updater (`bin/ocx.mjs` -> `transactionalNpmUpdate` in
  `src/update/transactional-install.mjs`) stages into a sibling `.ocx-staging-<timestamp>`
  prefix, verifies, and swaps with rollback. Our code never creates `@bitkyc08/.opencodex-*`;
  that name is npm's own rename-aside during a direct global install.
- Stage cleanup is a `rmSync(..., { force: true })` whose errors are swallowed. A locked file (the
  reported `bunx.exe`, EPERM) leaves the staging tree in place silently and nothing sweeps it.
- `mkdirSync(stageRoot, { recursive: true })` would reuse an existing directory of the same
  name instead of failing.
- The ENOTDIR on `mkdir` in the report is not explained by this code. The job log withholds the
  path, so the component that was a file is unknown. It is not attributed to the leftover tree.
- The GUI job records only `update command failed (N)`; the one recovery command is printed on
  the child's stderr.

## Design

`src/update/transactional-install.mjs`:
- Staging directories are created exclusively (`mkdirSync` without `recursive`, a random suffix
  after the timestamp) and immediately receive an ownership marker `.ocx-update-owner.json`
  (`{ schema: 1, kind: "staging", pkgName, pid, createdAt }`).
- `removeOwnedStage(dir)` deletes every entry except the marker, retrying EPERM/EBUSY/EACCES
  briefly; the marker is removed last and only when everything else is gone, so a partly locked
  tree stays provably owned for the next sweep.
- `sweepUpdateLeftovers({ scopeDir, pkgName })` runs before staging. It removes only
  `.ocx-staging-*` real directories whose marker parses with `kind: "staging"` and the same
  `pkgName` and whose `createdAt` is older than a floor well above the npm install timeout, so a
  concurrent update from another home sharing the prefix never loses its in-flight stage. It never
  follows symlinks or junctions, never touches `.ocx-backup-*` (the boot
  probe owns those), and reports unmarked `.ocx-staging-*` and npm's `.<name>-*` rename-asides as
  not owned with their paths. A locked owned tree is reported and retried next time. The sweep never
  fails the update.
- A post-swap verification failure moves the rejected tree into the owned stage before restoring the
  backup, instead of deleting it in place, so a locked file there cannot turn a rollback into a
  double fault.
- `launcherUsableAfterNpmUpdate(tx)` replaces the inline expression in `bin/ocx.mjs`.

`src/update/update-failure-guidance.mjs` (new): `npmUpdateFailureGuidance({ phase, rolledBack,
pkgName, version })` returns the next step. Previous version kept: run `ocx update` again; if it
fails the same way, `ocx stop`, `npm install -g --allow-scripts=bun <pkg>@<version>`, then
`ocx service restart` (or `ocx start`). Double fault: restore with the command in
`.ocx-recovery.json` or reinstall.

`bin/ocx.mjs` prints the guidance at the end of a failed npm update in place of the old
"Try manually" line. `src/update/job.ts` appends a
short fixed next step to `update command failed (N)` (net +1 line, file stays under 2000).

## Tests (new sibling file `tests/update/update-transactional-leftovers.test.ts`)

- Injected failure at each step (stage mkdir, npm stage install, staged verify, live->backup rename,
  stage->live rename, post-swap verify, double fault): the live tree keeps the old version or is
  rolled back, `launcherUsableAfterNpmUpdate` and `planStoppedRuntimeRecovery` restore the
  previous service, and the guidance names the next command.
- A stage left behind by a locked file keeps its marker; the next update removes it and succeeds.
- Unmarked `.ocx-staging-*`, npm's `.opencodex-*`, a marker for another package, and a symlink or
  junction named like a stage are all left intact.

## Docs

- `docs-site/src/content/docs/troubleshooting/update-failed.md` (English) with the sidebar entry,
  plus locale pages that say the same thing.
- `reference/cli/lifecycle.md` links to it from the update section.
