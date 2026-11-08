#!/usr/bin/env bun
/** Dispatch the trusted dev release workflow for a CI-verified source commit.
 * Usage: bun scripts/release.ts latest|preview [full-source-sha] [--publish]
 *   bun scripts/release.ts watch
 * The workflow derives and stamps the version. Publication defaults to dry-run.
 */
import { join } from "node:path";
import { commandInvocation } from "../src/lib/win-exec";

export { compareVersions as compareReleaseVersions } from "./version-line";

const usage = "Usage: bun scripts/release.ts latest|preview [full-source-sha] [--publish] | watch";
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

/** Like {@link command}, but the operator sees the child's stdout live; stderr stays captured and unprinted. */
async function streamCommand(args: string[], label: string): Promise<void> {
  const [binary, ...rest] = args;
  const invocation = commandInvocation(binary ?? "", rest);
  const child = Bun.spawn([invocation.file, ...invocation.args], {
    stdout: "inherit", stderr: "pipe",
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const [exitCode] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${label} failed (exit ${exitCode})`);
}

interface ReleaseRun {
  createdAt: string;
  databaseId: number;
  headSha: string;
  headBranch: string;
  event: string;
  workflowDatabaseId: number;
  status: string;
  url: string;
}

const githubRepo = `github.com/${releaseRepository}`;
const runUrlPrefix = `https://github.com/${releaseRepository}/actions/runs/`;

function runIdFromDispatch(output: string): number {
  const urls = output.split(/\s+/).filter(part => part.startsWith("https://"));
  if (urls.length !== 1 || !urls[0]!.startsWith(runUrlPrefix)) {
    throw new Error("Dispatch did not return one identifiable release run URL; inspect Actions manually before retrying");
  }
  const idText = urls[0]!.slice(runUrlPrefix.length);
  const id = Number(idText);
  if (!/^[1-9][0-9]*$/.test(idText) || !Number.isSafeInteger(id)) {
    throw new Error("Dispatch returned an invalid release run ID; inspect Actions manually before retrying");
  }
  return id;
}

function parseRuns(raw: string): ReleaseRun[] {
  let result: unknown;
  try { result = JSON.parse(raw); } catch { throw new Error("Invalid release run listing"); }
  if (!Array.isArray(result)) throw new Error("Invalid release run listing");
  return result as ReleaseRun[];
}

async function watchRun(id: number): Promise<void> {
  console.log(`Watching release run ${id}: ${runUrlPrefix}${id}`);
  // Stream gh's progress and final job states (#8330); its stderr may carry credentials and stays private.
  await streamCommand(["gh", "run", "watch", String(id), "--repo", githubRepo, "--exit-status", "--interval", "10"], "Release run watch");
}

async function waitForReleaseWorkflowRun(workflowId: number, id: number, startedAt: number): Promise<ReleaseRun> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const raw = await command(["gh", "run", "list", "--workflow", "release.yml", "--branch", "dev",
      "--repo", githubRepo, "--event", "workflow_dispatch", "--limit", "100", "--json", "createdAt,databaseId,headSha,status,url,headBranch,event,workflowDatabaseId"], "Release run lookup");
    const matching = parseRuns(raw).filter(run => run?.databaseId === id);
    if (matching.length > 1) throw new Error("Release run lookup returned duplicate run IDs");
    const run = matching[0];
    if (run) {
      if (typeof run.headSha !== "string" || !fullSha.test(run.headSha)
        || run.headBranch !== "dev" || run.event !== "workflow_dispatch" || run.workflowDatabaseId !== workflowId
        || run.url !== `${runUrlPrefix}${id}` || typeof run.createdAt !== "string"
        || !Number.isFinite(Date.parse(run.createdAt)) || Date.parse(run.createdAt) < startedAt
        || typeof run.status !== "string" || !run.status) {
        throw new Error(`Release run ${id} does not match the dispatched workflow; inspect Actions manually`);
      }
      return run;
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`Timed out locating release run ${id}; inspect Actions manually before retrying`);
}

async function watchLatest(): Promise<void> {
  const raw = await command(["gh", "run", "list", "--workflow", "release.yml", "--branch", "dev", "--event", "workflow_dispatch",
    "--repo", githubRepo, "--limit", "1", "--json", "createdAt,databaseId,headSha,status,url"], "Release run lookup");
  const runs = parseRuns(raw);
  const run = runs[0];
  if (runs.length !== 1 || !run || !Number.isSafeInteger(run.databaseId) || run.databaseId <= 0
    || run.url !== `${runUrlPrefix}${run.databaseId}`) throw new Error("No identifiable dev release run found");
  await watchRun(run.databaseId);
}

async function main(args: string[]): Promise<void> {
  const [channel, ...options] = args;
  if (channel === "watch" && options.length === 0) { await watchLatest(); return; }
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
  const workflowIdText = await command(["gh", "api", `repos/${releaseRepository}/actions/workflows/release.yml`, "--hostname", "github.com", "--jq", ".id"], "Release workflow identity lookup");
  const workflowId = Number(workflowIdText);
  if (!/^[1-9][0-9]*$/.test(workflowIdText) || !Number.isSafeInteger(workflowId)) throw new Error("Invalid release workflow identity");
  const startedAt = Math.floor(Date.now() / 1000) * 1000;
  const dispatched = await command(["gh", "workflow", "run", "release.yml", "--repo", githubRepo, "--ref", "dev", "-f", `tag=${channel}`,
    "-f", `expected-sha=${evidence.sourceSha}`, "-f", `dry-run=${!publish}`], "Release workflow dispatch");
  const id = runIdFromDispatch(dispatched);
  const releaseRun = await waitForReleaseWorkflowRun(workflowId, id, startedAt);
  await watchRun(releaseRun.databaseId);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
