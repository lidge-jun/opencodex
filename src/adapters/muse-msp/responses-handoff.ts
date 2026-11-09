import type { OcxParsedRequest } from "../../types";
import { MuseMspError } from "./connection";
import { museContinuation, museHistoryDigest } from "./history";
import { museContinuationOwner } from "./owner";
import { admitMuseCapturedTool } from "./admit-tool";
import type { CapturedMuseApproval, MuseApprovalCapture } from "./approval";
import type { MuseMspSession } from "./session";
import type { MuseCaptureRendezvous } from "./capture-rendezvous";
import type { MusePendingRegistry } from "./pending-registry";
import type { MuseToolResult } from "./tool-result";

/**
 * Internal bridge for a route-bound, ingress-authenticated parsed request. Neither
 * method authenticates HTTP on its own; the router must attach trusted replay scope
 * after authentication and bind the physical route before invoking it.
 */
export class MuseResponsesHandoff {
  constructor(private readonly registry: MusePendingRegistry) {}

  async admit(input: {
    parsed: OcxParsedRequest; session: MuseMspSession; turnId: string;
    capture: MuseApprovalCapture; approval: CapturedMuseApproval; rendezvous: MuseCaptureRendezvous;
    timeoutMs: number; signal?: AbortSignal; preToolText?: string;
  }): Promise<{ clientCallId: string; name: string; namespace?: string; freeform?: true; arguments: string }> {
    const owner = museContinuationOwner(input.parsed);
    if (!owner) throw new MuseMspError("unavailable_continuation");
    let args: Record<string, unknown>;
    try { args = JSON.parse(input.approval.rawArguments); }
    catch { throw new MuseMspError("invalid_capture_approval"); }
    const context = input.preToolText ? { ...input.parsed.context, messages: [...input.parsed.context.messages,
      { role: "assistant" as const, content: [{ type: "text" as const, text: input.preToolText }], phase: "commentary" as const,
        model: input.parsed.modelId, timestamp: 0 }] } : input.parsed.context;
    const historyDigest = museHistoryDigest(context, input.approval.clientToolName, args, input.approval.clientToolNamespace, input.approval.clientToolFreeform);
    return admitMuseCapturedTool({ ...input, registry: this.registry, owner, historyDigest });
  }

  submit(parsed: OcxParsedRequest, beforeCommit?: (result: Readonly<MuseToolResult>) => void): void {
    const owner = museContinuationOwner(parsed);
    if (!owner) throw new MuseMspError("unavailable_continuation");
    const continuation = museContinuation(parsed.context);
    this.registry.submit(owner, continuation.clientCallId, continuation.historyDigest, continuation.output, beforeCommit);
  }
}
