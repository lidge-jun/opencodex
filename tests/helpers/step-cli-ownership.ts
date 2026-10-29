import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import type { IncomingMeta } from "../../src/adapters/base";
import type { StepConversationHost, StepConversationSession, StepHeldTool } from "../../src/adapters/step-cli/session-pool";
import type { StepFrame } from "../../src/adapters/step-cli/stdio-frames";
import { handleReverseRequest, handleRuntimeEvent } from "../../src/adapters/step-cli/events";
import { endTurn } from "../../src/adapters/step-cli/registry";

export const provider: OcxProviderConfig = { adapter: "step-cli", baseUrl: "https://api.stepfun.com/step_plan", authMode: "key" };
export const incoming = { headers: new Headers({ "thread-id": "shared" }) } as IncomingMeta;
export const user: OcxMessage[] = [{ role: "user", content: "synthetic request", timestamp: 0 }];
export function parsed(principal: string, messages = user): OcxParsedRequest {
  return {
    modelId: "step-5-preview", context: { messages, tools: [{ name: "shell", description: "run", parameters: { type: "object" } }] },
    options: {}, _reasoningReplayScope: { clientPrincipalId: principal, clientThreadId: "shared" },
  };
}
export function event(queryId: string | undefined, message: Record<string, unknown>): StepFrame {
  return { protocol: "step-agent-sdk", version: 1, kind: "event", id: "evt", method: "query.message", sequence: 1, payload: { queryId, message } };
}
export function request(id: string, payload: Record<string, unknown>, method = "sdk_tool.invoke"): StepFrame {
  return { protocol: "step-agent-sdk", version: 1, kind: "request", id, method, payload };
}
export class Session implements StepConversationSession {
  sessionId = "synthetic-session";
  closed = false;
  delivered: Array<{ frame: StepFrame; result: unknown }> = [];
  inputs: Array<{ queryId: string; text: string }> = [];
  allowed: string[] = [];
  denied: string[] = [];
  refused: string[] = [];
  next = 0;
  capture = true;
  async handshake(): Promise<StepFrame> { return { protocol: "step-agent-sdk", version: 1, kind: "response", id: "init" }; }
  async startQuery() { return { queryId: `q_${++this.next}`, sessionId: this.sessionId }; }
  async sendInput(queryId: string, text: string) {
    this.inputs.push({ queryId, text });
    queueMicrotask(() => {
      if (this.capture) handleReverseRequest(this, request("held", { queryId, serverName: "ocx", toolName: "shell", toolUseId: "call-1", input: {} }));
      else handleRuntimeEvent(this, event(queryId, { type: "status", status: "turn_complete" }));
    });
  }
  async endInput() {}
  async interrupt() {}
  async close() { this.closed = true; endTurn(this); }
  allowPermission(frame: StepFrame) { this.allowed.push(frame.id); }
  denyPermission(frame: StepFrame) { this.denied.push(frame.id); }
  refuseToolCall(frame: StepFrame) { this.refused.push(frame.id); }
  resolveHeldToolResult(frame: StepFrame, result: unknown) {
    this.delivered.push({ frame, result });
    queueMicrotask(() => handleRuntimeEvent(this, event("q_1", { type: "status", status: "turn_complete" })));
    return true;
  }
}
export function host(): StepConversationHost & { entries: Map<string, Session> } {
  const entries = new Map<string, Session>();
  const held = new Map<string, StepHeldTool>();
  return {
    entries, get: ref => ref ? entries.get(ref.handle) : undefined,
    open: async ref => {
      let session = entries.get(ref.handle);
      if (!session) { session = new Session(); entries.set(ref.handle, session); }
      return session;
    },
    nextRef: () => ({ handle: `fresh-${entries.size}`, sessionId: "" }),
    rememberHeldTool: (ref, value) => { held.set(ref.handle, value); },
    takeHeldTool: ref => { const value = held.get(ref.handle); held.delete(ref.handle); return value; },
    closeAll: async () => { for (const session of entries.values()) await session.close(); },
  };
}
export function attachTurn(session: Session, emit: (event: AdapterEvent) => void) {
  return { ref: { handle: "test", sessionId: "" }, pool: host(), emit, settle: () => {}, emittedNames: new Map([["ocx__shell", "shell"]]), catalogKey: "catalog" };
}
