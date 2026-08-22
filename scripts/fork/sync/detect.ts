import type {
  CommandResult,
  CommandRunner,
  SyncEvent,
} from "./types";

export interface DetectOptions {
  upstreamRepo: string;
  runner: CommandRunner;
  now?: () => Date;
}

class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: CommandResult,
  ) {
    super(result.stderr.trim() || `git command failed with exit code ${result.exitCode}`);
  }
}

async function runGit(
  runner: CommandRunner,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await runner(args);
  if (result.exitCode !== 0) throw new GitCommandError(args, result);
  return result;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/gi, "[remote]")
    .replace(/(?:token|secret|password|authorization|bearer)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function parseTags(output: string): Array<{ tag: string; sha: string }> {
  return output
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[0] && parts[1]?.startsWith("refs/tags/"))
    .map(([sha, ref]) => ({ sha, tag: ref.slice("refs/tags/".length) }))
    .filter(({ tag }) => tag.startsWith("v"));
}

function compareTags(left: string, right: string): number {
  const version = /^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
  const leftMatch = version.exec(left);
  const rightMatch = version.exec(right);
  if (leftMatch && rightMatch) {
    for (let index = 1; index <= 3; index += 1) {
      const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
      if (difference !== 0) return difference;
    }
    const leftStable = /^v\d+\.\d+\.\d+$/.test(left);
    const rightStable = /^v\d+\.\d+\.\d+$/.test(right);
    if (leftStable !== rightStable) return leftStable ? 1 : -1;
  } else if (leftMatch) {
    return 1;
  } else if (rightMatch) {
    return -1;
  }
  return left.localeCompare(right);
}

function event(
  kind: SyncEvent["kind"],
  options: DetectOptions,
  latestTag = "",
  latestTagSha = "",
  vendorMainSha = "",
  vendorDevSha = "",
  error?: string,
): SyncEvent {
  return {
    kind,
    upstreamRepo: options.upstreamRepo,
    latestTag,
    latestTagSha,
    vendorMainSha,
    vendorDevSha,
    detectedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(error ? { error } : {}),
  };
}

export async function detectLatestVTag(
  options: DetectOptions,
): Promise<SyncEvent> {
  let latestTag = "";
  let latestTagSha = "";
  let vendorMainSha = "";
  let vendorDevSha = "";
  try {
    const tags = parseTags(
      (await runGit(options.runner, [
        "ls-remote",
        "--tags",
        "--refs",
        options.upstreamRepo,
        "v*",
      ])).stdout,
    ).sort((left, right) => compareTags(left.tag, right.tag));
    if (tags.length === 0) throw new Error("no v* release tag found");
    vendorMainSha = (await runGit(options.runner, [
      "rev-parse",
      "refs/heads/vendor/main",
    ])).stdout.trim();
    vendorDevSha = (await runGit(options.runner, [
      "rev-parse",
      "refs/heads/vendor/dev",
    ])).stdout.trim();

    let latest: { tag: string; sha: string } | undefined;
    for (let index = tags.length - 1; index >= 0; index -= 1) {
      const candidate = tags[index]!;
      latestTag = candidate.tag;
      latestTagSha = candidate.sha;
      const onUpstreamMain = await options.runner([
        "merge-base",
        "--is-ancestor",
        candidate.sha,
        "refs/remotes/upstream/main",
      ]);
      if (onUpstreamMain.exitCode === 0) {
        latest = candidate;
        break;
      }
      if (onUpstreamMain.exitCode !== 1) {
        throw new GitCommandError(
          ["merge-base", "--is-ancestor", candidate.sha, "refs/remotes/upstream/main"],
          onUpstreamMain,
        );
      }
    }
    if (!latest) {
      return event(
        "detect-failed",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
        "no v* tag is an ancestor of upstream/main",
      );
    }
    latestTag = latest.tag;
    latestTagSha = latest.sha;

    if (vendorMainSha === latestTagSha) {
      return event(
        "already-current",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
      );
    }

    const tagContainedInVendor = await options.runner([
      "merge-base",
      "--is-ancestor",
      latestTagSha,
      vendorMainSha,
    ]);
    if (tagContainedInVendor.exitCode === 0) {
      return event(
        "already-current",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
      );
    }
    if (tagContainedInVendor.exitCode !== 1) {
      throw new GitCommandError(
        ["merge-base", "--is-ancestor", latestTagSha, vendorMainSha],
        tagContainedInVendor,
      );
    }

    const vendorCanFastForward = await options.runner([
      "merge-base",
      "--is-ancestor",
      vendorMainSha,
      latestTagSha,
    ]);
    if (vendorCanFastForward.exitCode === 1) {
      return event(
        "pin-diverged",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
        "vendor/main cannot be fast-forwarded to the latest tag",
      );
    }
    if (vendorCanFastForward.exitCode !== 0) {
      throw new GitCommandError(
        ["merge-base", "--is-ancestor", vendorMainSha, latestTagSha],
        vendorCanFastForward,
      );
    }
    return event(
      "pin-updated",
      options,
      latestTag,
      latestTagSha,
      vendorMainSha,
      vendorDevSha,
    );
  } catch (error) {
    return event(
      "detect-failed",
      options,
      latestTag,
      latestTagSha,
      vendorMainSha,
      vendorDevSha,
      safeError(error),
    );
  }
}
