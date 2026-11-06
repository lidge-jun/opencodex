import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createNpmConfigIsolation, isolatedNpmTarget } from "../../src/codex/cli-update-plan";
import { fixtureArtifact, fixtureArtifactSet } from "./codex-cli-apply-artifact";
import type { CodexCliApplyResult } from "../../src/codex/cli-update-apply";

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
  const result = spawnSync(target.bin, target.args, { ...target.options, encoding: "utf8", timeout: 60_000,
    env: { ...isolation.env, HOME: root, TMPDIR: root } });
  if (result.error || result.status !== 0) throw new Error(`private npm failed: ${result.status} ${result.error?.message ?? ""}\n${result.stderr}`);
  return result;
}
/** The same synthetic npm entrypoint used by the published-launcher fixture. */
export function writeFixtureNpmWrapper(fakeBin: string, node: string, realNpm: string,
  metadata: Record<string, unknown>, packs: Record<string, string>, trace: string): void {
  // An extensionless Node entrypoint inherits its nearest package's module type.
  // HTTP fixtures live under this ESM repository; keep only this synthetic bin
  // CommonJS without changing either installed package's original manifest.
  writeFileSync(join(fakeBin, "package.json"), JSON.stringify({ private: true, type: "commonjs" }) + "\n");
  const wrapper = [
    `#!${node}`, 'const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");',
    `const metadata = ${JSON.stringify(metadata)}, packs = ${JSON.stringify(packs)};`,
    'const args = process.argv.slice(2);',
    'if (args[0] === "view") { if (!metadata[args[1]]) process.exit(81); console.log(JSON.stringify(metadata[args[1]])); process.exit(0); }',
    'if (args[0] === "pack") { const source = packs[args[1]]; if (!source) process.exit(82); const dir = args[args.indexOf("--pack-destination") + 1]; const name = path.basename(source); fs.copyFileSync(source, path.join(dir, name)); console.log(JSON.stringify([{filename:name}])); process.exit(0); }',
    `if (args[0] !== "install") process.exit(83); fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");`,
    `const installed = cp.spawnSync(${JSON.stringify(node)}, [${JSON.stringify(realNpm)}, ...args], {env:process.env, stdio:"inherit"}); process.exit(installed.status ?? 84);`,
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
    const pack = (source: string) => {
      const info = JSON.parse(privateNpm(root, ["pack", source, "--json", "--pack-destination", source]).stdout);
      const path = join(source, info[0].filename);
      return { path, bytes: readFileSync(path) };
    };
    const main = pack(mainSource), backing = pack(backingSource);
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
  const node = Bun.which("node"), npm = Bun.which("npm");
  if (!node || !npm) throw new Error("fixture toolchain unavailable");
  const realNpm = realpathSync.native(npm);
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
    writeFixtureNpmWrapper(fakeBin, node, realNpm, metadata, packs, trace);
  }
  const launcher = process.platform === "win32" ? join(prefix, "codex.cmd") : join(prefix, "bin", "codex");
  const env = { ...process.env, HOME: home, TMPDIR: temporaryRoot, OPENCODEX_HOME: join(home, "ocx"),
    PATH: [fakeBin, join(prefix, "bin"), dirname(node), process.env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":"),
    CODEX_CLI_PATH: launcher, OCX_NO_DESKTOP_HANDOFF: "1", OPENCODEX_BUN_PATH: process.execPath };
  return { root, prefix, home, temporaryRoot, launcher, env, trace, old, target, privateNpm: (args: string[]) => privateNpm(root, args) };
}
