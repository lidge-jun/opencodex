import { MuseMspError } from "./connection";
import type { CapturedMuseApproval, MuseApprovalCapture } from "./approval";
import type { MuseMspSession } from "./session";
import type { MuseCaptureRendezvous } from "./capture-rendezvous";
import type { MusePendingRegistry } from "./pending-registry";

/**
 * Stage a capture-only MCP handoff before admitting an MSP approval. The owner and
 * history digest must be independently derived by the authenticated request handler.
 * The caller owns session shutdown and must never use this for an executable MCP server.
 */
export async function admitMuseCapturedTool(input: {
  session: MuseMspSession;
  turnId: string;
  capture: MuseApprovalCapture;
  approval: CapturedMuseApproval;
  registry: MusePendingRegistry;
  rendezvous: MuseCaptureRendezvous;
  owner: string;
  historyDigest: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ clientCallId: string; name: string; namespace?: string; freeform?: true; arguments: string }> {
  const { approval } = input;
  const prefix = "mcp__opencodex__";
  if (approval.duplicate || !approval.upstreamToolName.startsWith(prefix)) throw new MuseMspError("invalid_capture_approval");
  const name = approval.upstreamToolName.slice(prefix.length);
  let args: Record<string, unknown>;
  try { args = JSON.parse(approval.rawArguments); }
  catch { throw new MuseMspError("invalid_capture_approval"); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  let result: Promise<unknown> | undefined;
  try {
    const pending = input.registry.register(input.owner, approval.callId, input.historyDigest,
      { timeoutMs: input.timeoutMs, signal: controller.signal });
    result = pending.result;
    void result.then(() => input.signal?.removeEventListener("abort", abort), () => input.signal?.removeEventListener("abort", abort));
    input.rendezvous.expect({ callId: approval.callId, name, arguments: args }, pending.result);
    const admission = input.session.admitCapture(input.turnId, input.capture, approval,
      { timeoutMs: input.timeoutMs, signal: controller.signal });
    const expired = pending.result.then(() => new Promise<never>(() => {}), error => { throw error; });
    await Promise.race([admission, expired]);
    if (controller.signal.aborted) throw new MuseMspError("cancelled");
    return { clientCallId: pending.clientCallId, name: approval.clientToolName,
      ...(approval.clientToolNamespace === undefined ? {} : { namespace: approval.clientToolNamespace }),
      ...(approval.clientToolFreeform ? { freeform: true as const } : {}), arguments: approval.rawArguments };
  } catch (error) {
    controller.abort();
    if (!result) input.signal?.removeEventListener("abort", abort);
    throw error;
  }
}
