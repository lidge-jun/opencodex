import { MuseMspError } from "./connection";

type JsonRecord = Record<string, unknown>;
export type MuseClientTool = string | Readonly<{ name: string; namespace?: string; freeform?: true }>;
export interface CapturedMuseApproval {
  approvalId: string;
  callId: string;
  clientToolName: string;
  clientToolNamespace?: string;
  clientToolFreeform?: true;
  upstreamToolName: string;
  rawArguments: string;
  requirement: { approvalId: string; sourceIndex: number };
  /** A request event needs a JSON-RPC acknowledgement; this is never an approval decision. */
  requestId?: string | number;
  duplicate: boolean;
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes;
}

/** Verify and deduplicate the paired MSP approval notification and server request. */
export class MuseApprovalCapture {
  private readonly seen = new Map<string, string>();
  private readonly callOwners = new Map<string, string>();
  private readonly issued = new WeakSet<CapturedMuseApproval>();
  private readonly claimed = new Set<string>();
  private readonly tools: ReadonlyMap<string, Readonly<{ name: string; namespace?: string; freeform?: true }>>;

  constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    tools: ReadonlyMap<string, MuseClientTool>,
    private readonly maxCalls = 16,
  ) {
    if (!boundedString(sessionId, 512) || !boundedString(turnId, 512) ||
        !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 128 || tools.size > 128) {
      throw new MuseMspError("invalid_approval_scope");
    }
    const normalized = new Map<string, Readonly<{ name: string; namespace?: string; freeform?: true }>>();
    for (const [upstream, client] of tools) {
      const tool = typeof client === "string" ? { name: client } : client;
      if (!boundedString(upstream, 512) || !tool || !boundedString(tool.name, 512) ||
          (tool.namespace !== undefined && !boundedString(tool.namespace, 512))) throw new MuseMspError("invalid_approval_scope");
      if (tool.freeform !== undefined && tool.freeform !== true) throw new MuseMspError("invalid_approval_scope");
      normalized.set(upstream, Object.freeze({ name: tool.name, ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        ...(tool.freeform ? { freeform: true as const } : {}) }));
    }
    this.tools = normalized;
  }

  capture(message: JsonRecord): CapturedMuseApproval | undefined {
    if (message.method !== "approval/requested" && message.method !== "approval/request") return undefined;
    const params = message.params;
    if (!record(params) || params.sessionId !== this.sessionId || params.turnId !== this.turnId ||
        !boundedString(params.approvalId, 512) || !boundedString(params.toolCallId, 512) ||
        !boundedString(params.toolName, 512) || typeof params.rawArgs !== "string" ||
        Buffer.byteLength(params.rawArgs) > 256 * 1024 || !record(params.currentRequirementId) ||
        params.currentRequirementId.approvalId !== params.approvalId ||
        !Number.isSafeInteger(params.currentRequirementId.sourceIndex) ||
        (params.currentRequirementId.sourceIndex as number) < 0 || !Array.isArray(params.availableChoices)) {
      throw new MuseMspError("invalid_approval");
    }
    const clientTool = this.tools.get(params.toolName);
    if (!clientTool) throw new MuseMspError("undeclared_tool");
    if (!params.availableChoices.some(choice => record(choice) && choice.choiceId === "allow_once" &&
        choice.decision === "approved" && choice.scope === "once")) {
      throw new MuseMspError("approval_choice_unavailable");
    }
    let args: unknown;
    try { args = JSON.parse(params.rawArgs); } catch { throw new MuseMspError("invalid_tool_arguments"); }
    if (!record(args)) throw new MuseMspError("invalid_tool_arguments");
    if (clientTool.freeform && (typeof args.input !== "string" || Object.keys(args).length !== 1)) throw new MuseMspError("invalid_tool_arguments");
    let requestId: string | number | undefined;
    if (message.method === "approval/request") {
      if (!((typeof message.id === "number" && Number.isSafeInteger(message.id)) || boundedString(message.id, 512))) {
        throw new MuseMspError("invalid_approval");
      }
      requestId = message.id as string | number;
    } else if ("id" in message) {
      throw new MuseMspError("invalid_approval");
    }
    const requirement = Object.freeze({ approvalId: params.approvalId, sourceIndex: params.currentRequirementId.sourceIndex as number });
    const fingerprint = JSON.stringify([params.toolCallId, params.toolName, params.rawArgs, requirement.sourceIndex]);
    const previous = this.seen.get(params.approvalId);
    const owner = this.callOwners.get(params.toolCallId);
    if ((previous !== undefined && previous !== fingerprint) || (owner !== undefined && owner !== params.approvalId)) {
      throw new MuseMspError("conflicting_approval");
    }
    if (previous === undefined) {
      if (this.seen.size >= this.maxCalls) throw new MuseMspError("too_many_approvals");
      this.seen.set(params.approvalId, fingerprint); this.callOwners.set(params.toolCallId, params.approvalId);
    }
    const captured = Object.freeze({ approvalId: params.approvalId, callId: params.toolCallId, clientToolName: clientTool.name,
      ...(clientTool.namespace === undefined ? {} : { clientToolNamespace: clientTool.namespace }),
      ...(clientTool.freeform ? { clientToolFreeform: true as const } : {}), upstreamToolName: params.toolName,
      rawArguments: params.rawArgs, requirement, ...(requestId === undefined ? {} : { requestId }), duplicate: previous !== undefined });
    this.issued.add(captured);
    return captured;
  }

  /** Claim a validated approval once; never permits an object created by another capture scope. */
  claim(approval: CapturedMuseApproval, sessionId: string, turnId: string): boolean {
    if (sessionId !== this.sessionId || turnId !== this.turnId || !this.issued.has(approval) || this.claimed.has(approval.approvalId)) return false;
    this.claimed.add(approval.approvalId);
    return true;
  }
}
