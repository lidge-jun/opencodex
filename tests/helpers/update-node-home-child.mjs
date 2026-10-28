import { guardedUpdateIo } from "./update-guarded-io.mjs";
// Execute the entire production Node update function in a real Node child. Only I/O
// boundaries are replaced: an unexpected command throws instead of reaching the host.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createUpdateServiceHomePolicy, parseUpdateWorkerHome, UPDATE_PACKAGE_ONLY_EXIT_CODE } from "../../src/update/service-home-policy.mjs";
import { inspectPackageRuntimeLiveness, planUpdateRuntimeHandling } from "../../src/update/runtime-ownership.mjs";
import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "../../src/update/tray-update-plan.mjs";
import { manualUpdateFailureGuidance, npmUpdateFailureGuidance } from "../../src/update/update-failure-guidance.mjs";

const [home, observed, ...argv] = process.argv.slice(2);
if (!home || process.env.OPENCODEX_HOME !== home) throw new Error("isolated fixture home required");
const launcher = fileURLToPath(new URL("../../bin/ocx.mjs", import.meta.url));
const source = readFileSync(launcher, "utf8");
const from = source.indexOf("async function runPackageManagerSelfUpdate(manager) {");
const to = source.indexOf("function bunBinDir(", from);
if (from < 0 || to < from) throw new Error("production function boundary missing");
const body = source.slice(from, to).replaceAll("import.meta.url", JSON.stringify(new URL("../../bin/ocx.mjs", import.meta.url).href));
const trace = [];
const postRefusal = observed.startsWith("post-refusal-");
const trayInitiallyRunning = postRefusal && observed !== "post-refusal-stopped";
let trayRunning = trayInitiallyRunning;
let packageReplaced = false;
process.on("exit", () => process.stdout.write(`NODE_HOME_PROBE:${JSON.stringify(trace)}\n`));
const dependencies = {
  process: { argv: [process.execPath, launcher, "update", ...argv], env: process.env, execPath: process.execPath, platform: process.platform, exit: code => process.exit(code) },
  console, PKG: "@bitkyc08/opencodex", here: dirname(launcher), dirname, join, resolve, fileURLToPath,
  currentPackageVersion: () => "1.0.0", updateTag: () => "latest",
  npmInvocation: args => ({ file: "fixture-npm", args }),
  spawnSync: (_bin, args) => {
    if (args[0] === "view") return { status: 0, stdout: "99.0.0\n" };
    throw new Error(`unexpected control command: ${JSON.stringify(args)}`);
  },
  checkRegistryPackageIntegrity: () => ({ ok: true, integrity: "sha512-fixture" }),
  resolveNpmCachePath: () => ({ ok: true, path: home }), runNpmCachePreflight: () => ({ ok: true }),
  unprivilegedOwnershipMutationEnvironment: env => env,
  serviceStateFilesFor: () => [join(home, "service-state.json")], configDir: () => home, homedir: () => home,
  createUpdateServiceHomePolicy, parseUpdateWorkerHome, UPDATE_PACKAGE_ONLY_EXIT_CODE,
  readNodeUpdateHome: () => { trace.push("home"); return { kind: postRefusal ? packageReplaced ? "unknown" : "absent" : observed }; },
  existsSync, readFileSync, readdirSync,
  selectAuthoritativeServiceState: () => ({ kind: "none", revision: 0 }), inspectInstallStateBytes: () => ({ kind: "absent" }),
  createSupervisionLatch: () => ({ observe: () => false }), inspectDesktopSupervision: () => false,
  planUpdateRuntimeHandling, inspectPackageRuntimeLiveness, handoffWindowsTrayForUpdate,
  planWindowsTrayUpdate: status => planWindowsTrayUpdate(postRefusal ? { installed: true, running: trayInitiallyRunning } : status),
  trayInstallState: () => ({ installed: postRefusal, running: trayRunning }),
  runTrayLifecycle: (_launcher, action) => { trace.push(`tray:${action}`); trayRunning = action === "start"; return { status: 0 }; },
  probeProxyLiveness: () => "dead", hasPendingTeardownIn: () => false,
  acquireOwnershipMutationLease: () => ({ token: "fixture", release: () => trace.push("release") }),
  delegatedOwnershipMutationToken: null,
  // The launcher imports the synchronous transaction as transactionalNpmUpdateSync.
  transactionalNpmUpdateSync: () => { trace.push("replacement"); packageReplaced = true; return { ok: true }; },
  transactionalNpmUpdateAsync: async () => { trace.push("replacement"); packageReplaced = true; return { ok: true }; },
  manualUpdateFailureGuidance, npmUpdateFailureGuidance,
  launcherUsableAfterNpmUpdate: () => observed !== "post-refusal-unverified",
  launcherStartHint: () => "fixture manual start",
};
// Sloppy function scope supplies the production module's bindings without rewriting
// its policy calls, branches, replacement gate, or terminal result.
await new Function("deps", `with (deps) { ${body}; return runPackageManagerSelfUpdate("npm"); }`)({ ...dependencies, ...guardedUpdateIo(dependencies) });
