import { detectLatestVTag } from "./detect";
import { annotateMainLane } from "./lane";
import { pinVendorRefs } from "./pin";
import { prepareSync } from "./prepare";
import { createDraftPullRequestClient } from "./pull-request";
import { enabledCoordinators, enabledNotifiers, registerCoordinator, registerNotifier } from "./registry";
import { createCliCoordinator } from "./coordinators/cli";
import { createCursorWebhookCoordinator } from "./coordinators/cursor-webhook";
import { createHttpCoordinator } from "./coordinators/http";
import { createGitHubIssueNotifier } from "./notifiers/github-issue";
import type {
  CommandResult,
  CommandRunner,
  DraftPullRequestClient,
  FetchImplementation,
  GitHubIssuesClient,
  ProcessRunner,
  SyncEvent,
} from "./types";

const DEFAULT_UPSTREAM_REPO = "https://github.com/lidge-jun/opencodex.git";
const usage = "usage: bun scripts/fork/sync/cli.ts detect|pin|prepare|draft-pr|emit";

export interface CliOptions {
  env?: Record<string, string | undefined>;
  runner?: CommandRunner;
  stdin?: string;
  write?: (value: string) => void;
  githubClient?: GitHubIssuesClient;
  draftClient?: DraftPullRequestClient;
  fetchImpl?: FetchImplementation;
  processRunner?: ProcessRunner;
}

async function commandRunner(args: readonly string[]): Promise<CommandResult> {
  if (args[0] === "write-file") {
    const [, path, content] = args;
    if (
      !path
      || content === undefined
      || path.startsWith("/")
      || path.split("/").includes("..")
    ) {
      return { exitCode: 1, stdout: "", stderr: "unsafe write-file path" };
    }
    await Bun.write(path, content);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  const process = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return {
    exitCode: await process.exited,
    stdout,
    stderr,
  };
}

function githubClient(
  env: Record<string, string | undefined>,
  fetchImpl: FetchImplementation,
): GitHubIssuesClient {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required for github-issue");
  }
  const base = `https://api.github.com/repos/${repository}/issues`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`GitHub issues request returned HTTP ${response.status}`);
    return response;
  }
  return {
    async listOpen({ label }) {
      const response = await request(`?state=open&labels=${encodeURIComponent(label)}`);
      return await response.json() as Awaited<ReturnType<GitHubIssuesClient["listOpen"]>>;
    },
    async create(options) {
      await request("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      });
    },
    async update(options) {
      const { issueNumber, ...body } = options;
      await request(`/${issueNumber}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}

function registerBuiltins(
  env: Record<string, string | undefined>,
  options: CliOptions,
): void {
  const notifierIds = (env.FORK_SYNC_NOTIFIERS ?? "")
    .split(",")
    .map(id => id.trim());
  if (notifierIds.includes("github-issue")) {
    registerNotifier(createGitHubIssueNotifier({
      upstreamRepo: env.FORK_SYNC_UPSTREAM_REPO ?? DEFAULT_UPSTREAM_REPO,
      client: options.githubClient ?? githubClient(env, options.fetchImpl ?? fetch),
    }));
  }
  const coordinatorIds = (env.FORK_SYNC_COORDINATORS ?? "")
    .split(",")
    .map(id => id.trim());
  if (coordinatorIds.includes("cursor-webhook")) {
    registerCoordinator(createCursorWebhookCoordinator({
      url: env.FORK_SYNC_CURSOR_WEBHOOK_URL,
      secret: env.FORK_SYNC_CURSOR_WEBHOOK_SECRET,
      fetchImpl: options.fetchImpl,
    }));
  }
  if (coordinatorIds.includes("http")) {
    registerCoordinator(createHttpCoordinator({
      url: env.FORK_SYNC_HTTP_URL,
      secret: env.FORK_SYNC_HTTP_SECRET,
      signatureHeader: env.FORK_SYNC_HTTP_SIGNATURE_HEADER,
      signaturePrefix: env.FORK_SYNC_HTTP_SIGNATURE_PREFIX,
      authHeader: env.FORK_SYNC_HTTP_AUTH_HEADER,
      fetchImpl: options.fetchImpl,
    }));
  }
  if (coordinatorIds.includes("cli")) {
    const input = env.FORK_SYNC_CLI_INPUT;
    if (input && input !== "json" && input !== "summary") {
      throw new Error("FORK_SYNC_CLI_INPUT must be json or summary");
    }
    registerCoordinator(createCliCoordinator({
      command: env.FORK_SYNC_CLI_COMMAND,
      input,
      runner: options.processRunner,
    }));
  }
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin).text();
}

async function currentHead(runner: CommandRunner): Promise<string> {
  const result = await runner(["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git rev-parse HEAD failed with exit code ${result.exitCode}`);
  }
  const head = result.stdout.trim();
  if (!head) throw new Error("git rev-parse HEAD returned no commit");
  return head;
}

export async function runCli(
  args: readonly string[],
  options: CliOptions = {},
): Promise<void> {
  const command = args[0];
  if (
    command !== "detect"
    && command !== "pin"
    && command !== "prepare"
    && command !== "draft-pr"
    && command !== "emit"
  ) {
    throw new Error(usage);
  }
  const env = options.env ?? process.env;
  const write = options.write ?? (value => process.stdout.write(`${value}\n`));
  const runner = options.runner ?? commandRunner;
  if (command === "emit") {
    registerBuiltins(env, options);
    const input = options.stdin ?? await readStdin();
    const event = JSON.parse(input) as SyncEvent;
    const failures: string[] = [];
    for (const notifier of enabledNotifiers(env)) {
      try {
        await notifier.notify(event);
      } catch (error) {
        failures.push(`${notifier.id}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    for (const coordinator of enabledCoordinators(env)) {
      try {
        await coordinator.start(event);
      } catch (error) {
        failures.push(`${coordinator.id}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
    return;
  }
  if (command === "prepare") {
    const input = options.stdin ?? await readStdin();
    const event = JSON.parse(input) as SyncEvent;
    const result = await prepareSync(event, { runner });
    write(JSON.stringify(result));
    return;
  }
  if (command === "draft-pr") {
    const input = options.stdin ?? await readStdin();
    const envelope = JSON.parse(input) as {
      event: SyncEvent;
      result: Parameters<DraftPullRequestClient["upsert"]>[0]["result"];
    };
    let client = options.draftClient;
    if (!client) {
      const repository = env.GITHUB_REPOSITORY;
      const token = env.GITHUB_TOKEN;
      if (!repository || !token) {
        throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required for draft-pr");
      }
      client = createDraftPullRequestClient({
        repository,
        token,
        fetchImpl: options.fetchImpl ?? fetch,
      });
    }
    const pullRequestNumber = await client.upsert(envelope);
    write(JSON.stringify({ pullRequestNumber }));
    return;
  }

  const upstreamRepo = env.FORK_SYNC_UPSTREAM_REPO ?? DEFAULT_UPSTREAM_REPO;
  const detected = await detectLatestVTag({ upstreamRepo, runner });
  const mainRef = command === "pin" && detected.vendorMainSha
    ? await currentHead(runner)
    : undefined;
  const pinnedEvent = command === "pin"
    ? await pinVendorRefs(detected, {
      runner,
      upstreamDevRef: env.FORK_SYNC_UPSTREAM_DEV_REF,
    })
    : detected;
  const finalEvent = await annotateMainLane(pinnedEvent, {
    runner,
    ...(mainRef ? { mainRef } : {}),
  });
  write(JSON.stringify(finalEvent));
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch(error => {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : "fork sync failed");
  });
}
