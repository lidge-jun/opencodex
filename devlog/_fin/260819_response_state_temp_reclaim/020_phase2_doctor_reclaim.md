# Phase 2 — operator reclaim via `ocx doctor`

## Thesis

An operator whose proxy will not start can reclaim abandoned response-state temps with
a documented command, instead of being told to hand-craft a `find -delete`.

## Why this layer exists on top of phase 1

Phase 1 covers every proxy that runs. It cannot cover the reported case at its worst:
a proxy stuck in a crash loop never reaches a sweeper tick either, because the tick
lives in the same process. The field report described exactly that state — scheduled
task installed, proxy not running, disk filling. For that operator the only in-product
recovery is a command that runs WITHOUT the server.

Depends on phase 1 for `sweepAbandonedResponseStateTemps`: the doctor path reuses the
same two-directory resolution, so the two surfaces cannot disagree about which files
are reclaimable.

## Change map

### MODIFY `src/cli/doctor.ts`

`runDoctor` (`:768`) currently branches on `--fix-codex-runtime`. Add a reporting
section to the default path, and reclaim only when explicitly asked.

- Default `ocx doctor`: REPORT matched temps and their total bytes. Read-only.
- `ocx doctor --reclaim-response-temps`: perform the reclaim and print what was freed.

Report-by-default is deliberate. `doctor` is a diagnostic an operator runs to
understand a machine; deleting files as a side effect of asking a question is the
wrong default, even for cache files.

```ts
const reclaim = args.includes("--reclaim-response-temps");
const result = reclaim
  ? reclaimAbandonedResponseStateTemps()
  : inspectAbandonedResponseStateTemps();
if (result.matched === 0) {
  console.log("Response-state temps: none abandoned.");
} else if (reclaim) {
  console.log(`Response-state temps: reclaimed ${result.removed} file(s), ${formatBytes(result.bytesRemoved)} freed.`);
  if (result.failed > 0) console.log(`  ${result.failed} file(s) could not be removed (in use or locked).`);
} else {
  console.log(`Response-state temps: ${result.matched} abandoned file(s), ${formatBytes(result.bytes)} reclaimable.`);
  console.log("  Run: ocx doctor --reclaim-response-temps");
}
```

### MODIFY `src/responses/state.ts`

Export a dry-run counterpart so doctor can report without deleting. It must share the
SAME selection predicate as the reclaim — a separate matcher would drift and the two
surfaces would disagree about which files are reclaimable.

**Corrected after WP0 self-verification.** The original proposal (inject a no-op
`unlink`) is wrong: `state.ts:586-590` increments `removed` and accrues
`bytesRemoved` only inside the successful-unlink branch, so a no-op `unlink` still
reports `removed` as though files were deleted. `maxCleanups` also bounds a
report-only pass, truncating the count an operator is shown. And
`ResponseStateTempRecoveryOptions` (`state.ts:507`) is module-private, so
out-of-module IO injection does not typecheck at all.

Add an explicit `dryRun` option to the shared function instead, with its own
accounting branch:

```ts
// inside the loop, replacing the unconditional unlink:
if (dryRun) {
  result.wouldRemove += 1;
  result.bytesReclaimable += file.size;
  continue;
}
```

A dry run keeps every selection gate (basename, regular-file, age, boot floor, pid
liveness) and changes only the action. Report and reclaim then cannot disagree.

### MODIFY `docs-site/`

Document the flag on the troubleshooting/disk-usage page, including what the files are
and why they are safe to remove (continuation cache, not durable state).

### MODIFY `tests/`

Doctor-level test: report mode leaves files intact; reclaim mode removes only stale
ones. Live-PID and young-file protection is already covered by phase 1's tests and is
not re-asserted here.

## Scope boundary

IN: the doctor surface, the dry-run export, docs, tests.

OUT: an auto-reclaim-on-start behavior. That would run before the crash that is being
diagnosed, and silently deleting evidence during a crash loop is hostile to whoever is
debugging it.

OUT: reclaiming any other subsystem's temps under the same flag. The flag names
response temps and reclaims only those.

## Accept criteria

| # | Scenario | Observable proof |
|---|----------|------------------|
| 1 | `ocx doctor` with abandoned temps present | count + bytes reported; files still on disk |
| 2 | `ocx doctor --reclaim-response-temps` | stale files removed; freed bytes printed |
| 3 | No abandoned temps | clean single-line report, no flag suggestion |
| 4 | Proxy not running | both paths work — no server dependency |
| 5 | Report then reclaim on the same fixture | reported count/bytes equal what reclaim removes |
| 6 | More stale temps than the cleanup budget | report is not truncated by `maxCleanups` |

Criterion 4 is the whole point of the layer: assert the code path imports nothing that
requires a live server.

## Verification

Focused doctor + state tests, then `bun run typecheck` and `bun run test` before the
PR is review-ready.
