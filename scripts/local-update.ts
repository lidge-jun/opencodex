#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PACKAGE = "@bitkyc08/opencodex";
const LOCAL_BRANCH = "local/stable";
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const ocxHome = resolve(process.env.OPENCODEX_HOME?.trim() || join(homedir(), ".opencodex"));
const buildsDir = join(ocxHome, "local-builds");
const npmBin = process.env.OCX_NPM_BIN?.trim()
  || (existsSync("/usr/local/bin/npm") ? "/usr/local/bin/npm" : "npm");
const ocxBin = process.env.OCX_BIN?.trim()
  || (existsSync("/usr/local/bin/ocx") ? "/usr/local/bin/ocx" : "ocx");
const bunBin = process.execPath;

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function command(bin: string, args: string[], options: { cwd?: string; inherit?: boolean; allowFailure?: boolean } = {}): CommandResult {
  const result = spawnSync(bin, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.status !== 0 && !options.allowFailure) {
    const detail = stderr.trim() || stdout.trim() || `exit ${result.status ?? "unknown"}`;
    throw new Error(`${bin} ${args.join(" ")} failed: ${detail}`);
  }
  return { status: result.status, stdout, stderr };
}

function output(bin: string, args: string[], cwd = root): string {
  return command(bin, args, { cwd }).stdout.trim();
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function packageVersion(path = join(root, "package.json")): string {
  return String((JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version ?? "unknown");
}

function requestedVersion(): string | null {
  const raw = process.argv.slice(2).find(arg => !arg.startsWith("-"));
  if (!raw) return null;
  const version = raw.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid version: ${raw}`);
  }
  return version;
}

function assertLocalRepository(): void {
  if (output("git", ["rev-parse", "--show-toplevel"]) !== root) {
    throw new Error(`Run from the permanent local clone: ${root}`);
  }
  const branch = output("git", ["branch", "--show-current"]);
  if (branch !== LOCAL_BRANCH) {
    throw new Error(`Expected branch ${LOCAL_BRANCH}, found ${branch || "detached HEAD"}`);
  }
  const dirty = output("git", ["status", "--porcelain"]);
  if (dirty) throw new Error(`Worktree is not clean:\n${dirty}`);
}

function resolveLatestVersion(): string {
  const requested = requestedVersion();
  if (requested) return requested;
  const latest = output(npmBin, ["view", `${PACKAGE}@latest`, "version"]);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) {
    throw new Error(`Registry returned an invalid version: ${latest || "empty"}`);
  }
  return latest;
}

function mergeLatest(version: string): void {
  console.log(`\n[1/5] Fetching upstream v${version}`);
  command("git", ["fetch", "upstream", "--tags", "--prune"], { inherit: true });
  const tag = `v${version}`;
  command("git", ["rev-parse", "--verify", `${tag}^{commit}`]);
  const contains = command("git", ["merge-base", "--is-ancestor", tag, "HEAD"], { allowFailure: true }).status === 0;
  if (contains) {
    console.log(`${LOCAL_BRANCH} already contains ${tag}.`);
    return;
  }
  const backupTag = `local-backup/pre-${version}-${timestamp()}`;
  command("git", ["tag", "-a", backupTag, "-m", `Local state before merging ${tag}`]);
  console.log(`Created ${backupTag}.`);
  const merge = command("git", ["merge", "--no-ff", tag, "-m", `merge: upstream ${tag} into local stable`], {
    inherit: true,
    allowFailure: true,
  });
  if (merge.status !== 0) {
    throw new Error(
      "Upstream merge has conflicts. The installed proxy was not touched. "
      + "Resolve the Git conflicts, commit the merge, then rerun bun run local:update.",
    );
  }
}

function verifySource(): void {
  console.log("\n[2/5] Verifying merged source");
  command(bunBin, ["install", "--frozen-lockfile"], { inherit: true });
  command(bunBin, ["install", "--frozen-lockfile"], { cwd: join(root, "gui"), inherit: true });
  command(bunBin, ["run", "typecheck"], { inherit: true });
  command(bunBin, ["run", "lint:gui"], { inherit: true });
  command(bunBin, ["run", "test"], { inherit: true });
  command(bunBin, ["run", "privacy:scan"], { inherit: true });
  command(bunBin, ["run", "build:gui"], { inherit: true });
  command("git", ["diff", "--check"]);
  const dirty = output("git", ["status", "--porcelain"]);
  if (dirty) throw new Error(`Verification changed tracked files:\n${dirty}`);
}

interface PackedFile {
  filename: string;
}

function npmPack(source: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  const result = command(npmBin, ["pack", "--ignore-scripts", "--json", "--pack-destination", destination, source]);
  const parsed = JSON.parse(result.stdout) as PackedFile[];
  const filename = parsed[0]?.filename;
  if (!filename) throw new Error(`npm pack returned no filename for ${source}`);
  return join(destination, basename(filename));
}

function verifyPackedArtifact(path: string): void {
  const entries = output("tar", ["-tzf", path]);
  for (const required of [
    "package/src/server/responses/terminal-guard.ts",
    "package/gui/dist/index.html",
    "package/src/codex/account-lifecycle.ts",
  ]) {
    if (!entries.split("\n").includes(required)) throw new Error(`Local package is missing ${required}`);
  }
}

function buildPackage(tempDir: string): { artifact: string; commit: string; version: string } {
  console.log("\n[3/5] Packing verified local build");
  const commit = output("git", ["rev-parse", "--short=12", "HEAD"]);
  const version = packageVersion();
  const packed = npmPack(root, tempDir);
  verifyPackedArtifact(packed);
  mkdirSync(buildsDir, { recursive: true });
  const artifact = join(buildsDir, `opencodex-${version}-local-${commit}.tgz`);
  if (existsSync(artifact)) rmSync(artifact);
  renameSync(packed, artifact);
  console.log(`Built ${artifact}`);
  return { artifact, commit, version };
}

function backupInstalled(tempDir: string): string {
  const npmRoot = output(npmBin, ["root", "-g"]);
  const installed = join(npmRoot, "@bitkyc08", "opencodex");
  if (!existsSync(join(installed, "package.json"))) throw new Error(`Installed package not found: ${installed}`);
  const version = packageVersion(join(installed, "package.json"));
  const packed = npmPack(installed, tempDir);
  const rollback = join(buildsDir, `rollback-${version}-${timestamp()}.tgz`);
  renameSync(packed, rollback);
  return rollback;
}

async function waitForHealthyProxy(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:10100/healthz", { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`Proxy did not become healthy: ${lastError}`);
}

async function verifyLivePackage(version: string): Promise<void> {
  await waitForHealthyProxy();
  const health = await fetch("http://127.0.0.1:10100/healthz").then(response => response.json()) as { version?: unknown };
  if (health.version !== version) throw new Error(`Expected live version ${version}, found ${String(health.version)}`);
  const gui = await fetch("http://127.0.0.1:10100/");
  if (!gui.ok || !gui.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`GUI is unavailable: HTTP ${gui.status} ${gui.headers.get("content-type") ?? "unknown"}`);
  }
  const html = await gui.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(Boolean);
  for (const asset of assets) {
    if (asset.startsWith("http")) continue;
    const response = await fetch(new URL(asset, "http://127.0.0.1:10100/"));
    if (!response.ok) throw new Error(`GUI asset ${asset} returned HTTP ${response.status}`);
  }
}

async function deployPackage(build: { artifact: string; commit: string; version: string }, tempDir: string): Promise<void> {
  console.log("\n[4/5] Deploying verified package");
  const rollback = backupInstalled(tempDir);
  let replacementStarted = false;
  try {
    command(ocxBin, ["stop"], { inherit: true });
    replacementStarted = true;
    command(npmBin, ["install", "-g", build.artifact, "--force", "--no-audit", "--no-fund"], { inherit: true });
    command(ocxBin, ["service"], { inherit: true });
    await verifyLivePackage(build.version);
  } catch (error) {
    if (replacementStarted) {
      console.error(`Deployment failed; restoring ${rollback}`);
      command(ocxBin, ["stop"], { inherit: true, allowFailure: true });
      command(npmBin, ["install", "-g", rollback, "--force", "--no-audit", "--no-fund"], { inherit: true });
      command(ocxBin, ["service"], { inherit: true });
      await waitForHealthyProxy();
    }
    throw error;
  }
  const manifest = {
    installedAt: new Date().toISOString(),
    version: build.version,
    commit: build.commit,
    branch: LOCAL_BRANCH,
    artifact: build.artifact,
    rollback,
  };
  writeFileSync(join(buildsDir, "installed.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function main(): Promise<void> {
  assertLocalRepository();
  const latest = resolveLatestVersion();
  mergeLatest(latest);
  verifySource();
  const tempDir = mkdtempSync(join(tmpdir(), "opencodex-local-update-"));
  try {
    const build = buildPackage(tempDir);
    await deployPackage(build, tempDir);
    console.log("\n[5/5] Local update completed");
    console.log(`Version ${build.version}, commit ${build.commit}`);
    console.log("Upstream changes were merged into local/stable; local commits remain in Git history.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main().catch(error => {
  console.error(`\nLocal update failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
