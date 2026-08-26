#!/usr/bin/env bun
/**
 * Release helper (jawcode-style, single package). Not shipped in the npm tarball.
 *
 * Usage:
 *   bun scripts/release.ts <version> [--tag latest|preview] [--publish]
 *       Preflight (clean tree + dependency audit + typecheck + tests + privacy scan) → bump package.json → commit → push →
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
 *
 * Protected-branch push: `main` and `preview` carry rulesets that require a pull request, and the
 * admin bypass is `bypass_mode: "pull_request"` — enough to merge a PR, not enough to push. Set
 * `OCX_RELEASE_SSH_KEY` to the private key of the dedicated write deploy key registered as a
 * `DeployKey` bypass actor on those rulesets, and the version-bump push (and only that push) uses
 * it. Override the SSH remote with `OCX_RELEASE_SSH_REPO` when releasing a fork. Unset, the push
 * behaves exactly as before.
 */
import { commandInvocation } from "../src/lib/win-exec";

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
  // Windows exposes npm and gh as `.cmd` shims. A shell-less spawn of a bare
  // `npm` skips PATHEXT entirely and refuses `.cmd` targets outright, so this
  // preflight — the first thing a release does — aborted before invoking a
  // single command, and the release-helper tests saw exit 1 with an empty call
  // log. `commandInvocation` is the module the CLI already uses for exactly
  // this, escaping included; do not hand-roll a second resolver here.
  const [bin, ...rest] = command;
  const invocation = commandInvocation(bin ?? "", rest);
  const proc = Bun.spawn([invocation.file, ...invocation.args], {
    stdout: "pipe",
    stderr: "pipe",
    // Load-bearing on the `cmd.exe /d /s /c` path: the invocation is already a
    // fully escaped command LINE, so re-quoting it would corrupt the arguments.
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Capture stdout from a command, failing loudly on a non-zero exit.
 *
 * Everything in this script goes through `commandInvocation` rather than
 * `Bun.$`. The shell form looked equivalent but is not on Windows: a test that
 * puts shims on PATH writes an extension-less launcher (shebang), a `.js`, and a
 * `.cmd`. Unix honours the shebang launcher; Windows cannot execute it and the
 * built-in shell does not retry as `.cmd`, so `$` walked past the shim straight
 * to the real `git` — the branch guard then saw `dev` instead of the faked
 * `main` and aborted before a single command was logged. That is what made four
 * release-helper tests fail on windows-latest only, with an empty call log.
 */
async function capture(command: string[]): Promise<string> {
  const result = await runQuiet(command);
  if (result.exitCode !== 0) {
    console.error(`✗ ${command.join(" ")} failed (exit ${result.exitCode})`);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }
  return result.stdout;
}

/** Run a command with its output attached to this terminal; abort on failure. */
async function runLoud(command: string[], env?: Record<string, string>): Promise<void> {
  const [bin, ...rest] = command;
  const invocation = commandInvocation(bin ?? "", rest);
  const proc = Bun.spawn([invocation.file, ...invocation.args], {
    stdout: "inherit",
    stderr: "inherit",
    ...(env ? { env: { ...process.env, ...env } } : {}),
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`✗ ${command.join(" ")} failed (exit ${exitCode})`);
    process.exit(1);
  }
}

/**
 * Release-key push target for a protected branch.
 *
 * `main` and `preview` are covered by branch-protection rulesets that require a pull request,
 * so the maintainer's own credential cannot push the version-bump commit even with admin rights:
 * the admin bypass is `bypass_mode: "pull_request"`, which permits merging a PR but not a direct
 * push. The v2.29.0 release died exactly there.
 *
 * The carve-out is a dedicated write deploy key registered as a `DeployKey` bypass actor on both
 * rulesets. It is deliberately NOT a runtime toggle of the ruleset itself: flipping protection off
 * around the push and back on afterwards is crash-open — a SIGKILL, a lost network, or a hung push
 * between the two calls leaves the branch unprotected with no lease to expire it, and while the
 * window is open the bypass applies to every holder of the admin role, not just this release. A
 * key fails closed instead: if the process dies, protection was never weakened, and revoking one
 * credential closes the carve-out without touching repository configuration.
 *
 * Opt-in by path: without `OCX_RELEASE_SSH_KEY` the push runs exactly as before over the configured
 * remote, so a contributor or CI clone is unaffected. The key is used for this one push and nothing
 * else; ordinary git operations keep the maintainer's normal credential.
 */
/**
 * Quote one argument for `GIT_SSH_COMMAND`.
 *
 * Git does not exec this variable directly — it parses it with shell-style word splitting, so a
 * bare interpolation breaks on any key path containing a space (`C:\Users\Jun Kim\.ssh\key` splits
 * into two words and ssh reads `Kim...` as its next flag). Double quotes are the form both POSIX
 * shells and Git's own Windows parser accept, and unlike single quotes they do not mangle a
 * backslash path. Escape the characters that stay special inside double quotes so a path can never
 * introduce a second word or a substitution.
 */
function quoteSshArgument(value: string): string {
  return `"${value.replace(/(["\\`$])/g, "\\$1")}"`;
}

/**
 * Derive the SSH push target from the configured `origin` URL.
 *
 * Deliberately derived rather than hardcoded: a hardcoded `git@host:owner/repo.git` literal is
 * indistinguishable from an email address to `privacy:scan`, and it would also silently push a
 * fork's release to the upstream repository. `OCX_RELEASE_SSH_REPO` still wins when a maintainer
 * needs an explicit target.
 */
function sshTargetFromOrigin(originUrl: string): string | undefined {
  const trimmed = originUrl.trim();
  if (!trimmed) return undefined;
  // Reject a credential-bearing remote outright rather than transplanting it. A URL like
  // https://user:TOKEN@host/o/r.git would otherwise fold the userinfo into the SSH target, and
  // runLoud() prints the failing command — putting the token on the terminal and in the release
  // log. The host capture below therefore excludes '@' as well as '/'.
  const https = /^https?:\/\/([^/@]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https) return `${SSH_USER}@${https[1]}:${https[2]}.git`;
  if (/^https?:\/\//.test(trimmed)) {
    console.error("✗ origin carries credentials in its URL; refusing to build a release push target from it.");
    process.exit(1);
  }
  // Already an SSH remote (either scp-like or ssh://): reuse it verbatim.
  if (isSshRemote(trimmed)) return trimmed;
  return undefined;
}

/**
 * `ssh://host/owner/repo` or the scp-like `user@host:owner/repo`.
 *
 * This check is also a log boundary: the accepted value is printed before the push and appears in
 * the failure command. Parse URL userinfo instead of treating any `ssh://` string as safe, and
 * reject the scp-like `user:password@host:path` lookalike before either sink can observe it.
 */
function isSshRemote(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;

  if (trimmed.startsWith("ssh://")) {
    // WHATWG URL collapses an empty password ("git:@host" -> password ""), so the parsed fields
    // cannot distinguish it from a credential-free principal. Reject any ':' in the raw userinfo
    // segment instead: a colon there is always credential-shaped.
    const authority = trimmed.slice("ssh://".length);
    const userinfoEnd = authority.indexOf("@");
    if (userinfoEnd !== -1 && authority.slice(0, userinfoEnd).includes(":")) return false;
    try {
      const parsed = new URL(trimmed);
      let decodedUsername: string;
      try {
        decodedUsername = decodeURIComponent(parsed.username);
      } catch {
        return false;
      }
      return parsed.protocol === "ssh:"
        && parsed.hostname.length > 0
        && parsed.pathname.length > 1
        && parsed.password === ""
        // The release deploy key uses GitHub's fixed SSH principal. Treat any other userinfo as
        // credential-shaped rather than trying to distinguish a harmless username from a token.
        && (decodedUsername === "" || decodedUsername === SSH_USER)
        && parsed.search === ""
        && parsed.hash === "";
    } catch {
      return false;
    }
  }

  // scp-like syntax has no parser-level query/fragment boundary. Reject those delimiters and any
  // second '@' in the host segment rather than allowing a credential-shaped suffix to reach the
  // target log or failed-command output.
  return /^git@[^:@\s/?#]+:[^?#]+$/.test(trimmed);
}

/** Split out so the scp-like SSH target is assembled rather than written as an address literal. */
const SSH_USER = "git";

async function releasePushCommand(branch: string): Promise<{ command: string[]; env?: Record<string, string> }> {
  const keyPath = process.env.OCX_RELEASE_SSH_KEY?.trim();
  if (!keyPath) return { command: ["git", "push", "origin", branch] };
  const configured = process.env.OCX_RELEASE_SSH_REPO?.trim();
  // An unvalidated override outranking origin means a stale exported value from a fork session can
  // silently retarget a production release. Check the shape, and print the resolved target either
  // way so the destination is visible before the push rather than inferred afterwards.
  if (configured && !isSshRemote(configured)) {
    console.error("✗ OCX_RELEASE_SSH_REPO is not a credential-free ssh:// or git@host:owner/repo remote; refusing to push.");
    process.exit(1);
  }
  const slug = configured || sshTargetFromOrigin(await capture(["git", "remote", "get-url", "origin"]));
  if (!slug) {
    console.error("✗ OCX_RELEASE_SSH_KEY is set but no SSH push target could be derived from origin; set OCX_RELEASE_SSH_REPO.");
    process.exit(1);
  }
  console.log(`→ release push target: ${slug}`);
  return {
    // Push to the SSH URL explicitly rather than rewriting the `origin` remote: the remote stays
    // HTTPS for every other command, so nothing outside this call inherits the key.
    command: ["git", "push", slug, `HEAD:${branch}`],
    // IdentitiesOnly stops ssh from offering the agent's other keys first, which would authenticate
    // as the maintainer and get rejected by the ruleset again.
    env: { GIT_SSH_COMMAND: `ssh -i ${quoteSshArgument(keyPath)} -o IdentitiesOnly=yes` },
  };
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

/** Order two semver strings per the semver.org rules (numeric identifiers numerically,
 * numeric < alphanumeric prerelease, prerelease < release). Returns negative/0/positive. */
export function compareReleaseVersions(left: string, right: string): number {
  // SemVer 2.0.0: build metadata (+...) is valid and ignored for precedence, but
  // anything else unparseable must fail CLOSED. Number() on a garbage core used to
  // yield NaN, and NaN comparisons made the forward guard pass any candidate.
  const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const parse = (value: string) => {
    const match = SEMVER.exec(value.trim());
    if (!match) throw new Error(`unparseable release version: ${JSON.stringify(value)}`);
    const nums = [Number(match[1]), Number(match[2]), Number(match[3])];
    return { nums, pre: match[4] ? match[4].split(".") : null };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (delta !== 0) return delta;
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null && xn !== yn) return xn - yn;
    if (xn !== null && yn === null) return -1;
    if (xn === null && yn !== null) return 1;
    if (xn === null && yn === null && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The proposed version must move its npm channel FORWARD: an unused-but-obsolete
 * target (e.g. cut from a dev branch whose version line trails main) would otherwise
 * pass the unused-version check and publish a regression over the channel tip. */
async function assertChannelVersionMovesForward(packageName: string, version: string, channel: string): Promise<void> {
  const result = await runQuiet(["npm", "view", packageName, "dist-tags", "--json"]);
  if (result.exitCode !== 0) {
    console.error(`✗ failed to read npm dist-tags for ${packageName}`);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }
  let distTags: Record<string, string>;
  try {
    distTags = JSON.parse(result.stdout) as Record<string, string>;
  } catch {
    console.error(`✗ npm dist-tags response for ${packageName} was not JSON`);
    process.exit(1);
  }
  const current = distTags[channel];
  if (!current) return; // channel not published yet — nothing to regress
  let forward: number;
  try {
    forward = compareReleaseVersions(version, current);
  } catch (err) {
    console.error(`✗ cannot compare release versions (candidate ${version}, channel tip ${JSON.stringify(current)}): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (forward <= 0) {
    console.error(`✗ release version ${version} does not move the '${channel}' channel forward (current: ${current}).`);
    console.error("Reconcile the version line first: dev's package.json may trail the latest release; pick a version strictly newer than the channel tip.");
    process.exit(1);
  }
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
  const id = await capture(["gh", "run", "list", "--workflow", "release.yml", "--limit", "1", "--json", "databaseId", "-q", ".[0].databaseId"]);
  if (!id) { console.error("No Release runs found yet."); process.exit(1); }
  await watchRun(id);
}

async function watchRun(id: string | number): Promise<void> {
  console.log(`→ watching Release run ${id}`);
  await runLoud(["gh", "run", "watch", String(id), "--exit-status", "--interval", "10"]);
}

async function waitForReleaseWorkflowRun(sha: string, branch: string, createdAfterIso: string): Promise<GhRun> {
  const deadline = Date.now() + 2 * 60 * 1000;
  let attempt = 1;
  while (Date.now() < deadline) {
    const raw = await capture(["gh", "run", "list", "--workflow", "release.yml", "--branch", branch, "--commit", sha, "--limit", "20", "--json", "createdAt,databaseId,headSha,status,url"]);
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
  const raw = await capture(["gh", "run", "list", "--workflow", workflow, "--commit", sha, "--limit", "20", "--json", "conclusion,databaseId,headSha,status,url"]);
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
  const out = await capture(["git", "ls-remote", "origin", "refs/heads/main"]);
  const [sha] = out.split(/\s+/);
  if (!sha) {
    console.error("✗ could not resolve origin/main");
    process.exit(1);
  }
  return sha;
}

/** Live (network) head of a remote branch — never the local remote-tracking ref. */
async function remoteBranchHead(branch: string): Promise<string> {
  const out = await capture(["git", "ls-remote", "origin", `refs/heads/${branch}`]);
  const [sha] = out.split(/\s+/);
  if (!sha) {
    console.error(`✗ could not resolve origin/${branch}`);
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
const branch = await capture(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
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
if ((await capture(["git", "status", "--porcelain"])).trim()) { console.error("✗ working tree not clean — commit or stash first."); process.exit(1); }
const packageName = await readPackageName();
console.log(`→ release metadata preflight (${packageName}@${version})`);
await assertUnusedReleaseVersion(packageName, version);
await assertChannelVersionMovesForward(packageName, version, tag);
console.log("→ dependency audit");
await runLoud(["bun", "run", "audit:high"]);
console.log("→ typecheck");
await runLoud(["bun", "x", "tsc", "--noEmit"]);
console.log("→ test suite");
// Match CI's isolation policy instead of inventing a second one. `ci.yml` runs
// the storage-policy and api-usage harnesses in DEDICATED jobs and excludes them
// from the general shards (`scripts/ci/run-bun-test-batches.sh`
// `is_general_test_file`), because those Worker-heavy files corrupt the isolate
// state around them.
//
// This preflight used to run `bun test --isolate tests` — the whole directory in
// one process — so it exercised a grouping CI never runs. The result was a
// release gate that failed on `api-usage` while every CI job for the same commit
// was green: the worst kind of gate, one that blocks a good release and teaches
// you to distrust it. Same files and same coverage as before (915), now in the
// same groups CI uses.
// Every command here stays a `bun` invocation. The release-helper suite shims
// exactly `bun`, `gh`, `git` and `npm` onto a scratch PATH to record calls
// without executing them; a `bash` step would miss that shim, escape into the
// real suite, and fail the helper tests with exit 127.
const ISOLATED_TEST_FILES = [
  "./tests/api-storage-policy-already-running.test.ts",
  "./tests/api-storage-policy-mutation-busy.test.ts",
  "./tests/api-storage-policy-put-race.test.ts",
  "./tests/api-storage-policy-run.test.ts",
  "./tests/api-storage-policy.test.ts",
  "./tests/api-storage.test.ts",
  "./tests/api-usage.test.ts",
];
await runLoud([
  "bun", "test", "--isolate", "tests",
  "--path-ignore-patterns=**/api-storage-policy*.test.ts",
  "--path-ignore-patterns=**/api-storage.test.ts",
  "--path-ignore-patterns=**/api-usage.test.ts",
]);
for (const isolated of ISOLATED_TEST_FILES) {
  await runLoud(["bun", "test", "--isolate", isolated]);
}
console.log("→ privacy scan");
await runLoud(["bun", "run", "privacy:scan"]);

// 2. Bump package.json only; the workflow creates the version tag after npm publish.
//
// A dry run bumps and pushes exactly like a real one, because the point of the dry run is to
// exercise the workflow against the REAL release commit. That makes the second invocation
// re-enter with package.json already at `version`, where `npm version <same>` exits
// "Version not changed" — so the documented "re-run with --publish" path could never
// complete. Treat an already-correct version as satisfied rather than as an error: the
// bump is a desired end state, not an action that must happen every time.
const currentVersion = JSON.parse(await Bun.file("package.json").text()).version as string;
if (currentVersion === version) {
  console.log(`→ package.json already at ${version}; leaving it alone`);
} else {
  console.log(`→ bump package.json → ${version}`);
  await runLoud(["npm", "version", version, "--no-git-tag-version"]);
}

// 3. Commit + push the version bump — only if it is not already committed and pushed. On the
// --publish re-run of a dry run there is nothing to commit, and `git commit` with an empty
// index fails, which would strand the release just as surely as the bump did.
const pendingBump = (await capture(["git", "status", "--porcelain", "package.json"])).trim() !== "";
if (pendingBump) {
  await runLoud(["git", "add", "package.json"]);
  await runLoud(["git", "commit", "-m", `release: v${version}`]);
}
const releaseSha = await capture(["git", "rev-parse", "HEAD"]);
if (pendingBump) {
  console.log(`→ push origin ${branch}`);
  const push = await releasePushCommand(branch);
  if (push.env) console.log("→ using the release deploy key for the protected push");
  await runLoud(push.command, push.env);
} else {
  console.log(`→ release commit ${releaseSha.slice(0, 9)} already pushed; reusing it`);
}

// 4. Wait for the pushed release commit to pass CI, then dispatch the Release workflow.
console.log(`→ wait for Cross-platform CI (${releaseSha})`);
await waitForSuccessfulCi(releaseSha);

// The release bump always touches package.json, which is a service-lifecycle trigger path —
// and release.yml's service gate requires an already-successful Service lifecycle run for
// the release SHA. Wait for it too, or the dispatch races the still-running workflow.
console.log(`→ wait for Service lifecycle (${releaseSha})`);
await waitForSuccessfulCi(releaseSha, SERVICE_WORKFLOW, "Service lifecycle");

// Live-remote guard: re-read the actual remote head over the network immediately
// before dispatch. The local remote-tracking ref can be minutes stale, and the
// workflow_dispatch below resolves a mutable branch — so this is the last chance
// to refuse publishing an unaudited newer commit.
const liveOriginSha = await remoteBranchHead(branch);
if (liveOriginSha !== releaseSha) {
  console.error(`✗ origin/${branch} moved while waiting for CI (${liveOriginSha} != ${releaseSha}); aborting release dispatch.`);
  process.exit(1);
}

console.log(`→ dispatch Release (tag=${tag}, dry-run=${dryRun})`);
const dispatchStartedAt = new Date(Date.now() - 5_000).toISOString();
await runLoud(["gh", "workflow", "run", "release.yml", "--ref", branch, "-f", `version=${version}`, "-f", `tag=${tag}`, "-f", `expected-sha=${releaseSha}`, "-f", `dry-run=${String(dryRun)}`]);

// 5. Watch it.
const releaseRun = await waitForReleaseWorkflowRun(releaseSha, branch, dispatchStartedAt);
await watchRun(releaseRun.databaseId);
console.log(dryRun
  ? "\n✓ Dry run complete. Re-run with --publish to publish for real."
  : "\n✓ Published. Try:  npm install -g @bitkyc08/opencodex");
