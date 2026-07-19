#!/usr/bin/env bun
/**
 * Release helper (jawcode-style, single package). Not shipped in the npm tarball.
 *
 * Usage:
 *   bun scripts/release.ts <version> [--tag latest|preview] [--publish]
 *       Preflight (clean tree + typecheck + tests + privacy scan) → bump package.json → commit → push →
 *       wait for Cross-platform CI → dispatch the Release workflow → watch it.
 *       The version bump commit/push is real; the Release workflow publish step is dry-run by default.
 *       Pass --publish to publish.
 *   bun scripts/release.ts watch
 *       Watch the most recent Release run.
 *
 * Example:  bun scripts/release.ts 0.1.0            # commit/push bump, workflow dry-run publish
 *           bun scripts/release.ts 0.1.0 --publish  # actually publish 0.1.0
 *
 * Requires: gh CLI (authed). Publishing is tokenless via Trusted Publishing (OIDC) — no NPM_TOKEN.
 */
import { $ } from "bun";

const args = process.argv.slice(2);
interface GhRun {
  conclusion: string | null;
  createdAt?: string;
  databaseId: number;
  headSha: string;
  status: string;
  url: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const CI_WORKFLOW = "ci.yml";
const SERVICE_WORKFLOW = "service-lifecycle.yml";
const CI_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const CI_POLL_MS = 10 * 1000;

async function runQuiet(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function readPackageName(): Promise<string> {
  try {
    const pkg = JSON.parse(await Bun.file("package.json").text()) as { name?: unknown };
    if (typeof pkg.name !== "string" || !pkg.name) {
      console.error("✗ package.json is missing a valid name");
      process.exit(1);
    }
    return pkg.name;
  } catch (error) {
    console.error(`✗ failed to read package.json: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function npmVersionExists(packageName: string, version: string): Promise<boolean> {
  const result = await runQuiet(["npm", "view", `${packageName}@${version}`, "version"]);
  if (result.exitCode === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes("E404") || output.includes("No match found")) return false;

  console.error(`✗ failed to check npm version ${packageName}@${version}`);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

async function remoteTagSha(tagName: string): Promise<string | null> {
  const result = await runQuiet(["git", "ls-remote", "origin", `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]);
  if (result.exitCode !== 0) {
    console.error(`✗ failed to check remote tag ${tagName}`);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  const peeled = lines.find(line => line.endsWith(`refs/tags/${tagName}^{}`));
  const exact = lines.find(line => line.endsWith(`refs/tags/${tagName}`));
  const selected = peeled ?? exact;
  return selected ? selected.split(/\s+/)[0] ?? null : null;
}

async function githubReleaseExists(tagName: string): Promise<boolean> {
  const result = await runQuiet(["gh", "release", "view", tagName, "--json", "tagName"]);
  if (result.exitCode === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("release not found") || output.includes("not found")) return false;

  console.error(`✗ failed to check GitHub Release ${tagName}`);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

async function assertUnusedReleaseVersion(packageName: string, version: string): Promise<void> {
  const releaseTag = `v${version}`;
  const [npmUsed, tagSha, releaseUsed] = await Promise.all([
    npmVersionExists(packageName, version),
    remoteTagSha(releaseTag),
    githubReleaseExists(releaseTag),
  ]);

  const failures: string[] = [];
  if (npmUsed) failures.push(`- npm already has ${packageName}@${version}`);
  if (tagSha) failures.push(`- remote Git tag ${releaseTag} already exists at ${tagSha}`);
  if (releaseUsed) failures.push(`- GitHub Release ${releaseTag} already exists`);

  if (failures.length > 0) {
    console.error(`✗ release version ${version} is already partially or fully used:`);
    console.error(failures.join("\n"));
    console.error("Choose the next unused patch version, or make an explicit human decision to repair public metadata.");
    process.exit(1);
  }
}

async function watchLatest(): Promise<void> {
  const id = (await $`gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId'`.text()).trim();
  if (!id) { console.error("No Release runs found yet."); process.exit(1); }
  await watchRun(id);
}

async function watchRun(id: string | number): Promise<void> {
  console.log(`→ watching Release run ${id}`);
  await $`gh run watch ${String(id)} --exit-status --interval 10`;
}

async function waitForReleaseWorkflowRun(sha: string, branch: string, createdAfterIso: string): Promise<GhRun> {
  const deadline = Date.now() + 2 * 60 * 1000;
  let attempt = 1;
  while (Date.now() < deadline) {
    const raw = await $`gh run list --workflow release.yml --branch ${branch} --commit ${sha} --limit 20 --json createdAt,databaseId,headSha,status,url`.text();
    const runs = (JSON.parse(raw) as GhRun[])
      .filter(run => run.headSha === sha)
      .filter(run => !run.createdAt || run.createdAt >= createdAfterIso)
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    const run = runs[0];
    if (run) {
      console.log(`→ Release workflow run found: ${run.url}`);
      return run;
    }
    console.log(`→ waiting for dispatched Release run (${sha.slice(0, 7)}) attempt ${attempt}`);
    attempt += 1;
    await Bun.sleep(5_000);
  }
  console.error(`✗ timed out waiting for dispatched Release workflow run on ${sha}`);
  process.exit(1);
}

async function listCiRuns(sha: string, workflow: string = CI_WORKFLOW): Promise<GhRun[]> {
  const raw = await $`gh run list --workflow ${workflow} --commit ${sha} --limit 20 --json conclusion,databaseId,headSha,status,url`.text();
  const runs = JSON.parse(raw) as GhRun[];
  return runs.filter(run => run.headSha === sha);
}

async function waitForSuccessfulCi(sha: string, workflow: string = CI_WORKFLOW, label = "Cross-platform CI"): Promise<GhRun> {
  const deadline = Date.now() + CI_WAIT_TIMEOUT_MS;
  let attempt = 1;
  while (Date.now() < deadline) {
    const runs = await listCiRuns(sha, workflow);
    const successful = runs.find(run => run.status === "completed" && run.conclusion === "success");
    if (successful) {
      console.log(`→ ${label} passed: ${successful.url}`);
      return successful;
    }

    const failed = runs.find(run => run.status === "completed" && run.conclusion && run.conclusion !== "success");
    if (failed) {
      console.error(`✗ ${label} failed for ${sha}: ${failed.url}`);
      process.exit(1);
    }

    const state = runs.length > 0
      ? runs.map(run => `${run.status}${run.conclusion ? `/${run.conclusion}` : ""}`).join(", ")
      : "not started yet";
    console.log(`→ waiting for ${label} (${sha.slice(0, 7)}) attempt ${attempt}: ${state}`);
    attempt += 1;
    await Bun.sleep(CI_POLL_MS);
  }

  console.error(`✗ timed out waiting for ${label} on ${sha}`);
  process.exit(1);
}

async function _remoteMainSha(): Promise<string> {
  const out = (await $`git ls-remote origin refs/heads/main`.text()).trim();
  const [sha] = out.split(/\s+/);
  if (!sha) {
    console.error("✗ could not resolve origin/main");
    process.exit(1);
  }
  return sha;
}

if (args[0] === "watch") {
  await watchLatest();
  process.exit(0);
}

const version = args[0];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bun scripts/release.ts <version> [--tag latest|preview] [--publish]\n       bun scripts/release.ts watch");
  process.exit(1);
}
const dryRun = !args.includes("--publish");

// 1. Preflight — must be on main or preview, and local verification must pass.
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
const allowedBranches = ["main", "preview"];
const expectedTag = branch === "preview" ? "preview" : "latest";
const tag = args.includes("--tag") ? (args[args.indexOf("--tag") + 1] ?? expectedTag) : expectedTag;
if (tag !== expectedTag) {
  console.error(`Release tag mismatch: ${branch} releases must use npm dist-tag '${expectedTag}' (got '${tag}').`);
  process.exit(1);
}
if (branch === "preview" && !version.includes("-preview.")) {
  console.error(`Preview releases must use a preview prerelease version (got ${version}).`);
  process.exit(1);
}
if (branch === "main" && version.includes("-")) {
  console.error(`Main releases must use a stable semver version (got ${version}).`);
  process.exit(1);
}
if (!allowedBranches.includes(branch)) { console.error(`✗ must be on ${allowedBranches.join(" or ")} (currently ${branch}).`); process.exit(1); }
if ((await $`git status --porcelain`.text()).trim()) { console.error("✗ working tree not clean — commit or stash first."); process.exit(1); }
const packageName = await readPackageName();
console.log(`→ release metadata preflight (${packageName}@${version})`);
await assertUnusedReleaseVersion(packageName, version);
console.log("→ typecheck");
await $`bun x tsc --noEmit`;
console.log("→ test suite");
await $`bun test --isolate tests`;
console.log("→ privacy scan");
await $`bun run privacy:scan`;

// 2. Bump package.json only; the workflow creates the version tag after npm publish.
console.log(`→ bump package.json → ${version}`);
await $`npm version ${version} --no-git-tag-version`;

// 3. Commit + push the version bump.
await $`git add package.json`;
await $`git commit -m ${`release: v${version}`}`;
const releaseSha = (await $`git rev-parse HEAD`.text()).trim();
console.log(`→ push origin ${branch}`);
await $`git push origin ${branch}`;

// 4. Wait for the pushed release commit to pass CI, then dispatch the Release workflow.
console.log(`→ wait for Cross-platform CI (${releaseSha})`);
await waitForSuccessfulCi(releaseSha);

// The release bump always touches package.json, which is a service-lifecycle trigger path —
// and release.yml's service gate requires an already-successful Service lifecycle run for
// the release SHA. Wait for it too, or the dispatch races the still-running workflow.
console.log(`→ wait for Service lifecycle (${releaseSha})`);
await waitForSuccessfulCi(releaseSha, SERVICE_WORKFLOW, "Service lifecycle");

const originSha = (await $`git rev-parse origin/${branch}`.text()).trim();
if (originSha !== releaseSha) {
  console.error(`✗ origin/${branch} moved while waiting for CI (${originSha} != ${releaseSha}); aborting release dispatch.`);
  process.exit(1);
}

console.log(`→ dispatch Release (tag=${tag}, dry-run=${dryRun})`);
const dispatchStartedAt = new Date(Date.now() - 5_000).toISOString();
await $`gh workflow run release.yml --ref ${branch} -f version=${version} -f tag=${tag} -f dry-run=${String(dryRun)}`;

// 5. Watch it.
const releaseRun = await waitForReleaseWorkflowRun(releaseSha, branch, dispatchStartedAt);
await watchRun(releaseRun.databaseId);
console.log(dryRun
  ? "\n✓ Dry run complete. Re-run with --publish to publish for real."
  : "\n✓ Published. Try:  npm install -g @bitkyc08/opencodex");
