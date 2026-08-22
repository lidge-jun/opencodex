import type { CommandRunner, SyncEvent } from "./types";

export const ALLOWED_VENDOR_REFS = ["vendor/main", "vendor/dev"] as const;
export type AllowedVendorRef = (typeof ALLOWED_VENDOR_REFS)[number];

export function isAllowedVendorRef(ref: string): ref is AllowedVendorRef {
  return (ALLOWED_VENDOR_REFS as readonly string[]).includes(ref);
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

export async function pinVendorRef(
  ref: string,
  target: string,
  runner: CommandRunner,
): Promise<void> {
  if (!isAllowedVendorRef(ref)) {
    throw new Error(`ref ${ref} is not allowlisted`);
  }
  await run(runner, ["switch", ref]);
  await run(runner, ["merge", "--ff-only", target]);
}

export interface PinOptions {
  runner: CommandRunner;
  upstreamDevRef?: string;
}

function pinError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gi, "[remote]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export async function pinVendorRefs(
  event: SyncEvent,
  options: PinOptions,
): Promise<SyncEvent> {
  if (event.kind !== "pin-updated") return event;
  try {
    await pinVendorRef("vendor/main", event.latestTagSha, options.runner);
    const main = await run(options.runner, ["rev-parse", "refs/heads/vendor/main"]);
    await pinVendorRef(
      "vendor/dev",
      options.upstreamDevRef ?? "refs/remotes/upstream/dev",
      options.runner,
    );
    const dev = await run(options.runner, ["rev-parse", "refs/heads/vendor/dev"]);
    return {
      ...event,
      kind: "pin-updated",
      vendorMainSha: main.stdout.trim(),
      vendorDevSha: dev.stdout.trim(),
    };
  } catch (error) {
    return {
      ...event,
      kind: "pin-diverged",
      error: pinError(error),
    };
  }
}
