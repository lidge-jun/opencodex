import { z } from "zod";
import { isExportClientId } from "../clients/config-export";
import { runCatalogAction } from "./catalog-command-result";
import { clientIntegrationPath, validateAsideProfile } from "./integration-input";
import { CliUsageError, printData, runtimeRequest, takeFlag, takeOption, type RuntimeApiDeps } from "./runtime-api";

const USAGE = "Usage: ocx integration client history remove --op <opId> --yes [--client aside [--profile <id>]] [--json]";
const receiptSchema = z.object({
  ok: z.literal(true), opId: z.string(),
  clientId: z.string().refine(isExportClientId),
  profileId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  snapshotRemoved: z.boolean(),
});

/** argv begins after history remove (also used by the journal alias). */
export function handleIntegrationJournalRemove(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    const confirmed = takeFlag(args, "--yes");
    const opId = takeOption(args, "--op");
    const client = takeOption(args, "--client");
    const profile = takeOption(args, "--profile");
    if (args.length) throw new CliUsageError("Unknown or repeated journal removal arguments", USAGE);
    if (!opId?.trim() || opId !== opId.trim() || opId.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(opId)) {
      throw new CliUsageError("--op requires a nonempty operation ID without control characters", USAGE);
    }
    if (!confirmed) throw new CliUsageError("Journal removal retires a recovery record; pass --yes to confirm", USAGE);
    if (client !== undefined && client !== "aside") throw new CliUsageError("Journal removal accepts only --client aside or no client selector", USAGE);
    validateAsideProfile(profile, client, USAGE);
    const path = client === "aside" ? `${clientIntegrationPath(client, profile)}/journal` : "/api/client-integrations/journal";
    const parsed = receiptSchema.safeParse(await runtimeRequest(`${path}?opId=${encodeURIComponent(opId)}`, {
      method: "DELETE", redirect: "error",
    }, deps));
    if (!parsed.success) throw new Error("Invalid journal removal receipt");
    const receipt = parsed.data;
    if (receipt.opId !== opId || (client !== undefined && receipt.clientId !== client)
      || (profile !== undefined && receipt.profileId !== Number(profile))
      || (receipt.clientId !== "aside" && receipt.profileId !== undefined)) throw new Error("Journal removal identity mismatch");
    printData(receipt, wantsJson, [
      `Journal operation ${receipt.opId} retired (${receipt.clientId}${receipt.profileId === undefined ? "" : ` profile ${receipt.profileId}`}).`,
      receipt.snapshotRemoved ? "Snapshot cleanup completed." : "Snapshot cleanup is incomplete. The record is already retired; inspect integration status before further cleanup.",
    ]);
    return receipt.snapshotRemoved ? 0 : 1;
  }, {
    integration_journal_newest_protected: "The newest recovery record cannot be removed. Keep it available for restore.",
    integration_operation_not_found: "The operation was not found in the selected journal. Read integration history before retrying.",
  });
}
