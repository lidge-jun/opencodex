import { z } from "zod";
import { redactUserPath } from "../lib/redact";
import type { RefusalReason } from "../integrations/mutation-plan";
import { refreshAsideProfilesThroughServer } from "./aside-profiles";
import { runCatalogAction } from "./catalog-command-result";
import { CliUsageError, printData, takeFlag, takeOption, type RuntimeApiDeps } from "./runtime-api";

const USAGE = "Usage: ocx integration client sync --client aside [--json]";
const refusalText = {
  not_installed: "Aside is not installed for this profile.",
  conflict: "Profile configuration conflicts with the managed integration.",
  unsafe: "Profile configuration cannot be changed safely.",
  non_loopback: "The integration requires a loopback destination.",
  superseded_store: "The client now uses a different configuration store.",
  drift_requires_confirm: "Profile configuration changed; inspect it before an explicit restore.",
  snapshot_expired: "The recovery snapshot has expired.",
  write_failed: "The profile write failed. Inspect its state before retrying.",
} satisfies Record<RefusalReason, string>;
const profileId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(32768);
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ client: z.literal("aside"), profileId, ok: z.literal(true), changed: z.boolean(),
    reason: text.optional().transform(value => value === undefined ? undefined
      : value === "managed block is absent; refresh did not reconnect it"
        ? "Managed block remains absent; synchronization did not reconnect it."
        : "Profile synchronization returned a notice; inspect integration status."),
  }),
  z.object({ client: z.literal("aside"), profileId, ok: z.literal(false),
    state: z.enum(["absent", "current", "stale", "conflict", "unsafe"]),
    refusalReason: z.enum(["not_installed", "conflict", "unsafe", "non_loopback", "superseded_store", "drift_requires_confirm", "snapshot_expired", "write_failed"]),
    reason: text.optional(), residual: z.boolean().optional(),
    snapshotPath: text.min(1).transform(redactUserPath).optional(),
  }).transform(row => ({ ...row, reason: refusalText[row.refusalReason] })),
]);
const resultsSchema = z.array(resultSchema).refine(rows => new Set(rows.map(row => row.profileId)).size === rows.length);

/** Narrow owner seam: production always uses the established attested exchange. */
export interface AsideSyncCliDeps extends RuntimeApiDeps {
  refreshAsideProfilesImpl?: typeof refreshAsideProfilesThroughServer;
}

/** argv begins after sync. No local writer or base-URL pre-resolution. */
export function handleIntegrationAsideSync(argv: string[], deps: AsideSyncCliDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    const client = takeOption(args, "--client");
    if (args.length || client !== "aside") throw new CliUsageError("Sync requires --client aside and accepts only --json", USAGE);
    // Sync is an aggregate operation: every owner/transport failure is exit 1,
    // not the record-not-found/conflict exits used by addressed journal writes.
    const outcomes = await (deps.refreshAsideProfilesImpl ?? refreshAsideProfilesThroughServer)(deps)
      .catch(() => { throw new Error("Aside synchronization did not complete"); });
    const parsed = resultsSchema.safeParse(outcomes);
    if (!parsed.success) throw new Error("Invalid Aside synchronization outcome");
    const results = parsed.data;
    const lines = results.length === 0 ? ["No eligible Aside profiles to synchronize. Check integration status and profile sync preferences."]
      : results.flatMap(row => [
        `Aside profile ${row.profileId}: ${row.ok ? row.changed ? "updated" : "unchanged" : "failed"}.`,
        ...(row.reason ? [row.reason] : []),
        ...(!row.ok && row.residual ? ["Recovery is incomplete; inspect the profile before retrying."] : []),
        ...(!row.ok && row.snapshotPath ? [`Backup (redacted path): ${row.snapshotPath}`] : []),
      ]);
    printData({ results }, wantsJson, lines);
    return results.some(row => !row.ok) ? 1 : 0;
  });
}
