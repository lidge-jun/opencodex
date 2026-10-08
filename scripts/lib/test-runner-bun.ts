import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { testRunnerBun } from "../../package.json";

export interface TestRunnerBunDeps {
  pin: string;
  currentVersion: string;
  execPath: string;
  env: Readonly<Record<string, string | undefined>>;
  pathEntries: readonly string[];
  homeDir: string;
  platform: NodeJS.Platform;
  probeVersion: (binary: string) => string | undefined;
}

/** Select the test pin without executing the bundled runtime or installing anything. */
export function resolveTestRunnerBun(deps: TestRunnerBunDeps): string {
  const { pin, currentVersion, execPath, env, probeVersion } = deps;
  if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error("package.json testRunnerBun must be an exact Bun version.");
  if (currentVersion === pin) return execPath;
  const path = deps.platform === "win32" ? win32 : posix;
  const probe = (binary: string) => {
    try { return probeVersion(binary)?.trim(); } catch { return undefined; }
  };
  const guidance = `Running Bun ${currentVersion}; tests require Bun ${pin} (package.json testRunnerBun). `
    + "The bundled runtime can crash in multi-file bun test --isolate; see "
    + "https://github.com/lidge-jun/opencodex/pull/6713 and https://github.com/lidge-jun/opencodex/pull/4821. "
    + `Install Bun ${pin} (curl -fsSL https://bun.sh/install | bash -s "bun-v${pin}") `
    + `or point OCX_TEST_RUNNER_BUN at a Bun ${pin} binary. No download was attempted.`;
  if (env.OCX_TEST_RUNNER_BUN !== undefined) {
    const override = path.resolve(env.OCX_TEST_RUNNER_BUN);
    const version = env.OCX_TEST_RUNNER_BUN ? probe(override) : undefined;
    if (version === pin) return override;
    throw new Error(`OCX_TEST_RUNNER_BUN reports ${version ?? "no usable version"}. ${guidance}`);
  }
  const seen = new Set<string>();
  for (const entry of [...deps.pathEntries, path.join(deps.homeDir, ".bun", "bin")]) {
    if (!entry) continue;
    const directory = path.resolve(entry.replace(/^"(.*)"$/, "$1"));
    if (directory.split(/[\\/]/).some(segment => segment.toLowerCase() === "node_modules")) continue;
    const binary = path.join(directory, deps.platform === "win32" ? "bun.exe" : "bun");
    const key = deps.platform === "win32" ? binary.toLowerCase() : binary;
    if (seen.has(key)) continue;
    seen.add(key);
    if (probe(binary) === pin) return binary;
  }
  throw new Error(`No matching test runner found outside node_modules on PATH or in ~/.bun/bin. ${guidance}`);
}

/** Resolve before test HOME isolation, using the repository pin rather than the caller's cwd. */
export function getTestRunnerBun(): string {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path");
  const binary = resolveTestRunnerBun({
    pin: testRunnerBun,
    currentVersion: Bun.version,
    execPath: process.execPath,
    env: process.env,
    pathEntries: (process.env[pathKey ?? "PATH"] ?? "").split(process.platform === "win32" ? ";" : ":"),
    homeDir: homedir(),
    platform: process.platform,
    probeVersion: candidate => execFileSync(candidate, ["--version"], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }),
  });
  if (binary !== process.execPath) console.log(`test runner: Bun ${testRunnerBun} (${binary})`);
  return binary;
}
