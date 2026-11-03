// Best-effort regression lint data, not a security boundary or completeness proof.
// Review rows for the #8103 orchestrated-update modules entry/identity/plan (orchestrated-entry.ts, orchestrated-identity*.ts, orchestrated-live-identity.ts, orchestrated-plan.ts), kept apart from the base
// tables so each group is reviewed on its own. The base tables merge these rows unchanged;
// a file key may appear in only one table. Row classes follow the base tables: read-only,
// pre-mutation, guarded (mutation-guard wrapper or a fresh authorizeMutation), or delegated
// (inside a dedicated child entry; the reason names the guarded spawn its reviewed caller uses and what the child itself enforces).
import type { UpdateReviewTable } from "./update-review-table";

export const orchestratedEntryReview: UpdateReviewTable = {
  staticImports: {
    "src/update/orchestrated-entry.ts": [
      "import { mkdtempSync, readFileSync, realpathSync, rmSync } from \"node:fs\";", // pre-mutation: registry probe cache and its cleanup, plus manifest and canonical path reads
      "import { dirname, join, resolve } from \"node:path\";", // read-only: calculate install and temporary paths
      "import { fileURLToPath } from \"node:url\";", // read-only: resolve this module location
      "import { packageVersion } from \"../lib/package-version\";", // read-only: observe installed version
      "import { getConfigDir } from \"../config/paths\";", // read-only: locate update home
      "import { readConfigDiagnostics } from \"../config\";", // read-only: passive configuration observation
      "import { resolveServiceOwnership } from \"../service/state\";", // read-only: inspect service ownership
      "import { inspectDesktopSupervision, type SupervisionEvidence } from \"../service/desktop-supervision.mjs\";", // read-only: inspect desktop supervision evidence
      "import { diagnoseService } from \"../service/diagnostics\";", // read-only: inspect service installation
      "import { detectInstallOwnership, defaultUpdateTag, latestVersion } from \"./index\";", // pre-mutation: detect installer and probe registry version
      "import { parseOrchestratedUpdateArgs, type OrchestratedUpdateArgs } from \"./orchestrated-arguments.mjs\";", // read-only: parse update request
      "import { buildOrchestratedPlan, type PlanInputs } from \"./orchestrated-plan\";", // read-only: construct plan from observations
      "import { inspectLiveOrchestratedIdentity } from \"./orchestrated-live-identity\";", // read-only: inspect live serving identity
      "import { planUpdateRuntimeHandling } from \"./runtime-ownership.mjs\";", // read-only: classify runtime ownership
      "import { isUpdateInFlight } from \"./sync-update-mutex\";", // read-only: inspect update mutex
      "import { createOrchestratedResultChannel, encodeOrchestratedExpect, type OrchestratedExpect } from \"./orchestrated-session.mjs\";", // encode child expectation; result channel (rows in update-review-orchestrated-child.ts)
      "import { waitForOrchestratedChild } from \"./orchestrated-child.mjs\";", // read-only: observe own update child completion
      "import { classifyOrchestratedOutcome, type Outcome } from \"./orchestrated-outcome.mjs\";", // read-only: classify observed outcome
      "import { verifyOrchestratedInstall } from \"./orchestrated-tree.mjs\";", // read-only: verify installed tree
      "import { decideOrchestratedApply } from \"./orchestrated-admission.mjs\";", // read-only: decide admission from plan
      "import { createUpdatePlanToken } from \"./orchestrated-token.mjs\";", // read-only: bind plan to observed identity
      "import { selfLaunchArgv } from \"../lib/self-launch-argv\";", // read-only: construct self-launch arguments
      "import { proxyIdentityAt } from \"../server/proxy-liveness\";", // read-only: probe proxy health and identity
      "import { probeSpawn, probeSpawnSync } from \"./mutation-guard.mjs\";", // bounded registry probe adapter and the ordinary update-child launcher
      "export { decideOrchestratedApply } from \"./orchestrated-admission.mjs\";", // read-only: decide admission from plan
    ],
    "src/update/orchestrated-identity.ts": [
      "import { dirname, isAbsolute, join } from \"node:path\";", // read-only: validate and resolve serving path
      "import { isValidRuntimePortState, type RuntimePortState } from \"../config/process-state\";", // read-only: validate runtime record shape
      "import { isLocalAttestationSecret } from \"../lib/local-management-attestation\";", // read-only: validate attestation format
    ],
    "src/update/orchestrated-identity-probe-entry.ts": [
      "import { dirname, resolve } from \"node:path\";", // read-only: resolve probe entry location
      "import { fileURLToPath } from \"node:url\";", // read-only: resolve this module location
      "import { inspectNodeOrchestratedIdentity } from \"./orchestrated-entry\";", // read-only: inspect identity for probe response
      "import { proxyIdentityAt } from \"../server/proxy-liveness\";", // read-only: probe proxy health and identity
    ],
    "src/update/orchestrated-live-identity.ts": [
      "import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from \"node:fs\";", // read-only: open and inspect bounded runtime record
      "import { join } from \"node:path\";", // read-only: construct runtime record path
      "import { assertNotRealHomeUnderTest } from \"../lib/test-home-guard\";", // read-only: reject unsafe test home
      "import { probeEndpointLiveness, proveLiveProxyOwnedByHome } from \"../server/proxy-liveness\";", // read-only: probe and attest live endpoint
      "import { processIdentity, procfs, windowsProcessPair } from \"../service/desktop-supervision.mjs\";", // read-only: inspect process executable identity
      "import { inspectOrchestratedServingIdentity } from \"./orchestrated-identity\";", // read-only: compare attested identity observations
    ],
    "src/update/orchestrated-plan.ts": [
      "import { compareStrictSemver, parseStrictSemver } from \"../lib/strict-semver\";", // read-only: compare observed versions
      "import { createUpdatePlanToken } from \"./orchestrated-token.mjs\";", // read-only: bind plan to observed identity
    ],
  },
  deferredImports: [],
  primitive: [
    ["src/update/orchestrated-entry.ts:runOrchestratedUpdate:probeSpawn(exe, args, options)", "ordinary launcher for the orchestrated update child, as job.ts spawnGuiUpdateWorker; the child takes the sync/update mutex, ownership lease, plan-token and attested identity checks and its own home authorization before any mutation"],
    ["src/update/orchestrated-entry.ts:applyOrchestratedBun:deps.spawn(process.execPath, selfLaunchArgv(args), { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: \"1\", OCX_UPDATE_RESULT_CAPABILITY: channel.capability }, stdio: [\"ignore\", 2, 2] })", "ordinary launcher for the orchestrated update child, as job.ts spawnGuiUpdateWorker; the child takes the sync/update mutex, ownership lease, plan-token and attested identity checks and its own home authorization before any mutation"],
    ["src/update/orchestrated-entry.ts:<module>:import { mkdtempSync, readFileSync, realpathSync, rmSync } from \"node:fs\";", "registry probe cache directory and its cleanup, plus manifest and canonical path reads; package mutation remains separately guarded"],
    ["src/update/orchestrated-live-identity.ts:<module>:import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from \"node:fs\";", "read-only runtime record inspection using a bounded descriptor"],
    ["src/update/orchestrated-entry.ts:<module>:probeSpawnSync", "bounded registry version probe passed to latestVersion"],
    ["src/update/orchestrated-identity-probe-entry.ts:<module>:import.meta.main", "direct probe entry detection only"],
    ["src/update/orchestrated-entry.ts:<module>:mkdtempSync(join(tmpdir(), \"ocx-registry-probe-\"))", "exclusive disposable registry probe cache under OS temp"],
    ["src/update/orchestrated-entry.ts:<module>:rmSync(cache, { recursive: true, force: true })", "remove only this registry probe's disposable cache"],
    ["src/update/orchestrated-live-identity.ts:readRuntimeRecord:openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))", "open runtime record read-only with no-follow and verify identity"],
    ["src/update/orchestrated-live-identity.ts:readRuntimeRecord:readSync(fd, bytes, 0, bytes.length, 0)", "bounded read from this runtime record descriptor"],
    ["src/update/orchestrated-live-identity.ts:readRuntimeRecord:closeSync(fd)", "close this runtime record descriptor"],
  ],
  process: [],
  contracts: [
    ["src/update/orchestrated-entry.ts", "runOrchestratedUpdate", "probeSpawn(exe, args, options)", 1, "ordinary launcher for the orchestrated update child, as job.ts spawnGuiUpdateWorker; the child takes the sync/update mutex, ownership lease, plan-token and attested identity checks and its own home authorization before any mutation"],
    ["src/update/orchestrated-entry.ts", "applyOrchestratedBun", "deps.spawn(process.execPath, selfLaunchArgv(args), { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: \"1\", OCX_UPDATE_RESULT_CAPABILITY: channel.capability }, stdio: [\"ignore\", 2, 2] })", 1, "ordinary launcher for the orchestrated update child, as job.ts spawnGuiUpdateWorker; the child takes the sync/update mutex, ownership lease, plan-token and attested identity checks and its own home authorization before any mutation"],
    ["src/update/orchestrated-entry.ts", "<module>", "mkdtempSync(join(tmpdir(), \"ocx-registry-probe-\"))", 1, "exclusive disposable registry probe cache under OS temp"],
    ["src/update/orchestrated-entry.ts", "<module>", "rmSync(cache, { recursive: true, force: true })", 1, "remove only this registry probe's disposable cache"],
    ["src/update/orchestrated-live-identity.ts", "readRuntimeRecord", "openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))", 1, "open runtime record read-only with no-follow and verify identity"],
    ["src/update/orchestrated-live-identity.ts", "readRuntimeRecord", "readSync(fd, bytes, 0, bytes.length, 0)", 1, "bounded read from this runtime record descriptor"],
    ["src/update/orchestrated-live-identity.ts", "readRuntimeRecord", "closeSync(fd)", 1, "close this runtime record descriptor"],
  ],
};
