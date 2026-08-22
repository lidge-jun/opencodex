import type { ForkSyncCoordinator, ProcessRunner, SyncEvent } from "../types";

export interface CliCoordinatorOptions {
  command?: string;
  input?: "json" | "summary";
  runner?: ProcessRunner;
}

async function processRunner(
  args: readonly string[],
  stdin: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdin.write(stdin);
  process.stdin.end();
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

function summary(event: SyncEvent): string {
  return [
    `Fork sync event: ${event.kind}`,
    `Upstream repository: ${event.upstreamRepo}`,
    `Latest tag: ${event.latestTag}`,
    `Latest tag SHA: ${event.latestTagSha}`,
    `vendor/main SHA: ${event.vendorMainSha}`,
    `vendor/dev SHA: ${event.vendorDevSha}`,
    `Detected at: ${event.detectedAt}`,
    event.error ? `Error: ${event.error}` : "Action: prepare a human-reviewed draft PR.",
  ].join("\n");
}

function commandArgs(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function createCliCoordinator(
  options: CliCoordinatorOptions,
): ForkSyncCoordinator {
  return {
    id: "cli",
    async start(event) {
      if (
        !["pin-updated", "main-behind", "history-diverged"].includes(event.kind) ||
        !options.command?.trim()
      ) return;

      const args = commandArgs(options.command);
      const input = options.input === "summary"
        ? summary(event)
        : JSON.stringify(event);
      const result = await (options.runner ?? processRunner)(args, input);
      if (result.exitCode !== 0) {
        throw new Error(`CLI coordinator returned exit code ${result.exitCode}`);
      }
    },
  };
}
