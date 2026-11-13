/**
 * ocx link operations: read the Home's link operation journal (structure/remote-link.md, "Operation journal") and
 * resolve a residual or unknown entry once the Child is known clean or the loss is accepted, which starts its 30
 * days of retention. GET /api/link/operations[/{id}] and POST /api/link/operations/{id}/resolve.
 */
import { CliUsageError, printData, rejectArgs, takeFlag, takeJsonFlag, takeOption } from "./runtime-api";
import type { LinkCliDeps } from "./link";

type LinkRequest = <T>(path: string, init: RequestInit, deps: LinkCliDeps) => Promise<T>;

export const LINK_OPERATIONS_USAGE = [
  "  ocx link operations [--operation-id <id>] [--json]",
  "  ocx link operations resolve --operation-id <id> --yes [--json]",
];

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function line(op: unknown): string {
  if (!isRecord(op)) throw new Error("invalid link API response: operation");
  const { operationId, kind, alias, state } = op;
  if (typeof operationId !== "string" || typeof kind !== "string" || typeof alias !== "string" || typeof state !== "string") throw new Error("invalid link API response: operation");
  return operationId + "  " + kind + "  " + alias + "  " + state + (typeof op.resolvedAt === "string" ? "  resolved " + op.resolvedAt : "");
}

export async function runLinkOperations(args: string[], deps: LinkCliDeps, request: LinkRequest, usage: string): Promise<void> {
  const resolve = args[0] === "resolve" ? (args.shift(), true) : false;
  const json = takeJsonFlag(args);
  const operationId = takeOption(args, "--operation-id");
  const confirmed = takeFlag(args, "--yes");
  rejectArgs(args, usage);
  if (operationId !== undefined && !OPERATION_ID.test(operationId)) throw new CliUsageError("--operation-id is not a valid operation id", usage);
  if (resolve) {
    if (operationId === undefined) throw new CliUsageError("operations resolve requires --operation-id", usage);
    if (!confirmed) throw new CliUsageError("resolving accepts that the Child may keep what the operation left; pass --yes to confirm", usage);
    const resolved = await request<unknown>("/api/link/operations/" + encodeURIComponent(operationId) + "/resolve", { method: "POST" }, deps);
    printData(resolved, json, [line(resolved)]);
    return;
  }
  if (confirmed) throw new CliUsageError("--yes is only for operations resolve", usage);
  if (operationId !== undefined) {
    const op = await request<unknown>("/api/link/operations/" + encodeURIComponent(operationId), {}, deps);
    printData(op, json, [line(op)]);
    return;
  }
  const list = await request<unknown>("/api/link/operations", {}, deps);
  if (!isRecord(list) || !Array.isArray(list.operations)) throw new Error("invalid link API response: operations");
  printData(list, json, list.operations.length === 0 ? ["No link operations are recorded."] : list.operations.map(line));
}
