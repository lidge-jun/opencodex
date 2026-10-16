/**
 * `ocx storage` — the archived-session cleanup, trash, and cleanup-policy surface (wp7).
 *
 * Every route here existed with no CLI caller, so reclaiming disk space was dashboard-only.
 * Three of them delete or move operator data, and the rules for those are deliberate:
 *
 * 1. **Default to preview.** `ocx storage cleanup --percent N` runs the preview route and prints
 *    what WOULD be freed, then exits 0 having mutated nothing.
 * 2. **`--yes` is required to mutate.** There is no interactive prompt: an agent cannot answer
 *    one, and a prompt an agent can answer is not a safety boundary.
 * 3. **`--json` on the preview emits the candidate list**, so an agent can decide from data
 *    rather than from a sentence.
 *
 * This is the opposite of the GitHub star POST, which no flag can authorize: cleanup spends the
 * operator's DATA, which they can delegate, while starring spends their IDENTITY, which they
 * cannot delegate to an agent.
 */
import {
  CliUsageError,
  RuntimeApiError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";
import type { StorageCleanupPolicy } from "../types/config";

const USAGE = `Usage:
  ocx storage report [--json]
  ocx storage cleanup --percent <0-100> [--mode <quarantine|permanent>] [--yes] [--json]
  ocx storage trash [list] [--json]
  ocx storage trash restore <entry-id> [--yes] [--json]
  ocx storage policy [show] [--json]
  ocx storage policy set [--enabled <true|false>] [--archived-bytes-over <bytes>]
      [--reduce-to-bytes <bytes> | --remove-oldest-percent <1-100> | --percent <1-100>]
      [--mode <quarantine|permanent>] [--schedule <startup|daily|weekly|manual>] [--json]
  ocx storage policy run [--yes] [--json]

Cleanup and restore MUTATE operator data and require --yes.
Without --yes, cleanup prints the preview and changes nothing.`;

/** The digest binds a run to the preview it was authorized against. */
interface CleanupPreview {
  percent?: number;
  count?: number;
  bytes?: number;
  digest?: string;
  candidates?: { relPath?: string; bytes?: number }[];
}

function mib(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "unknown size";
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function previewLines(preview: CleanupPreview): string[] {
  const lines = [
    `Would remove ${preview.count ?? 0} archived session file(s), freeing ${mib(preview.bytes)}.`,
  ];
  for (const candidate of (preview.candidates ?? []).slice(0, 10)) {
    lines.push(`  ${candidate.relPath ?? "(unnamed)"}  ${mib(candidate.bytes)}`);
  }
  const shown = Math.min((preview.candidates ?? []).length, 10);
  if ((preview.count ?? 0) > shown) lines.push(`  … and ${(preview.count ?? 0) - shown} more`);
  lines.push("Nothing was deleted. Re-run with --yes to apply.");
  return lines;
}

async function cleanup(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const confirmed = takeFlag(args, "--yes");
  const percent = takeIntegerOption(args, "--percent", { min: 0 });
  const mode = takeOption(args, "--mode") ?? "quarantine";
  rejectArgs(args, USAGE);

  if (percent === undefined) throw new CliUsageError("--percent is required", USAGE);
  if (percent > 100) throw new CliUsageError("--percent must be between 0 and 100", USAGE);
  if (mode !== "quarantine" && mode !== "permanent") {
    throw new CliUsageError("--mode must be quarantine or permanent", USAGE);
  }

  // The preview runs in BOTH paths, and not only to be friendly: the mutating route requires the
  // digest this call returns and rejects a stale one with 409 `stale_preview`. So the confirmed
  // path cannot skip it, which conveniently means --yes and no --yes agree on what they mean.
  const preview = await runtimeRequest<CleanupPreview>("/api/storage/cleanup/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ percent }),
  }, deps);

  if (!confirmed) {
    printData(preview, wantsJson, previewLines(preview));
    return;
  }

  if (!preview.digest) {
    // Refuse rather than send an empty digest: the server would reject it, but a clear local
    // message beats a 400 that looks like a bug in the verb.
    throw new CliUsageError("the preview returned no digest, so the cleanup cannot be authorized", USAGE);
  }

  const result = await runtimeRequest("/api/storage/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ percent, mode, digest: preview.digest }),
  }, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function trash(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const action = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  if (action === "list") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/storage/trash", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }

  if (action !== "restore") throw new CliUsageError(`unknown trash action ${action}`, USAGE);

  const args = [...rest];
  const wantsJson = takeFlag(args, "--json");
  const confirmed = takeFlag(args, "--yes");
  const id = args.shift();
  rejectArgs(args, USAGE);
  if (!id) throw new CliUsageError("a trash entry id is required", USAGE);

  // Restore moves files back and reconciles database rows, and can collide with an existing
  // destination, so it is gated like cleanup rather than treated as a read.
  if (!confirmed) {
    throw new CliUsageError(`restoring ${id} modifies stored sessions; pass --yes to confirm`, USAGE);
  }

  const result = await runtimeRequest("/api/storage/trash/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }, deps);
  printData(result, wantsJson, summaryLines(result));
}

/** New policy controls expose only observed settings and job status, never arbitrary API fields. */
type ObservedPolicy = Omit<StorageCleanupPolicy, "target"> & { target: { reduceToBytes: number } | { removeOldestPercent: number } };
function policyWriteReceipt(value: unknown): { ok: true; policy: ObservedPolicy; job: { status: "idle" | "running" } } {
  const record = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  const count = (item: unknown): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0;
  const invalid = (): never => { throw new Error("Invalid storage policy response; inspect the policy before retrying."); };
  if (!record(value) || value.ok !== true || !record(value.policy) || !record(value.job)) return invalid();
  const source = value.policy;
  if (typeof source.enabled !== "boolean" || !record(source.trigger) || !count(source.trigger.archivedBytesOver)
    || !record(source.target) || (source.mode !== "quarantine" && source.mode !== "permanent")
    || (source.schedule !== "startup" && source.schedule !== "daily" && source.schedule !== "weekly" && source.schedule !== "manual")
    || (value.job.status !== "idle" && value.job.status !== "running")) return invalid();
  const { reduceToBytes, removeOldestPercent } = source.target;
  let target: ObservedPolicy["target"];
  if (count(reduceToBytes) && removeOldestPercent === undefined) target = { reduceToBytes };
  else if (count(removeOldestPercent) && removeOldestPercent >= 1 && removeOldestPercent <= 100 && reduceToBytes === undefined) target = { removeOldestPercent };
  else return invalid();
  const policy: ObservedPolicy = {
    enabled: source.enabled,
    trigger: { archivedBytesOver: source.trigger.archivedBytesOver },
    target,
    mode: source.mode,
    schedule: source.schedule,
  };
  if (source.lastRun !== undefined) {
    if (!record(source.lastRun) || !count(source.lastRun.at) || !count(source.lastRun.freedBytes) || !count(source.lastRun.removed)) return invalid();
    policy.lastRun = { at: source.lastRun.at, freedBytes: source.lastRun.freedBytes, removed: source.lastRun.removed };
  }
  if (source.nextRun !== undefined) {
    if (!count(source.nextRun)) return invalid();
    policy.nextRun = source.nextRun;
  }
  return { ok: true, policy, job: { status: value.job.status } };
}

async function policy(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const action = argv[0] && !argv[0].startsWith("-") ? argv[0] : "show";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  if (action === "show") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/storage/cleanup-policy", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }

  if (action === "set") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    const enabled = takeOption(args, "--enabled");
    const percent = takeIntegerOption(args, "--percent", { min: 0 });
    const removeOldestPercent = takeIntegerOption(args, "--remove-oldest-percent", { min: 0 });
    const reduceToBytes = takeIntegerOption(args, "--reduce-to-bytes", { min: 0 });
    const archivedBytesOver = takeIntegerOption(args, "--archived-bytes-over", { min: 0 });
    const mode = takeOption(args, "--mode");
    const schedule = takeOption(args, "--schedule");
    rejectArgs(args, USAGE);

    if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
      throw new CliUsageError("--enabled must be true or false", USAGE);
    }
    if ([percent, removeOldestPercent, reduceToBytes].filter(value => value !== undefined).length > 1) {
      throw new CliUsageError("choose one target: --percent, --remove-oldest-percent or --reduce-to-bytes", USAGE);
    }
    const extended = archivedBytesOver !== undefined || reduceToBytes !== undefined || removeOldestPercent !== undefined;
    const body: Record<string, unknown> = {};
    if (enabled !== undefined) body.enabled = enabled === "true";
    if (archivedBytesOver !== undefined) body.trigger = { archivedBytesOver };
    // The policy target is nested. A top-level `percent` is not part of the PUT contract:
    // `normalizeStorageCleanupPolicy` reads only `target`, so the field was dropped and the
    // previously stored target survived. `--percent 10` on a policy still holding the
    // default 25% therefore reported success while leaving cleanup authorized to delete
    // more than the operator asked for.
    //
    // An out-of-range value is deliberately still sent: the server owns the 1-100
    // vocabulary and answers with a named 400, which is a rejected write rather than the
    // silent wrong write this replaces.
    if (percent !== undefined) body.target = { removeOldestPercent: percent };
    if (removeOldestPercent !== undefined) body.target = { removeOldestPercent };
    if (reduceToBytes !== undefined) body.target = { reduceToBytes };
    if (mode !== undefined) body.mode = mode;
    if (schedule !== undefined) body.schedule = schedule;
    if (Object.keys(body).length === 0) {
      throw new CliUsageError("policy set needs at least one policy field", USAGE);
    }
    // Values are NOT re-validated here beyond --enabled's shape. The server owns the mode and
    // schedule vocabularies and returns a named 400; duplicating them is a second thing to
    // keep in sync. `enabled` is checked because "--enabled maybe" would otherwise be sent as
    // `false`, which is a wrong write rather than a rejected one.
    let result: unknown;
    try {
      result = await runtimeRequest("/api/storage/cleanup-policy", {
        method: "PUT",
        ...(extended ? { redirect: "error" as const } : {}),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, deps);
    } catch (error) {
      if (!extended) throw error;
      if (error instanceof RuntimeApiError) {
        throw new RuntimeApiError(`Storage policy request failed (${error.status}); inspect the policy before retrying.`, error.status, null);
      }
      throw new Error("Storage policy request failed; inspect the policy before retrying.");
    }
    if (extended) {
      const receipt = policyWriteReceipt(result);
      const saved = receipt.policy;
      printData(receipt, wantsJson, [
        "Policy saved. This command did not start cleanup.",
        `Enabled: ${saved.enabled}`,
        `Trigger: archived bytes over ${saved.trigger.archivedBytesOver}`,
        "reduceToBytes" in saved.target ? `Target: reduce archives to ${saved.target.reduceToBytes} bytes` : `Target: remove oldest ${saved.target.removeOldestPercent}%`,
        `Mode: ${saved.mode}; schedule: ${saved.schedule}; job: ${receipt.job.status}`,
      ]);
      return;
    }
    printData(result, wantsJson, summaryLines(result));
    return;
  }

  if (action !== "run") throw new CliUsageError(`unknown policy action ${action}`, USAGE);

  const args = [...rest];
  const wantsJson = takeFlag(args, "--json");
  const confirmed = takeFlag(args, "--yes");
  rejectArgs(args, USAGE);
  // `force: true` server-side: this run ignores the schedule and deletes now.
  if (!confirmed) {
    throw new CliUsageError("policy run deletes archived sessions now; pass --yes to confirm", USAGE);
  }
  const result = await runtimeRequest("/api/storage/cleanup-policy/run", { method: "POST" }, deps);
  printData(result, wantsJson, summaryLines(result));
}

export async function handleStorageCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  const hasSub = argv[0] !== undefined && !argv[0].startsWith("-");
  const sub = hasSub ? argv[0]! : "report";
  const rest = hasSub ? argv.slice(1) : argv;
  if (sub === "codex-logs") {
    // Doctor and the Log Guard guides still document `ocx storage codex-logs …`.
    // This module owns cleanup/trash/policy; log-guard stays on the observe handler.
    const { handleObserveCommand } = await import("./observe");
    return handleObserveCommand(["storage", "codex-logs", ...rest], deps);
  }
  return runCliAction(async () => {
    if (sub === "report") {
      const args = [...rest];
      const wantsJson = takeFlag(args, "--json");
      rejectArgs(args, USAGE);
      const result = await runtimeRequest("/api/storage", {}, deps);
      printData(result, wantsJson, summaryLines(result));
    }
    else if (sub === "cleanup") await cleanup(rest, deps);
    else if (sub === "trash") await trash(rest, deps);
    else if (sub === "policy") await policy(rest, deps);
    else throw new CliUsageError(`unknown storage command ${sub}`, USAGE);
  });
}

export const STORAGE_USAGE = USAGE;
