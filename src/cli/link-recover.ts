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
import { CliUsageError, printData, rejectArgs, RuntimeApiError, takeFlag, takeJsonFlag, takeOption } from "./runtime-api";
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

/**
 * alias_linked's step: the machine may run that other link now (enrolled again under this alias while the tombstone waited),
 * and no status check proves it does not (ocx-child's status reads only state.json, so an attach in progress can show no link
 * or an earlier one; unreadable state shows none). So the other link is left; ending it is the operator's own decision.
 */
type RecoverTarget = { readonly linkId: string } | { readonly operationId: string };
/** The command that repeats this recover, and a person's way out when the machine is clean or gone, for its target. */
const again = (t: RecoverTarget): string => "linkId" in t ? "ocx link recover --link-id " + t.linkId : "ocx link recover --operation-id " + t.operationId;
const settleOperation = (operationId: string): string => "ocx link operations resolve --operation-id " + operationId + " --yes";
const aliasLinked = (t: RecoverTarget): string => "another Home-initiated link still uses this machine's alias, so the Child there may belong to that link. Do not run ocx-child detach on the machine. Leave that link: no status check on the machine can show it is stale, since an attach of it still in progress can show no link or an earlier one, and state that cannot be read shows none. " + ("linkId" in t ? "This tombstone" : "This operation") + " waits until that link is removed; then run " + again(t) + " again. Revoking that link (ocx link revoke --link-id <that link's id>, shown by ocx link status, after settling any open operation on it: ocx link operations) ends it and disconnects the machine if the machine runs it, so do that only if you mean to end that link. "
  + ("linkId" in t ? "A person on this Home can instead forget this tombstone (ocx link recover --forget --link-id " + t.linkId + " --yes) once the machine is confirmed clean or gone."
    : "Once the machine is confirmed clean or gone, a person on this Home can instead resolve the operation (" + settleOperation(t.operationId) + ").");

/**
 * child_recover_unsupported's step: the planted ocx-child cannot bind its detach to the link, and its status cannot show an
 * interrupted attach of another link that a plain detach would restore and then remove, so the machine is left.
 */
const recoverUnsupported = (t: RecoverTarget): string => "the planted ocx-child predates detach --expect-link, so it cannot check which link it belongs to, and nothing was changed. Do not run its plain detach on the machine: its status cannot show an interrupted attach of another link, which a plain detach would restore and then remove. Leave the machine: recover cannot confirm its cleanup with this build. Once the machine is gone, or a person on that machine has checked and cleaned its ocx-child records by hand, a person on this Home can run "
  + ("linkId" in t ? "ocx link recover --forget --link-id " + t.linkId + " --yes." : settleOperation(t.operationId) + ".");

/** The CLI's own words for recover's refusals; any other code is shown as the code itself. */
const RECOVER_REFUSALS: Record<string, string> = {
  link_present: "this link still exists; revoke it (ocx link revoke, with --purge for a lightweight Child) instead.",
  link_retirement_pending: "this link's removal is unfinished; repeat ocx link revoke for it, then recover.",
  tombstone_not_found: "no forced revoke of this link is waiting for cleanup (ocx link recover --list).",
  host_key_changed: "the machine's pinned host key changed since the link was made; nothing was sent to it.",
};

/**
 * A refusal from POST /api/link/recover, named by its code: the CLI's own text for a known code, else the code with
 * its hint when the hint is a plain word (a fixed hint or a record name). Only these closed or validated values reach
 * the terminal, never the server's message; the status is kept, so the exit code is unchanged.
 */
function recoverRefusal(error: RuntimeApiError, target: RecoverTarget): RuntimeApiError {
  const body = isObject(error.body) && isObject(error.body.error) ? error.body.error : null;
  const code = typeof body?.code === "string" && /^[a-z_]{1,64}$/.test(body.code) ? body.code : null;
  if (!code) return error;
  const hint = typeof body?.hint === "string" && /^[a-z0-9_-]{1,64}$/.test(body.hint) ? body.hint : null;
  // A command is printed so that it runs as printed: the link id or operation id this command validated. An --operation-id
  // recover's target comes from the journal (--list shows only tombstones), so its way out resolves the operation.
  const known = code === "alias_linked" ? aliasLinked(target)
    : code === "child_recover_unsupported" ? recoverUnsupported(target)
      : Object.hasOwn(RECOVER_REFUSALS, code) ? RECOVER_REFUSALS[code] : undefined;
  const message = "Link recover refused (" + error.status + "): " + code + (hint ? " (" + hint + ")" : "") + (known ? ": " + known : "");
  return new RuntimeApiError(message, error.status, error.body);
}

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
  let response: unknown;
  try {
    response = await linkRequest<unknown>("/api/link/recover", {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(linkId !== undefined ? { linkId } : { operationId }),
    }, deps);
  } catch (error) {
    throw error instanceof RuntimeApiError ? recoverRefusal(error, linkId !== undefined ? { linkId } : { operationId: operationId! }) : error;
  }
  const receipt = validateReceipt(response, linkId ?? null);
  printData(receipt, wantsJson, [receipt.purged
    ? `Recovered ${receipt.linkId}: the Child restored its pre-link state and removed the planted ocx-child.`
    : `Recovered ${receipt.linkId}: the Child restored its pre-link state; the planted ocx-child stays because another OpenCodex home on that machine runs a relay from it.`]);
}
