// Best-effort regression lint data, not a security boundary or completeness proof.
// Review rows for the #8103 orchestrated-update modules child/driver/session (orchestrated-child.mjs, orchestrated-node-driver.mjs, orchestrated-session.mjs, orchestrated-pnpm.mjs, orchestrated-tree.mjs, orchestrated-outcome.mjs, orchestrated-token.*, orchestrated-arguments.mjs, orchestrated-admission.mjs), kept apart from the base
// tables so each group is reviewed on its own. The base tables merge these rows unchanged;
// a file key may appear in only one table. Row classes follow the base tables: read-only,
// pre-mutation, guarded (mutation-guard wrapper or a fresh authorizeMutation), or delegated
// (inside a dedicated child entry; the reason names the guarded spawn its reviewed caller uses and what the child itself enforces).
import type { UpdateReviewTable } from "./update-review-table";

export const orchestratedChildReview: UpdateReviewTable = {
  staticImports: {
    "src/update/orchestrated-node-driver.mjs": [
      // Read-only canonical path comparison; the result channel lives in orchestrated-session.mjs.
      'import { realpathSync } from "node:fs";',
      // Read-only admission and identity checks.
      'import { decideOrchestratedApply } from "./orchestrated-admission.mjs";',
      'import { createOrchestratedResultChannel, encodeOrchestratedExpect } from "./orchestrated-session.mjs";',
      'import { createUpdatePlanToken } from "./orchestrated-token.mjs";',
      // Parent monitors its exact child and verifies the outcome and installed tree.
      'import { waitForOrchestratedChild } from "./orchestrated-child.mjs";',
      'import { classifyOrchestratedOutcome } from "./orchestrated-outcome.mjs";',
      'import { verifyOrchestratedInstall } from "./orchestrated-tree.mjs";',
      'import { verifyOrchestratedPnpmInstall } from "./orchestrated-pnpm.mjs";',
      'import { resolvePnpmGlobalOwner } from "./pnpm-global-install.mjs";',
      'import { parseOrchestratedUpdateArgs } from "./orchestrated-arguments.mjs";',
    ],
    "src/update/orchestrated-outcome.mjs": [
      // Read-only outcome path validation.
      'import { isAbsolute } from "node:path";',
    ],
    "src/update/orchestrated-pnpm.mjs": [
      // Read-only installed tree and pnpm owner verification.
      'import { join } from "node:path";',
      'import { readPnpmGlobalPackage, resolvePnpmGlobalOwner } from "./pnpm-global-install.mjs";',
      'import { verifyPnpmInstallTree } from "./transactional-install.mjs";',
    ],
    "src/update/orchestrated-session.mjs": [
      // Marker atomicJson, the parent result channel and descriptor-bound result publication; each site is reviewed below.
      'import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";',
      // Pre-mutation path validation and synchronization admission.
      'import { basename, dirname, isAbsolute, join } from "node:path";',
      'import { inspectUpdateMarker, tryAcquireUpdateSyncMutex } from "./sync-update-mutex.mjs";',
      'import { assertNotRealHomeUnderTest } from "./test-home-guard.mjs";',
    ],
    "src/update/orchestrated-token.ts": [
      // Read-only plan token implementation re-export.
      'export { createUpdatePlanToken } from "./orchestrated-token.mjs";',
    ],
    "src/update/orchestrated-tree.mjs": [
      // Read-only installed tree verification.
      'import { join } from "node:path";',
      'import { verifyInstallTree } from "./transactional-install.mjs";',
    ],
  },
  deferredImports: [],
  primitive: [
    ["src/update/orchestrated-session.mjs:readAll:readSync(fd, bytes, read, size - read, read)", "read through a descriptor its caller opened and identity-checked"],
    ["src/update/orchestrated-session.mjs:issueOrchestratedResultCapability:openSync(path, \"wx\", 0o600)", "exclusive create (wx, 0600) of a new capability file; fails if anything already exists at the path"],
    ["src/update/orchestrated-session.mjs:issueOrchestratedResultCapability:writeSync(fd, document, written, document.length - written, written)", "write the capability document through the descriptor this function just created exclusively"],
    ["src/update/orchestrated-session.mjs:issueOrchestratedResultCapability:closeSync(fd)", "close the descriptor this function opened"],
    ["src/update/orchestrated-session.mjs:createOrchestratedResultChannel:realpathSync.native(mkdtempSync(join(tmpdir(), \"ocx-update-\")))", "canonicalize the directory this function just created"],
    ["src/update/orchestrated-session.mjs:createOrchestratedResultChannel:mkdtempSync(join(tmpdir(), \"ocx-update-\"))", "fresh result directory under the OS temp root (0700 on POSIX), canonicalized before use"],
    ["src/update/orchestrated-session.mjs:createOrchestratedResultChannel:openSync(resultPath, constants.O_RDONLY | NOFOLLOW)", "read-only open of the recorded result file (no-follow where the platform defines O_NOFOLLOW); fstat must match the identity recorded at creation, size bounded"],
    ["src/update/orchestrated-session.mjs:createOrchestratedResultChannel:closeSync(readFd)", "close the read descriptor this method opened"],
    ["src/update/orchestrated-session.mjs:createOrchestratedResultChannel:unlinkSync(resultPath)", "POSIX only, when no ancestor of the channel can be replaced by another principal (removableChannel); a preceding lstat must show the identity recorded at creation. Path-based, so a same-user swap inside the owner-only directory between check and unlink is an accepted residual; Windows leaves the channel in place"],
    ["src/update/orchestrated-session.mjs:createOrchestratedResultChannel:rmdirSync(directory)", "POSIX only, under the same removableChannel rule; non-recursive removal after a preceding lstat matches the recorded directory identity (same accepted same-user race); a non-empty directory is refused and left in place"],
    ["src/update/orchestrated-session.mjs:openResultDestination:openSync(resultPath, constants.O_RDWR | NOFOLLOW)", "open after the lstat checks (no-follow where the platform defines O_NOFOLLOW); kept only if fstat matches, the size is exactly the capability document length and the whole content equals it"],
    ["src/update/orchestrated-session.mjs:openResultDestination:closeSync(fd)", "close the candidate descriptor when validation fails"],
    ["src/update/orchestrated-session.mjs:publishResult:ftruncateSync(fd, 0)", "publish through the descriptor validated by openResultDestination: truncate first"],
    ["src/update/orchestrated-session.mjs:publishResult:writeSync(fd, bytes, written, bytes.length - written, written)", "publish through the descriptor validated by openResultDestination: whole record at explicit offsets"],
    ["src/update/orchestrated-session.mjs:publishResult:fsyncSync(fd)", "flush the validated result descriptor"],
    ["src/update/orchestrated-session.mjs:createOrchestratedChildSession:closeSync(fd)", "close the validated result descriptor at a terminal session state"],
    ["src/update/orchestrated-node-driver.mjs:applyNodeOrchestratedUpdate:deps.spawn(process.execPath, args, { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: \"1\", OCX_UPDATE_RESULT_CAPABILITY: channel.capability }, stdio: [\"ignore\", 2, 2] })", "ordinary launcher for the orchestrated update child, as job.ts spawnGuiUpdateWorker; the child takes the sync/update mutex, ownership lease, plan-token and attested identity checks and its own home authorization before any mutation"],
    ["src/update/orchestrated-session.mjs:atomicJson:writeFileSync(temp, `${JSON.stringify(value)}\\n`, { encoding: \"utf8\", flag: \"wx\", mode: 0o600 })", "home marker only (marker() is atomicJson's sole caller), written only while the session holds the sync/update mutex; exclusive 0600 temp then rename. Path-based: assumes the OpenCodex home and its ancestors cannot be replaced by another principal (stated, not enforced)"],
    ["src/update/orchestrated-session.mjs:atomicJson:renameSync(temp, path)", "home marker only (marker() is atomicJson's sole caller), written only while the session holds the sync/update mutex; same stated home-ancestor precondition as the temp write"],
    ["src/update/orchestrated-session.mjs:atomicJson:unlinkSync(temp)", "remove the writer's unrenamed temp path after a failed write; path-based, under the same stated home-ancestor precondition"],
    ["src/update/orchestrated-child.mjs:waitForOrchestratedChild:child.kill(signal)", "forward a signal this parent received to its own update child only; the child decides how to stop"],
    ["src/update/orchestrated-arguments.mjs:strictSemver:CORE.exec(value)", "read-only semver regular expression match"],
    ['src/update/orchestrated-session.mjs:<module>:import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";', "marker atomicJson, parent result channel and descriptor-bound result publication; every call site has its own row"],
  ],
  process: [
    ["src/update/orchestrated-child.mjs:waitForOrchestratedChild:options.signals ?? process", "injectable signal source for forwarding to the exact child; only on/removeListener of SIGINT, SIGTERM, SIGHUP", 1],
    ['src/update/orchestrated-child.mjs:protectOrchestratedWorkerSignals:process.on(signal, () => {})', "pre-mutation signal protection keeps the worker alive", 1],
  ],
  contracts: [
    ["src/update/orchestrated-session.mjs", "readAll", "readSync(fd, bytes, read, size - read, read)", 1, "read through a descriptor its caller opened and identity-checked"],
    ["src/update/orchestrated-session.mjs", "issueOrchestratedResultCapability", "openSync(path, \"wx\", 0o600)", 1, "exclusive create (wx, 0600) of a new capability file; fails if anything already exists at the path"],
    ["src/update/orchestrated-session.mjs", "issueOrchestratedResultCapability", "writeSync(fd, document, written, document.length - written, written)", 1, "write the capability document through the descriptor this function just created exclusively"],
    ["src/update/orchestrated-session.mjs", "issueOrchestratedResultCapability", "closeSync(fd)", 1, "close the descriptor this function opened"],
    ["src/update/orchestrated-session.mjs", "createOrchestratedResultChannel", "realpathSync.native(mkdtempSync(join(tmpdir(), \"ocx-update-\")))", 1, "canonicalize the directory this function just created"],
    ["src/update/orchestrated-session.mjs", "createOrchestratedResultChannel", "mkdtempSync(join(tmpdir(), \"ocx-update-\"))", 1, "fresh result directory under the OS temp root (0700 on POSIX), canonicalized before use"],
    ["src/update/orchestrated-session.mjs", "createOrchestratedResultChannel", "openSync(resultPath, constants.O_RDONLY | NOFOLLOW)", 1, "read-only open of the recorded result file (no-follow where the platform defines O_NOFOLLOW); fstat must match the identity recorded at creation, size bounded"],
    ["src/update/orchestrated-session.mjs", "createOrchestratedResultChannel", "closeSync(readFd)", 1, "close the read descriptor this method opened"],
    ["src/update/orchestrated-session.mjs", "createOrchestratedResultChannel", "unlinkSync(resultPath)", 1, "POSIX only, when no ancestor of the channel can be replaced by another principal (removableChannel); a preceding lstat must show the identity recorded at creation. Path-based, so a same-user swap inside the owner-only directory between check and unlink is an accepted residual; Windows leaves the channel in place"],
    ["src/update/orchestrated-session.mjs", "createOrchestratedResultChannel", "rmdirSync(directory)", 1, "POSIX only, under the same removableChannel rule; non-recursive removal after a preceding lstat matches the recorded directory identity (same accepted same-user race); a non-empty directory is refused and left in place"],
    ["src/update/orchestrated-session.mjs", "openResultDestination", "openSync(resultPath, constants.O_RDWR | NOFOLLOW)", 1, "open after the lstat checks (no-follow where the platform defines O_NOFOLLOW); kept only if fstat matches, the size is exactly the capability document length and the whole content equals it"],
    ["src/update/orchestrated-session.mjs", "openResultDestination", "closeSync(fd)", 1, "close the candidate descriptor when validation fails"],
    ["src/update/orchestrated-session.mjs", "publishResult", "ftruncateSync(fd, 0)", 1, "publish through the descriptor validated by openResultDestination: truncate first"],
    ["src/update/orchestrated-session.mjs", "publishResult", "writeSync(fd, bytes, written, bytes.length - written, written)", 1, "publish through the descriptor validated by openResultDestination: whole record at explicit offsets"],
    ["src/update/orchestrated-session.mjs", "publishResult", "fsyncSync(fd)", 1, "flush the validated result descriptor"],
    ["src/update/orchestrated-session.mjs", "createOrchestratedChildSession", "closeSync(fd)", 1, "close the validated result descriptor at a terminal session state"],
    ["src/update/orchestrated-node-driver.mjs", "applyNodeOrchestratedUpdate", "deps.spawn(process.execPath, args, { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: \"1\", OCX_UPDATE_RESULT_CAPABILITY: channel.capability }, stdio: [\"ignore\", 2, 2] })", 1, "ordinary launcher for the orchestrated update child, as job.ts spawnGuiUpdateWorker; the child takes the sync/update mutex, ownership lease, plan-token and attested identity checks and its own home authorization before any mutation"],
    ["src/update/orchestrated-session.mjs", "atomicJson", "writeFileSync(temp, `${JSON.stringify(value)}\\n`, { encoding: \"utf8\", flag: \"wx\", mode: 0o600 })", 1, "home marker only (marker() is atomicJson's sole caller), written only while the session holds the sync/update mutex; exclusive 0600 temp then rename. Path-based: assumes the OpenCodex home and its ancestors cannot be replaced by another principal (stated, not enforced)"],
    ["src/update/orchestrated-session.mjs", "atomicJson", "renameSync(temp, path)", 1, "home marker only (marker() is atomicJson's sole caller), written only while the session holds the sync/update mutex; same stated home-ancestor precondition as the temp write"],
    ["src/update/orchestrated-session.mjs", "atomicJson", "unlinkSync(temp)", 1, "remove the writer's unrenamed temp path after a failed write; path-based, under the same stated home-ancestor precondition"],
    ["src/update/orchestrated-child.mjs", "waitForOrchestratedChild", "child.kill(signal)", 1, "forward a signal this parent received to its own update child only; the child decides how to stop"],
    ['src/update/orchestrated-pnpm.mjs', 'verifyOrchestratedPnpmInstall', 'runPnpm(owner.commandPath, args, capture)', 1, "read-only pnpm owner verification probe"],
    ['src/update/orchestrated-child.mjs', 'protectOrchestratedWorkerSignals', 'process.on(signal, () => {})', 1, "pre-mutation signal protection keeps the worker alive"],
  ],
};
