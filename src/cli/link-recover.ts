/**
 * ocx link recover: clean an ephemeral Child that a forced revoke (a Home tombstone) or an
 * interrupted enrollment (--operation-id, the link operation journal) left behind, through
 * POST /api/link/recover (structure/remote-link.md, "Recover"). --list shows the tombstones still
 * waiting; --forget drops one whose machine is gone for good. Forget has no management API: it runs
 * here, on the Home, for a person only, under the config mutation lock that a forced revoke's link
 * removal also takes, and is refused while the link still exists.
 */
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { linkStorePath } from "../link/paths";
import { readLinkStore } from "../link/store";
import { forgetTombstone, tombstonesPath } from "../link/tombstones";
import { isAgentDriven } from "./agent-driven";
import { CliUsageError, printData, rejectArgs, takeFlag, takeJsonFlag, takeOption } from "./runtime-api";
import type { LinkCliDeps } from "./link";

type LinkRequest = <T>(path: string, init: RequestInit, deps: LinkCliDeps) => Promise<T>;

export const LINK_RECOVER_USAGE = [
  "  ocx link recover (--link-id <id> | --operation-id <id>) [--json]",
  "  ocx link recover --list [--json]",
  "  ocx link recover --forget --link-id <id> --yes [--json]",
].join("\n");

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ALIAS = /^[^\u0000-\u001f\u007f]{1,255}$/;

/** purged false: the Child restored its state, but kept the shared planted binary for another home's relay. */
interface RecoverReceipt { linkId: string; outcome: "clean"; purged: boolean }
interface WaitingTombstone { linkId: string; alias: string; revokedAt: string; remotePlatform?: "posix" | "windows" }

const invalid = (what: string): never => { throw new Error("invalid link API response: " + what); };
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function validateReceipt(value: unknown, linkId: string | null): RecoverReceipt {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "linkId,outcome,purged") return invalid("recover");
  if (typeof value.linkId !== "string" || !LINK_ID.test(value.linkId) || (linkId !== null && value.linkId !== linkId)) invalid("recover");
  if (value.outcome !== "clean" || typeof value.purged !== "boolean") invalid("recover");
  return { linkId: value.linkId as string, outcome: "clean", purged: value.purged as boolean };
}

function validateList(value: unknown): WaitingTombstone[] {
  if (!isObject(value) || Object.keys(value).join(",") !== "tombstones" || !Array.isArray(value.tombstones)) return invalid("recover list");
  return value.tombstones.map(item => {
    if (!isObject(item) || typeof item.linkId !== "string" || !LINK_ID.test(item.linkId) || typeof item.alias !== "string" || !ALIAS.test(item.alias)
      || typeof item.revokedAt !== "string" || Number.isNaN(Date.parse(item.revokedAt))
      || (item.remotePlatform !== undefined && item.remotePlatform !== "posix" && item.remotePlatform !== "windows")) return invalid("recover list");
    return { linkId: item.linkId, alias: item.alias, revokedAt: item.revokedAt, ...(item.remotePlatform ? { remotePlatform: item.remotePlatform as "posix" | "windows" } : {}) };
  });
}

export async function runLinkRecover(args: string[], deps: LinkCliDeps, linkRequest: LinkRequest, usage: string): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const list = takeFlag(args, "--list");
  const forget = takeFlag(args, "--forget");
  const yes = takeFlag(args, "--yes");
  const linkId = takeOption(args, "--link-id");
  const operationId = takeOption(args, "--operation-id");
  rejectArgs(args, usage);
  if (list) {
    if (forget || yes || linkId !== undefined || operationId !== undefined) throw new CliUsageError("recover --list takes no other option", usage);
    const tombstones = validateList(await linkRequest<unknown>("/api/link/recover", { method: "GET", redirect: "error" }, deps));
    printData({ tombstones }, wantsJson, tombstones.length === 0
      ? ["No forced revoke is waiting for cleanup."]
      : tombstones.map(t => `${t.linkId}  ${t.alias}  revoked ${t.revokedAt}`));
    return;
  }
  if (forget) {
    if (linkId === undefined || !LINK_ID.test(linkId) || operationId !== undefined) throw new CliUsageError("recover --forget requires a valid --link-id", usage);
    if (!yes) throw new CliUsageError("recover --forget drops the only record that this machine still needs cleanup; confirm with --yes", usage);
    // Forgetting gives up on cleaning a machine: a person decides that, never an agent or a runner.
    if ((deps.agentDriven ?? isAgentDriven)()) throw new CliUsageError("recover --forget must be run by a person at a terminal, not by an agent or a CI runner", usage);
    const readStore = deps.readStore ?? (() => readLinkStore(linkStorePath()));
    let outcome;
    try {
      outcome = withConfigMutationLockSync(() => forgetTombstone(linkId, readStore().links.some(link => link.id === linkId), tombstonesPath()));
    } catch {
      throw new Error("The link tombstone file could not be read or updated, or another change holds the configuration lock; it was left as it is. Try again.");
    }
    if (outcome === "link_present") throw new Error("This link still exists: revoke it first (ocx link revoke), then forget it if its machine is gone.");
    if (outcome === "not_found") throw new Error("No forced revoke of this link is waiting for cleanup.");
    printData({ linkId, outcome: "forgotten" }, wantsJson, [`Forgot ${linkId}: its machine will not be cleaned by ocx link recover.`]);
    return;
  }
  if (yes) throw new CliUsageError("--yes applies only to recover --forget", usage);
  if ((linkId === undefined) === (operationId === undefined)) throw new CliUsageError("recover needs exactly one of --link-id or --operation-id", usage);
  if (linkId !== undefined && !LINK_ID.test(linkId)) throw new CliUsageError("recover requires a valid --link-id", usage);
  if (operationId !== undefined && !OPERATION_ID.test(operationId)) throw new CliUsageError("recover requires a valid --operation-id", usage);
  const response = await linkRequest<unknown>("/api/link/recover", {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(linkId !== undefined ? { linkId } : { operationId }),
  }, deps);
  const receipt = validateReceipt(response, linkId ?? null);
  printData(receipt, wantsJson, [receipt.purged
    ? `Recovered ${receipt.linkId}: the Child restored its pre-link state and removed the planted ocx-child.`
    : `Recovered ${receipt.linkId}: the Child restored its pre-link state; the planted ocx-child stays because another OpenCodex home on that machine runs a relay from it.`]);
}
