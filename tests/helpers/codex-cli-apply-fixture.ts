import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createNpmConfigIsolation, isolatedNpmTarget } from "../../src/codex/cli-update-plan";
import { fixtureArtifact, fixtureArtifactSet } from "./codex-cli-apply-artifact";
import type { CodexCliApplyResult } from "../../src/codex/cli-update-apply";
import { helperPath } from "./repo-root";

let fixtureNode: string | undefined;
export function resolveCodexCliFixtureNode(): string {
  if (fixtureNode) return fixtureNode;
  const firstOnPath = Bun.which("node");
  if (!firstOnPath) throw new Error("fixture Node executable unavailable");
  if (process.platform === "win32") return firstOnPath;
  // Prefer an installed Node over dispatchers such as Vite+'s node -> vp. Those
  // shims can change PATH before ocx captures it or stall on an empty HOME.
  const launcher = (process.env.PATH ?? "").split(":").filter(isAbsolute)
    .map(dir => Bun.which("node", { PATH: dir }))
    .find(candidate => candidate && ["node", "nodejs"].includes(basename(realpathSync.native(candidate))))
    ?? firstOnPath;
  const probe = spawnSync(launcher, ["-p", "process.execPath"], {
    encoding: "utf8", timeout: 10_000,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, VOLTA_HOME: process.env.VOLTA_HOME },
  });
  const path = probe.stdout?.trim();
  if (probe.status !== 0 || !path || !isAbsolute(path)) throw new Error("fixture Node runtime unavailable");
  return fixtureNode = realpathSync.native(path);
}

function resolveFixtureNpm(node: string): string {
  const npm = Bun.which("npm", { PATH: dirname(node) }) ?? Bun.which("npm");
  if (!npm) throw new Error("fixture npm executable unavailable");
  return npm;
}

/** Admission waits must also observe an early refusal/rejection. Otherwise a
 * diagnostic failure before install/fetch entry becomes a misleading timeout.
 */
export async function waitForApplyAdmission(admitted: Promise<void>, running: Promise<CodexCliApplyResult>): Promise<void> {
  const first = await Promise.race([
    admitted.then(() => ({ kind: "admitted" as const })),
    running.then(result => ({ kind: "early" as const, result }), error => ({ kind: "rejected" as const, code: error?.code ?? error?.name ?? "unknown" })),
  ]);
  if (first.kind === "early") throw new Error(`apply ended before admission: outcome=${first.result.outcome} reason=${first.result.reason} installerExitCode=${first.result.installerExitCode}`);
  if (first.kind === "rejected") throw new Error(`apply rejected before admission: ${first.code}`);
}

/** All npm config/cache/prefix/temp effects belong to root; no network or scripts. */
export function privateNpm(root: string, args: string[]) {
  // Each command starts with a new empty cache, not the previous pack/install's.
  const work = mkdtempSync(join(root, "npm-work-"));
  const isolation = createNpmConfigIsolation(work);
  const target = isolatedNpmTarget([...args, "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--omit=optional"], isolation);
  if (!target) throw new Error("real npm unavailable");
  const posix = process.platform !== "win32";
  const node = posix ? resolveCodexCliFixtureNode() : undefined;
  const bin = node ? resolveFixtureNpm(node) : target.bin;
  // npm's env shebang needs the selected runtime under the name "node".
  if (node) symlinkSync(node, join(work, "node"));
  const env = node
    ? { PATH: [work, dirname(node), "/usr/bin", "/bin"].join(":"), NODE_COMPILE_CACHE: isolation.env.NODE_COMPILE_CACHE }
    : isolation.env;
  // npm config and package caches stay fresh per command; only compiled Node
  // code is reused inside this owned fixture, as it is by the launcher below.
  const result = spawnSync(bin, target.args, { ...target.options, encoding: "utf8", timeout: 60_000,
    env: { ...env, HOME: root, TMPDIR: root, NODE_COMPILE_CACHE: join(root, "node-compile-cache") } });
  if (result.error || result.status !== 0) throw new Error(`private npm failed: ${result.status} ${result.error?.message ?? ""}\n${result.stderr}`);
  return result;
}
/** The same synthetic npm entrypoint used by the published-launcher fixture. */
export function writeFixtureNpmWrapper(fakeBin: string, npm: string,
  metadata: Record<string, unknown>, packs: Record<string, string>, trace: string): void {
  // An extensionless Node entrypoint inherits its nearest package's module type.
  // HTTP fixtures live under this ESM repository; keep only this synthetic bin
  // CommonJS without changing either installed package's original manifest.
  writeFileSync(join(fakeBin, "package.json"), JSON.stringify({ private: true, type: "commonjs" }) + "\n");
  const wrapper = [
    "#!/usr/bin/env node", 'const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");',
    `const metadata = ${JSON.stringify(metadata)}, packs = ${JSON.stringify(packs)};`,
    'const args = process.argv.slice(2);',
    'if (args[0] === "view") { if (!metadata[args[1]]) process.exit(81); console.log(JSON.stringify(metadata[args[1]])); process.exit(0); }',
    'if (args[0] === "pack") { const source = packs[args[1]]; if (!source) process.exit(82); const dir = args[args.indexOf("--pack-destination") + 1]; const name = path.basename(source); fs.copyFileSync(source, path.join(dir, name)); console.log(JSON.stringify([{filename:name}])); process.exit(0); }',
    `if (args[0] !== "install") process.exit(83); fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");`,
    `const installed = cp.spawnSync(${JSON.stringify(npm)}, args, {env:process.env, stdio:"inherit"}); process.exit(installed.status ?? 84);`,
  ].join("\n") + "\n";
  writeFileSync(join(fakeBin, "npm"), wrapper); chmodSync(join(fakeBin, "npm"), 0o755);
}
/** Tiny synthetic packages are packed by real npm; metadata and pack bytes are
 * substituted by an owned npm wrapper, while install delegates to real npm.
 * This exercises published Node -> Bun CLI -> resolver/provenance -> plan/apply.
 */
export function createCodexCliApplyFixture(root: string, platform: NodeJS.Platform = process.platform, arch = process.arch, targetNativeSource?: string) {
  root = realpathSync.native(root);
  const prefix = join(root, "prefix"), home = join(root, "home"), temporaryRoot = join(root, "tmp"), fakeBin = join(root, "bin");
  for (const dir of [prefix, home, temporaryRoot, fakeBin]) mkdirSync(dir, { recursive: true });
  const versions = ["1.0.0", "1.1.0"].map(version => {
    const fixture = fixtureArtifactSet(platform, arch, version);
    if (version === "1.1.0" && targetNativeSource !== undefined) {
      fixture.backingFiles[Object.keys(fixture.backingFiles).find(path => path.endsWith("/bin/codex"))!] = targetNativeSource;
    }
    // An auxiliary native member makes partial readback independently observable.
    fixture.backingFiles["vendor/auxiliary.txt"] = `synthetic auxiliary ${version}\n`;
    const mainSource = join(root, `main-${version}`), backingSource = join(root, `backing-${version}`);
    for (const [source, files] of [[mainSource, fixture.mainFiles], [backingSource, fixture.backingFiles]] as const) {
      for (const [name, bytes] of Object.entries(files)) {
        mkdirSync(dirname(join(source, name)), { recursive: true });
        writeFileSync(join(source, name), bytes);
        if (name !== "package.json") chmodSync(join(source, name), 0o755);
      }
    }
    // Pack both real local packages in one process, with a fresh npm cache
    // for each version. The archives still come from npm, not synthetic tar.
    const packed = JSON.parse(privateNpm(root, ["pack", mainSource, backingSource,
      "--json", "--pack-destination", root]).stdout);
    if (!Array.isArray(packed) || packed.length !== 2) throw new Error("fixture npm pack did not return both packages");
    const archive = (index: number) => {
      const path = join(root, packed[index].filename);
      return { path, bytes: readFileSync(path) };
    };
    const main = archive(0), backing = archive(1);
    const artifacts = { ...fixture.artifacts, main: fixtureArtifact(main.bytes, version),
      backing: fixtureArtifact(backing.bytes, fixture.artifacts.backing.version, fixture.artifacts.backing.installName) };
    return { artifacts, main, backing, mainManifest: fixture.mainManifest };
  });
  const old = versions[0]!, target = versions[1]!;
  const installArgs = (v: typeof old) => ["install", "-g", "--prefix", prefix, "--package-lock=false",
    `${v.artifacts.main.installName}@file:${v.main.path}`, `${v.artifacts.backing.installName}@file:${v.backing.path}`];
  privateNpm(root, installArgs(old));
  const trace = join(root, "install-trace.jsonl");
  writeFileSync(trace, "");
  const node = resolveCodexCliFixtureNode();
  const metadata = Object.fromEntries([old, target].flatMap(v => [
    ["@openai/codex@" + v.artifacts.main.version, { ...v.mainManifest, dist: { integrity: v.artifacts.main.integrity, tarball: v.artifacts.main.tarball } }],
    ["@openai/codex@" + v.artifacts.backing.version, { name: v.artifacts.backing.name, version: v.artifacts.backing.version,
      dist: { integrity: v.artifacts.backing.integrity, tarball: v.artifacts.backing.tarball } }],
  ]));
  metadata["@openai/codex@latest"] = metadata["@openai/codex@1.1.0"];
  const packs = Object.fromEntries([old, target].flatMap(v => [
    ["@openai/codex@" + v.artifacts.main.version, v.main.path], ["@openai/codex@" + v.artifacts.backing.version, v.backing.path],
  ]));
  if (process.platform !== "win32") {
    symlinkSync(node, join(fakeBin, "node"));
    writeFixtureNpmWrapper(fakeBin, resolveFixtureNpm(node), metadata, packs, trace);
    // A private cwd makes this preload local to the published-launcher fixtures.
    writeFileSync(join(root, "bunfig.toml"), `preload = [${JSON.stringify(helperPath("codex-cli-process-scan-preload.ts"))}]\n`);
    writeFileSync(join(root, "process-scan-state.json"), JSON.stringify({ scans: ["empty", "empty", "empty"] }));
  }
  const launcher = process.platform === "win32" ? join(prefix, "codex.cmd") : join(prefix, "bin", "codex");
  const path = process.platform === "win32"
    ? [fakeBin, join(prefix, "bin"), dirname(node), process.env.PATH ?? ""].join(";")
    : [fakeBin, join(prefix, "bin")].join(":");
  const env: NodeJS.ProcessEnv = {
    ...(process.platform === "win32" ? process.env : {}),
    HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), OPENCODEX_HOME: join(home, "ocx"),
    TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot, PATH: path,
    CODEX_CLI_PATH: launcher, OCX_NO_DESKTOP_HANDOFF: "1", OPENCODEX_BUN_PATH: process.execPath,
    OCX_TEST_HOME_GUARD: process.env.OCX_TEST_HOME_GUARD, OCX_REAL_HOME: process.env.OCX_REAL_HOME,
    NODE_COMPILE_CACHE: join(root, "node-compile-cache"),
  };
  return { root, prefix, home, temporaryRoot, launcher, node, env, trace, old, target, privateNpm: (args: string[]) => privateNpm(root, args) };
}
