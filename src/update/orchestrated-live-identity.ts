import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { probeEndpointLiveness, proveLiveProxyOwnedByHome } from "../server/proxy-liveness";
import { processIdentity, procfs, windowsProcessPair } from "../service/desktop-supervision.mjs";
import { inspectOrchestratedServingIdentity } from "./orchestrated-identity";

function readRuntimeRecord(home: string): { kind: "record"; raw: string } | { kind: "missing" } | { kind: "unreadable" } {
  const path = join(home, "runtime-port.json");
  let observed = false, fd: number | undefined;
  try {
    const before = lstatSync(path);
    observed = true;
    if (!before.isFile() || before.size > 32_768) return { kind: "unreadable" };
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return { kind: "unreadable" };
    const bytes = Buffer.alloc(32_769);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== opened.size || count > 32_768) return { kind: "unreadable" };
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return { kind: "unreadable" };
    return { kind: "record", raw: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)) };
  } catch (error) {
    return !observed && (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Read the specified home only; listener possession of its record key proves a live identity. */
export async function inspectLiveOrchestratedIdentity(home: string, configured: { port: number; hostname?: string }) {
  assertNotRealHomeUnderTest(home);
  return inspectOrchestratedServingIdentity({
    readRecord: () => readRuntimeRecord(home),
    realpath: path => realpathSync.native(path),
    probeConfigured: () => probeEndpointLiveness(configured),
    prove: record => proveLiveProxyOwnedByHome({ pid: record.pid, port: record.port, hostname: record.hostname, source: "runtime" }, { readRuntimeFn: () => record }),
    legacyExecutableDiffers: async pid => {
      try {
        const executable = process.platform === "linux" ? procfs.exe(pid)
          : process.platform === "darwin" ? processIdentity(pid)?.executable
          : process.platform === "win32" ? windowsProcessPair(pid).child?.exe : undefined;
        if (!executable) return false;
        const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
        return key(realpathSync.native(executable)) !== key(realpathSync.native(process.execPath));
      } catch { return false; }
    },
  });
}
