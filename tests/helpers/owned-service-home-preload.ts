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
    const first = typeof args[0] === "string" ? args[0].toLowerCase() : "";
    const secondArg = typeof args[1] === "string" ? args[1].toLowerCase() : "";
    const isSchedulerQuery = name === "schtasks.exe" && first === "/query";
    const isNativeServiceQuery = name === "sc.exe"
      && first === "query"
      && secondArg === "opencodex-proxy-native";

    if (!isSchedulerQuery && !isNativeServiceQuery) return realSpawnSync(...input);

    const raw = typeof options === "object"
      && options !== null
      && "encoding" in options
      && options.encoding === "buffer";
    const message = isNativeServiceQuery
      ? "[SC] OpenService FAILED 1060: The specified service does not exist."
      : "ERROR: The system cannot find the file specified.";
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
