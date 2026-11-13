/**
 * ocx link recover: clean an ephemeral Child that a forced revoke (a Home tombstone) or an
 * interrupted enrollment (--operation-id, the link operation journal) left behind, through
 * POST /api/link/recover (structure/remote-link.md, "Recover").
 */
import { CliUsageError, printData, rejectArgs, takeJsonFlag, takeOption } from "./runtime-api";
import type { LinkCliDeps } from "./link";

type LinkRequest = <T>(path: string, init: RequestInit, deps: LinkCliDeps) => Promise<T>;

export const LINK_RECOVER_USAGE = "  ocx link recover (--link-id <id> | --operation-id <id>) [--json]";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface RecoverReceipt { linkId: string; outcome: "clean"; purged: true }

function validateReceipt(value: unknown, linkId: string | null): RecoverReceipt {
  const fail = (): never => { throw new Error("invalid link API response: recover"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "linkId,outcome,purged") fail();
  if (typeof body.linkId !== "string" || !LINK_ID.test(body.linkId) || (linkId !== null && body.linkId !== linkId)) fail();
  if (body.outcome !== "clean" || body.purged !== true) fail();
  return { linkId: body.linkId as string, outcome: "clean", purged: true };
}

export async function runLinkRecover(args: string[], deps: LinkCliDeps, linkRequest: LinkRequest, usage: string): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const linkId = takeOption(args, "--link-id");
  const operationId = takeOption(args, "--operation-id");
  rejectArgs(args, usage);
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
  printData(receipt, wantsJson, [`Recovered ${receipt.linkId}: the Child restored its pre-link state and removed the planted ocx-child.`]);
}
