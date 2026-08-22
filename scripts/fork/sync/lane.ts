import type { CommandRunner, SyncEvent } from "./types";

export interface LaneOptions {
  runner: CommandRunner;
  mainRef?: string;
}

function mergeBaseCount(stdout: string): number {
  return stdout
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .length;
}

export async function annotateMainLane(
  event: SyncEvent,
  options: LaneOptions,
): Promise<SyncEvent> {
  const mainRef = options.mainRef ?? "HEAD";
  if (!event.vendorMainSha || !mainRef) return event;

  const contained = await options.runner([
    "merge-base",
    "--is-ancestor",
    event.vendorMainSha,
    mainRef,
  ]);
  if (contained.exitCode !== 0 && contained.exitCode !== 1) return event;

  const mergeBases = await options.runner([
    "merge-base",
    "--all",
    mainRef,
    event.vendorMainSha,
  ]);
  if (mergeBases.exitCode !== 0 && mergeBases.exitCode !== 1) return event;

  const vendorContainedInMain = contained.exitCode === 0;
  const baseCount = mergeBaseCount(mergeBases.stdout);
  const annotated: SyncEvent = {
    ...event,
    vendorContainedInMain,
    mergeBaseCount: baseCount,
  };

  if (event.kind !== "already-current" && event.kind !== "pin-updated") {
    return annotated;
  }
  if (baseCount === 0 || baseCount > 1) {
    return {
      ...annotated,
      kind: "history-diverged",
      recommendedLane: "emergency-rebuild",
    };
  }
  if (event.kind === "pin-updated" && baseCount === 1) {
    return {
      ...annotated,
      recommendedLane: "daily-merge",
    };
  }
  if (event.kind === "already-current" && baseCount === 1) {
    return vendorContainedInMain
      ? { ...annotated, recommendedLane: "noop" }
      : {
        ...annotated,
        kind: "main-behind",
        recommendedLane: "daily-merge",
      };
  }
  return annotated;
}
