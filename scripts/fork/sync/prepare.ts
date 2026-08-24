import { classifyPath } from "./ownership";
import { mergePackageJson } from "./recipes/package-json";
import type { CommandRunner, PrepareResult, SyncEvent } from "./types";

export interface PrepareOptions {
  runner: CommandRunner;
}

async function run(
  runner: CommandRunner,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runner(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git command failed with exit code ${result.exitCode}`);
  }
  return result;
}

function branchFor(event: SyncEvent): string {
  const date = new Date(event.detectedAt);
  if (Number.isNaN(date.getTime())) throw new Error("detectedAt is not a valid date");
  return `sync/upstream-${date.toISOString().slice(0, 10).replaceAll("-", "")}`;
}

function conflictedPaths(stdout: string): string[] {
  return [...new Set(stdout.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];
}

function resultForSkipped(event: SyncEvent): PrepareResult {
  return {
    status: event.kind === "history-diverged" ? "history-diverged" : "skipped",
    resolutions: [],
    unresolved: [],
  };
}

export async function prepareSync(
  event: SyncEvent,
  options: PrepareOptions,
): Promise<PrepareResult> {
  if (
    (event.kind !== "pin-updated" && event.kind !== "main-behind")
    || event.recommendedLane !== "daily-merge"
  ) {
    return resultForSkipped(event);
  }

  const branch = branchFor(event);
  await run(options.runner, ["switch", "-c", branch]);
  const merge = await options.runner(["merge", "--no-ff", "vendor/main"]);
  if (merge.exitCode === 0) {
    return { status: "merged", branch, resolutions: [], unresolved: [] };
  }

  const conflicts = conflictedPaths(
    (await run(options.runner, ["diff", "--name-only", "--diff-filter=U"])).stdout,
  );
  const hotspotPaths = conflicts.filter(path => classifyPath(path) === "shared-hotspot");
  if (hotspotPaths.length > 0) {
    await run(options.runner, ["merge", "--abort"]);
    return {
      status: "hotspot-handoff",
      branch,
      resolutions: hotspotPaths.map(path => ({
        path,
        classification: "shared-hotspot" as const,
        action: "merge --abort",
      })),
      unresolved: conflicts,
    };
  }

  const resolutions: PrepareResult["resolutions"] = [];
  for (const path of conflicts) {
    const classification = classifyPath(path);
    if (classification === "recipe") {
      const ours = await run(options.runner, ["show", `:2:${path}`]);
      const theirs = await run(options.runner, ["show", `:3:${path}`]);
      const merged = mergePackageJson(ours.stdout, theirs.stdout);
      await run(options.runner, ["write-file", path, merged]);
      resolutions.push({ path, classification, action: "merge package recipe" });
    } else {
      const side = classification === "fork-owned" ? "ours" : "theirs";
      await run(options.runner, ["checkout", `--${side}`, "--", path]);
      resolutions.push({ path, classification, action: `checkout --${side}` });
    }
    await run(options.runner, ["add", "--", path]);
  }
  await run(options.runner, ["commit", "--no-edit"]);
  return { status: "merged", branch, resolutions, unresolved: [] };
}
