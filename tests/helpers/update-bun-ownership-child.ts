// Isolated executable fixture: real updater/lease, fake installer and fixed control commands.
import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import * as processTools from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "./repo-root";

const realSpawnSync = processTools.spawnSync;
const realSpawn = processTools.spawn;
const [home, scenario] = process.argv.slice(2) as [string, string];
if (!home || !scenario || process.env.OPENCODEX_HOME !== home) throw new Error("isolated fixture home required");
const authority = join(home, "authority.json");
const runtime = join(home, "runtime-port.json");
const leaseModule = pathToFileURL(repoPath("src/service/ownership-mutation-lease.mjs")).href;
const trace: Array<Record<string, unknown>> = [];
let running = true;
const direct = scenario.startsWith("direct-");
const reserved = direct ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") }) : undefined;
const port = reserved?.port ?? 23456;
let directChild: ReturnType<typeof realSpawn> | undefined;
let clockOffset = 0;
const realNow = Date.now;

writeFileSync(authority, JSON.stringify({ revision: 1, owner: "cli", installId: "owner-a", consentGeneration: 1 }));
const childScript = `
  const { acquireOwnershipMutationLease } = await import(${JSON.stringify(leaseModule)});
  try { const lease = acquireOwnershipMutationLease([process.env.FIXTURE_AUTHORITY], { waitMs: 0 });
    lease.release(); process.exit(0); } catch { process.exit(17); }
`;
function probe(env: NodeJS.ProcessEnv) {
  return realSpawnSync(process.execPath, ["-e", childScript], {
    env: { ...env, FIXTURE_AUTHORITY: authority }, encoding: "utf8", timeout: 5_000,
  }).status;
}
const tokenKey = "OCX_OWNERSHIP_MUTATION_LEASE_TOKEN";
const unprivileged = () => { const env = { ...process.env }; delete env[tokenKey]; return env; };
process.on("exit", () => {
  if (directChild?.pid) { try { process.kill(directChild.pid, "SIGTERM"); } catch { /* already exited */ } }
  reserved?.stop(true);

  trace.push({ phase: "after", childPid: directChild?.pid, reacquired: probe(unprivileged()) === 0, parentToken: !!process.env[tokenKey] });
  process.stdout.write(`UPDATE_LEASE_PROBE:${JSON.stringify(trace)}\n`);
});

const service = await import("../../src/service");
mock.module(repoPath("src/service.ts"), () => ({ ...service,
  serviceStatePaths: () => [authority],
  isServiceInstalled: () => !direct,
  isServiceViable: () => true,
  serviceReinstallArgs: () => ["service", "repair"],
  resolveServiceOwnership: () => {
    const row = JSON.parse(readFileSync(authority, "utf8"));
    return { kind: "owned", revision: row.revision,
      ownership: { owner: row.owner, installId: row.installId, consentGeneration: row.consentGeneration } };
  },
}));
const state = await import("../../src/config/process-state");
mock.module(repoPath("src/config/process-state.ts"), () => ({ ...state,
  readPid: () => running ? 4321 : null,
  readRuntimePort: () => running ? { pid: 4321, port, hostname: "127.0.0.1" } : null,
  getRuntimePortPath: () => runtime,
}));
mock.module(repoPath("src/update/install-detection.mjs"), () => ({ detectInstallFromPath: () => "bun" }));
mock.module(repoPath("src/update/registry-integrity.mjs"), () => ({ checkRegistryPackageIntegrity: () => ({ ok: true, integrity: "sha512-fixture" }) }));
const liveness = await import("../../src/server/proxy-liveness");
const actualIdentity = liveness.proxyIdentityAt;
mock.module(repoPath("src/server/proxy-liveness.ts"), () => ({ ...liveness, proxyIdentityAt: async (targetPort: number, options: { hostname?: string; expectedPid?: number }, io: Parameters<typeof actualIdentity>[2]) => {
  if (!directChild || options.expectedPid === undefined) return running ? { pid: 4321 } : null;
  const result = scenario === "direct-timeout" ? null : await actualIdentity(targetPort, options, io);
  trace.push({ phase: "health", contenderBlocked: probe(unprivileged()) === 17,
    pidBound: options.expectedPid === directChild.pid, healthy: result?.pid === directChild.pid });
  if (scenario === "direct-timeout" || scenario === "direct-foreign") clockOffset += 15_001;
  return result;
} }));
mock.module(repoPath("src/update/proxy-liveness-probe.mjs"), () => ({ probeProxyLiveness: () => running ? "live" : "dead" }));
mock.module("node:child_process", () => ({ ...processTools,
  spawn: (_bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    if (!direct || !args.includes("start")) throw new Error("fixture does not authorize this spawn");
    const env = options.env ?? process.env;
    trace.push({ phase: "direct", contenderBlocked: probe(unprivileged()) === 17,
      delegated: !!env[tokenKey], canJoin: probe(env) === 0 });
    if (scenario === "direct-spawn-error") {
      const emitter = Object.assign(new EventEmitter(), { unref() { return this; } });
      queueMicrotask(() => emitter.emit("error", new Error("injected spawn failure")));
      return emitter;
    }
    const script = `
      const { acquireOwnershipMutationLease } = await import(${JSON.stringify(leaseModule)});
      const { writeFileSync } = await import("node:fs");
      const lease = acquireOwnershipMutationLease([process.env.FIXTURE_AUTHORITY]);
      const server = Bun.serve({hostname:"127.0.0.1",port:Number(process.env.FIXTURE_PORT),fetch:()=>Response.json({service:"opencodex",pid:process.pid+(process.env.FIXTURE_SCENARIO==="direct-foreign"?1:0)})});
      writeFileSync(process.env.FIXTURE_RUNTIME,JSON.stringify({pid:process.pid,port:server.port,hostname:"127.0.0.1"}));
      process.on("SIGTERM",()=>{server.stop(true);lease.release();process.exit(0)});
    `;
    directChild = realSpawn(process.execPath, ["-e", script], { stdio: "ignore",
      env: { ...env, FIXTURE_AUTHORITY: authority, FIXTURE_RUNTIME: runtime, FIXTURE_PORT: String(port), FIXTURE_SCENARIO: scenario } });
    const ready = realSpawnSync(process.execPath, ["-e", `
      const {existsSync}=await import("node:fs");const end=Date.now()+5000;
      while(!existsSync(process.env.FIXTURE_RUNTIME)&&Date.now()<end)await Bun.sleep(10);
      process.exit(existsSync(process.env.FIXTURE_RUNTIME)?0:1);
    `], { env: { ...unprivileged(), FIXTURE_RUNTIME: runtime }, timeout: 6_000 });
    if (ready.status !== 0) throw new Error("fixture recovery child did not become ready");
    Date.now = () => realNow() + clockOffset;
    return directChild;
  },
  spawnSync: (_bin: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    if (args.includes("view")) return { status: 0, stdout: "99.0.0\n", stderr: "" };
    const env = options.env ?? process.env;
    const phase = args.includes("stop") ? "stop" : args.includes("service") ? "recovery"
      : args.some(arg => arg.includes("@bitkyc08/opencodex")) ? "replacement" : "ancillary";
    trace.push({ phase, contenderBlocked: probe(unprivileged()) === 17,
      delegated: !!env[tokenKey], canJoin: probe(env) === 0 });
    if (phase === "stop") {
      running = false;
      reserved?.stop(true);
      if (scenario === "stop-throw") throw new Error("injected stop failure");
      if (scenario === "unknown-runtime") writeFileSync(runtime, "{malformed");
    }
    if (phase === "replacement") {
      if (scenario === "replacement-throw") throw new Error("injected replacement failure");
      if (scenario === "foreign-owner") writeFileSync(authority, JSON.stringify({ revision: 2, owner: "desktop", installId: "owner-b", consentGeneration: 2 }));
      if (direct || scenario === "package-fail" || scenario === "foreign-owner" || scenario === "recovery-throw") return { status: 1 };
    }
    if (phase === "recovery") {
      if (scenario === "recovery-throw") throw new Error("injected recovery failure");
      running = true;
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));
try {
  const { runUpdate } = await import(process.env.FIXTURE_UPDATE_MODULE ?? "../../src/update/index");
  await runUpdate();
} catch {
  trace.push({ phase: "thrown" });
  process.exitCode = 73;
}
