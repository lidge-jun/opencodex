/**
 * Test-only Windows service-manager observation seam.
 *
 * The real admission path must keep asking the trusted System32 binaries. A
 * child launched by `claimOwnedServiceHome` gets this preload explicitly, and
 * only then are the read-only `/query` calls answered as an absent manager.
 * No production module reads this flag or imports this file; all CLI/HTTP and
 * admission code after the probe remains the real implementation.
 */
import { mock } from "bun:test";
import childProcess from "node:child_process";

const ENABLED = process.platform === "win32" && process.env.OCX_TEST_SERVICE_HOME_PROBE === "1";

if (ENABLED) {
  const realSpawnSync = childProcess.spawnSync;

  const fakeSpawnSync = ((...input: Parameters<typeof realSpawnSync>) => {
    const [file, second, third] = input;
    const args = Array.isArray(second) ? second : [];
    const options = Array.isArray(second) ? third : second;
    const name = typeof file === "string"
      ? file.replaceAll("\\", "/").split("/").pop()?.toLowerCase()
      : undefined;
    // Keep this seam to the exact read-only argv emitted by production. A
    // foreign task, a listing/error query, or extra arguments must reach the
    // real manager instead of being silently declared absent.
    const isSchedulerQuery = name === "schtasks.exe"
      && args.length === 4
      && args[0] === "/query"
      && args[1] === "/tn"
      && args[2] === "opencodex-proxy"
      && args[3] === "/xml";
    const isNativeServiceQuery = name === "sc.exe"
      && args.length === 2
      && args[0] === "query"
      && args[1] === "opencodex-proxy-native";

    if (!isSchedulerQuery && !isNativeServiceQuery) return realSpawnSync(...input);

    const raw = typeof options === "object"
      && options !== null
      && "encoding" in options
      && options.encoding === "buffer";
    const message = isNativeServiceQuery
      ? "[OCX_TEST_SERVICE_HOME] [SC] OpenService FAILED 1060: The specified service does not exist."
      : "[OCX_TEST_SERVICE_HOME] ERROR: The system cannot find the file specified.";
    const stdout = raw ? Buffer.alloc(0) : "";
    const stderr = raw ? Buffer.from(message, "utf8") : message;
    return {
      status: 1,
      signal: null,
      output: [null, stdout, stderr],
      pid: undefined,
      error: undefined,
      stdout,
      stderr,
    } as ReturnType<typeof realSpawnSync>;
  }) as typeof realSpawnSync;

  // Bun's ESM namespace binding for `node:child_process` is immutable, while
  // `mock.module` replaces the module before production imports its named
  // `spawnSync` binding. Preserve every other child_process API verbatim.
  mock.module("node:child_process", () => ({ ...childProcess, spawnSync: fakeSpawnSync }));
}
