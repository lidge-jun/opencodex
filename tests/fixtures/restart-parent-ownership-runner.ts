/** Real processes, drain, discovery, recovery fence and replacement readiness; no provider startup. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recoverStartJournalAfterOwnerRecheck } from "../../src/cli/start-owner-fence";
import {
  readPidFileValue, readRuntimePort, removePid, removeRuntimePort, writePid, writeRuntimePort,
} from "../../src/config/process-state";
import { acquireOwnershipMutationLease } from "../../src/service/ownership-mutation-lease.mjs";
import { serviceStatePaths } from "../../src/service/state";
import { acceptSystemRestart } from "../../src/server/management/system-restart";
import { drainAndShutdown, setServerRef } from "../../src/server/lifecycle";
import { observeProxyLiveness } from "../../src/server/proxy-liveness";

const home = process.env.OPENCODEX_HOME;
if (!home || !process.env.CODEX_HOME || !process.env.OCX_OWNER_REGISTRY_DIR) throw new Error("isolated homes required");
delete process.env.OCX_SERVICE;
delete process.env.OCX_DESKTOP_SUPERVISED;
const output = (name: string, value: unknown) => writeFileSync(join(home, name + ".json"), JSON.stringify(value));
const parent = process.argv.includes("parent"), probe = process.argv.includes("probe");
const phase = (name: string) => {
  const line = `[restart-fixture ${process.pid} ${Date.now()}] ${name}`;
  appendFileSync(join(home, "fixture-phases.log"), line + "\n");
  console.error(line);
};
phase(parent ? "parent loaded" : probe ? "probe loaded" : "replacement loaded");
// A failed test must never leave a detached fixture running indefinitely.
setTimeout(() => process.exit(97), 20_000).unref();

async function capture(stream: ReadableStream<Uint8Array>, name: string): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const part = decoder.decode(chunk, { stream: true });
    appendFileSync(join(home!, name), part);
    text += part;
  }
  const tail = decoder.decode();
  appendFileSync(join(home!, name), tail);
  return text + tail;
}

async function recover(): Promise<void> {
  phase("acquiring recovery lease");
  const lease = acquireOwnershipMutationLease(serviceStatePaths());
  phase("rechecking owner");
  try { await recoverStartJournalAfterOwnerRecheck({ live: null, pidSnapshot: readPidFileValue() }); }
  finally { lease.release(); }
}

if (probe) {
  const before = readPidFileValue();
  const runtime = readRuntimePort()!;
  const observed = await observeProxyLiveness();
  const endpointsRefused = await Promise.all(["127.0.0.1", "[::1]"].map(async host => {
    try { await fetch(`http://${host}:${runtime.port}/healthz`, { signal: AbortSignal.timeout(1_000) }); return false; }
    catch (error) { return ["ECONNREFUSED", "ConnectionRefused"].includes((error as NodeJS.ErrnoException).code ?? ""); }
  }));
  let refused = false;
  try { await recover(); }
  catch (error) { refused = (error as Error).message.includes("ownership is unverified"); }
  console.log(JSON.stringify({ refused, pidUnchanged: before === readPidFileValue(),
    observed: observed.kind, endpointsRefused }));
  process.exit(refused ? 0 : 2);
}

if (parent) {
  phase("binding parent");
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ service: "opencodex", pid: process.pid }) });
  setServerRef(listener);
  const port = listener.port!;
  writeFileSync(join(home, "config.json"), JSON.stringify({ port, hostname: "127.0.0.1", defaultProvider: "openai", providers: {} }));
  writePid(process.pid); writeRuntimePort({ pid: process.pid, port, hostname: "127.0.0.1" });
  let scheduled!: () => void | Promise<void>;
  let beforeHandoff: unknown;
  process.on("exit", code => {
    const replacement = readRuntimePort();
    // The real CLI exit cleanup uses these same PID guards after readiness.
    removePid(process.pid); removeRuntimePort(process.pid);
    output("parent-result", { code, pid: process.pid, beforeHandoff, replacement,
      successorPid: readPidFileValue(), successorRuntime: readRuntimePort() });
  });
  acceptSystemRestart({
    isDraining: () => false, getActiveTurnCount: () => 0,
    isDesktopSupervised: () => false, isSupervisedServiceChild: () => false,
    schedule: fn => { scheduled = fn; },
    drainAndShutdown: async (server, timeout) => {
      phase("draining parent");
      const completed = await drainAndShutdown(server, timeout);
      phase(`drain completed=${completed}; spawning fence probe`);
      const guard = Bun.spawn([process.execPath, process.argv[1]!, "start", "probe"], {
        env: process.env, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        guard.exited, capture(guard.stdout, "probe.stdout.log"), capture(guard.stderr, "probe.stderr.log"),
      ]);
      phase(`probe exited ${code}: ${stderr}`);
      if (code !== 0) throw new Error("pre-handoff fence did not refuse: " + stderr);
      beforeHandoff = JSON.parse(stdout.trim());
      return completed;
    },
  });
  phase("running scheduled restart");
  await scheduled();
} else {
  const parentPid = process.ppid;
  process.kill(parentPid, 0);
  const parentAliveBeforeRecovery = true;
  phase("observing retired parent");
  const observed = await observeProxyLiveness();
  phase(`observation=${observed.kind}`);
  await recover();
  phase("recovered; binding replacement");
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  const lease = acquireOwnershipMutationLease(serviceStatePaths());
  let listener: ReturnType<typeof Bun.serve>;
  try {
    listener = Bun.serve({ hostname: "127.0.0.1", port,
      fetch: () => Response.json({ service: "opencodex", pid: process.pid }) });
    writePid(process.pid); writeRuntimePort({ pid: process.pid, port, hostname: "127.0.0.1" });
  } finally { lease.release(); }
  phase("replacement bound; waiting for parent exit");
  let parentExited = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(parentPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { parentExited = true; break; } }
    await Bun.sleep(50);
  }
  const parentResultPath = join(home, "parent-result.json");
  const result = { pid: process.pid, parentPid, parentAliveBeforeRecovery,
    observed: observed.kind, parentExited, port,
    parentResult: existsSync(parentResultPath) ? JSON.parse(readFileSync(parentResultPath, "utf8")) : null };
  await listener!.stop(true);
  removePid(process.pid); removeRuntimePort(process.pid);
  output("child-result", result);
  phase("replacement finished");
}
