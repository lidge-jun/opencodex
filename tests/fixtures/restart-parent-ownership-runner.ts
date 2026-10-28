/** Real processes, drain, discovery, recovery fence and replacement readiness; no provider startup. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
// A failed test must never leave a detached fixture running indefinitely.
setTimeout(() => process.exit(97), 20_000).unref();

async function recover(): Promise<void> {
  const lease = acquireOwnershipMutationLease(serviceStatePaths());
  try { await recoverStartJournalAfterOwnerRecheck({ live: null, pidSnapshot: readPidFileValue() }); }
  finally { lease.release(); }
}

if (probe) {
  const before = readPidFileValue();
  let refused = false;
  try { await recover(); }
  catch (error) { refused = (error as Error).message.includes("ownership is unverified"); }
  console.log(JSON.stringify({ refused, pidUnchanged: before === readPidFileValue() }));
  process.exit(refused ? 0 : 2);
}

if (parent) {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ service: "opencodex", pid: process.pid }) });
  setServerRef(listener);
  const port = listener.port!;
  writeFileSync(join(home, "config.json"), JSON.stringify({ port, hostname: "127.0.0.1", providers: {} }));
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
      const completed = await drainAndShutdown(server, timeout);
      const guard = Bun.spawn([process.execPath, process.argv[1]!, "start", "probe"], {
        env: process.env, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        guard.exited, new Response(guard.stdout).text(), new Response(guard.stderr).text(),
      ]);
      if (code !== 0) throw new Error("pre-handoff fence did not refuse: " + stderr);
      beforeHandoff = JSON.parse(stdout.trim());
      return completed;
    },
  });
  await scheduled();
} else {
  const parentPid = process.ppid;
  process.kill(parentPid, 0);
  const parentAliveBeforeRecovery = true;
  const observed = await observeProxyLiveness();
  await recover();
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  const lease = acquireOwnershipMutationLease(serviceStatePaths());
  let listener: ReturnType<typeof Bun.serve>;
  try {
    listener = Bun.serve({ hostname: "127.0.0.1", port,
      fetch: () => Response.json({ service: "opencodex", pid: process.pid }) });
    writePid(process.pid); writeRuntimePort({ pid: process.pid, port, hostname: "127.0.0.1" });
  } finally { lease.release(); }
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
}
