// Best-effort regression lint data, not a security boundary or completeness proof.
// Review rows for the #8103 orchestrated-update modules child/driver/session (orchestrated-child.mjs, orchestrated-node-driver.mjs, orchestrated-session.mjs, orchestrated-pnpm.mjs, orchestrated-tree.mjs, orchestrated-outcome.mjs, orchestrated-token.*, orchestrated-arguments.mjs, orchestrated-admission.mjs), kept apart from the base
// tables so each group is reviewed on its own. The base tables merge these rows unchanged;
// a file key may appear in only one table. Row classes follow the base tables: read-only,
// pre-mutation, guarded (mutation-guard wrapper or a fresh authorizeMutation), or delegated
// (a dedicated child reachable only through a guarded parent spawn, which the reason names).
import type { UpdateReviewTable } from "./update-review-table";

export const orchestratedChildReview: UpdateReviewTable = {
  staticImports: {
    "src/update/orchestrated-node-driver.mjs": [
      // Pre-mutation private result directory; reads and cleanup are reviewed separately.
      'import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";',
      // Read-only path construction and admission/identity checks.
      'import { join } from "node:path";',
      'import { decideOrchestratedApply } from "./orchestrated-admission.mjs";',
      'import { encodeOrchestratedExpect } from "./orchestrated-session.mjs";',
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
      // Session marker and result writes are reviewed separately.
      'import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";',
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
    ["src/update/orchestrated-node-driver.mjs:applyNodeOrchestratedUpdate:deps.spawn(process.execPath, args, { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: \"1\" }, stdio: [\"ignore\", 2, 2] })", "ordinary launcher for the orchestrated update child, as job.ts spawnGuiUpdateWorker; the child takes the sync/update mutex, ownership lease, plan-token and attested identity checks and its own home authorization before any mutation"],
    ["src/update/orchestrated-node-driver.mjs:applyNodeOrchestratedUpdate:rmSync(directory, { recursive: true, force: true })", "remove only this parent's own mkdtemp result directory before the child starts or after it exits"],
    ["src/update/orchestrated-session.mjs:atomicJson:writeFileSync(temp, `${JSON.stringify(value)}\\n`, { encoding: \"utf8\", flag: \"wx\", mode: 0o600 })", "this transaction's own records only: the home's update-orchestrated.json marker, written only while the session holds the sync/update mutex, and result documents (including preflight and refusal outcomes written without the mutex) at the absolute resultPath inside the parent's private mkdtemp directory; exclusive 0600 temp file then rename; no package, runtime or service authority"],
    ["src/update/orchestrated-session.mjs:atomicJson:renameSync(temp, path)", "this transaction's own records only: the home's update-orchestrated.json marker, written only while the session holds the sync/update mutex, and result documents (including preflight and refusal outcomes written without the mutex) at the absolute resultPath inside the parent's private mkdtemp directory; exclusive 0600 temp file then rename; no package, runtime or service authority"],
    ["src/update/orchestrated-session.mjs:atomicJson:unlinkSync(temp)", "remove only this writer's own unrenamed temp file after a failed write"],
    ["src/update/orchestrated-child.mjs:waitForOrchestratedChild:child.kill(signal)", "forward a signal this parent received to its own update child only; the child decides how to stop"],
    ["src/update/orchestrated-arguments.mjs:strictSemver:CORE.exec(value)", "read-only semver regular expression match"],
    ['src/update/orchestrated-node-driver.mjs:<module>:import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";', "pre-mutation private result directory; cleanup reviewed separately"],
    ['src/update/orchestrated-node-driver.mjs:applyNodeOrchestratedUpdate:mkdtempSync(join(tmpdir(), "ocx-update-"))', "pre-mutation private result directory"],
    ['src/update/orchestrated-session.mjs:<module>:import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";', "session marker and result writes reviewed separately"],
  ],
  process: [
    ["src/update/orchestrated-child.mjs:waitForOrchestratedChild:options.signals ?? process", "injectable signal source for forwarding to the exact child; only on/removeListener of SIGINT, SIGTERM, SIGHUP", 1],
    ['src/update/orchestrated-child.mjs:protectOrchestratedWorkerSignals:process.on(signal, () => {})', "pre-mutation signal protection keeps the worker alive", 1],
  ],
  contracts: [
    ["src/update/orchestrated-node-driver.mjs", "applyNodeOrchestratedUpdate", "deps.spawn(process.execPath, args, { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: \"1\" }, stdio: [\"ignore\", 2, 2] })", 1, "ordinary launcher for the orchestrated update child, as job.ts spawnGuiUpdateWorker; the child takes the sync/update mutex, ownership lease, plan-token and attested identity checks and its own home authorization before any mutation"],
    ["src/update/orchestrated-node-driver.mjs", "applyNodeOrchestratedUpdate", "rmSync(directory, { recursive: true, force: true })", 1, "remove only this parent's own mkdtemp result directory before the child starts or after it exits"],
    ["src/update/orchestrated-session.mjs", "atomicJson", "writeFileSync(temp, `${JSON.stringify(value)}\\n`, { encoding: \"utf8\", flag: \"wx\", mode: 0o600 })", 1, "this transaction's own records only: the home's update-orchestrated.json marker, written only while the session holds the sync/update mutex, and result documents (including preflight and refusal outcomes written without the mutex) at the absolute resultPath inside the parent's private mkdtemp directory; exclusive 0600 temp file then rename; no package, runtime or service authority"],
    ["src/update/orchestrated-session.mjs", "atomicJson", "renameSync(temp, path)", 1, "this transaction's own records only: the home's update-orchestrated.json marker, written only while the session holds the sync/update mutex, and result documents (including preflight and refusal outcomes written without the mutex) at the absolute resultPath inside the parent's private mkdtemp directory; exclusive 0600 temp file then rename; no package, runtime or service authority"],
    ["src/update/orchestrated-session.mjs", "atomicJson", "unlinkSync(temp)", 1, "remove only this writer's own unrenamed temp file after a failed write"],
    ["src/update/orchestrated-child.mjs", "waitForOrchestratedChild", "child.kill(signal)", 1, "forward a signal this parent received to its own update child only; the child decides how to stop"],
    ['src/update/orchestrated-node-driver.mjs', 'applyNodeOrchestratedUpdate', 'mkdtempSync(join(tmpdir(), "ocx-update-"))', 1, "pre-mutation private result directory"],
    ['src/update/orchestrated-pnpm.mjs', 'verifyOrchestratedPnpmInstall', 'runPnpm(owner.commandPath, args, capture)', 1, "read-only pnpm owner verification probe"],
    ['src/update/orchestrated-child.mjs', 'protectOrchestratedWorkerSignals', 'process.on(signal, () => {})', 1, "pre-mutation signal protection keeps the worker alive"],
  ],
};
