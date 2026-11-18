import { mock } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Only fixture-owned Bun processes load this file through their private bunfig.
// Keep the published CLI and update worker real; replace only their process view.
if (Bun.isMainThread) {
  const workerModule = await import("../../src/lib/worker-embed");
  const spawnOriginal = workerModule.spawnWorker;
  mock.module(import.meta.resolve("../../src/lib/worker-embed"), () => ({
    ...workerModule,
    spawnWorker: (url: string, key: string) => key === "cli-update-worker"
      ? new Worker(url, { preload: [fileURLToPath(import.meta.url)] })
      : spawnOriginal(url, key),
  }));
} else {
  const processModule = await import("../../src/codex/app-server-processes");
  const scanOriginal = processModule.scanCodexSessionProcesses;
  const scanAsyncOriginal = processModule.scanCodexSessionProcessesAsync;
  let index = 0;
  const snapshots = () => {
    const state = JSON.parse(readFileSync(join(process.cwd(), "process-scan-state.json"), "utf8")) as { scans?: unknown };
    if (!Array.isArray(state.scans) || !state.scans.every(value => ["empty", "active", "unavailable"].includes(value))) {
      throw new Error("invalid fixture process scan state");
    }
    const value = state.scans[index++];
    if (value === undefined) throw new Error("fixture process scan sequence exhausted");
    appendFileSync(join(process.cwd(), "process-scan-trace.jsonl"), JSON.stringify({ value, index }) + "\n");
    if (value === "unavailable") throw new Error("fixture process scan unavailable");
    return value === "active" ? [{ pid: 918273, commandLine: "codex", executable: "codex" }] : [];
  };
  mock.module(import.meta.resolve("../../src/codex/app-server-processes"), () => ({
    ...processModule,
    scanCodexSessionProcesses: (io: Parameters<typeof scanOriginal>[0] = {}) =>
      scanOriginal({ ...io, listSnapshots: snapshots }),
    scanCodexSessionProcessesAsync: (io: Parameters<typeof scanAsyncOriginal>[0] = {}) =>
      scanAsyncOriginal({ ...io, listSnapshotsAsync: async () => snapshots() }),
  }));
}
