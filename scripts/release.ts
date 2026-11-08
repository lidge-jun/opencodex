#!/usr/bin/env bun
/** Dispatch the trusted dev release workflow for a CI-verified source commit.
 * Usage: bun scripts/release.ts latest|preview [full-source-sha] [--publish]
 * The workflow derives and stamps the version. Publication defaults to dry-run.
 */
import { join } from "node:path";
import { commandInvocation } from "../src/lib/win-exec";

export { compareVersions as compareReleaseVersions } from "./version-line";

const usage = "Usage: bun scripts/release.ts latest|preview [full-source-sha] [--publish]";
const fullSha = /^[0-9a-f]{40}$/;
const releaseRepository = "lidge-jun/opencodex";

async function command(args: string[], label: string, env?: Record<string, string | undefined>): Promise<string> {
  const [binary, ...rest] = args;
  const invocation = commandInvocation(binary ?? "", rest);
  const child = Bun.spawn([invocation.file, ...invocation.args], {
    stdout: "pipe", stderr: "pipe",
    ...(env ? { env: { ...process.env, ...env } } : {}),
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  // Child stderr may contain credentials, including on authentication or resolver errors.
  if (exitCode !== 0) throw new Error(`${label} failed (exit ${exitCode})`);
  return stdout.trim();
}

async function main(args: string[]): Promise<void> {
  const [channel, ...options] = args;
  if (channel !== "latest" && channel !== "preview") throw new Error(usage);
  let requestedSha: string | undefined;
  let publish = false;
  for (const option of options) {
    if (option === "--publish" && !publish) publish = true;
    else if (fullSha.test(option) && !requestedSha) requestedSha = option;
    else throw new Error(usage);
  }
  if (process.env.GITHUB_REPOSITORY !== undefined && process.env.GITHUB_REPOSITORY !== releaseRepository) {
    throw new Error(`GITHUB_REPOSITORY must be ${releaseRepository}`);
  }
  const token = process.env.GH_TOKEN === undefined
    ? await command(["gh", "auth", "token", "--hostname", "github.com"], "GitHub authentication")
    : process.env.GH_TOKEN;
  if (!token || /\s/.test(token)) throw new Error("GitHub authentication returned an invalid token");
  const resolver = join(import.meta.dir, "..", ".github", "scripts", "release-evidence.cjs");
  const output = await command(["node", resolver, "resolve", ...(requestedSha ? [requestedSha] : [])],
    "Release evidence resolution", { GH_TOKEN: token, GITHUB_REPOSITORY: releaseRepository });
  let evidence: { sourceSha?: unknown; ciRunId?: unknown };
  try { evidence = JSON.parse(output) as typeof evidence; }
  catch { throw new Error("Evidence resolver returned invalid JSON"); }
  if (!evidence || typeof evidence.sourceSha !== "string" || !fullSha.test(evidence.sourceSha)
    || !Number.isSafeInteger(evidence.ciRunId) || Number(evidence.ciRunId) <= 0
    || (requestedSha !== undefined && evidence.sourceSha !== requestedSha)) {
    throw new Error("Evidence resolver returned an invalid source or CI run identity");
  }
  console.log(`Selected source ${evidence.sourceSha} from CI run ${evidence.ciRunId}; ${publish ? "publication requested" : "dry run"}.`);
  await command(["gh", "workflow", "run", "release.yml", "--repo", `github.com/${releaseRepository}`, "--ref", "dev", "-f", `tag=${channel}`,
    "-f", `expected-sha=${evidence.sourceSha}`, "-f", `dry-run=${!publish}`], "Release workflow dispatch");
  console.log("Release workflow dispatched on dev.");
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
