import { createHash } from "node:crypto";
import { isAuthorizedProviderExecutedCall, type ProviderExecutedCallType } from "../server/responses-undeclared-tool-guard";

// Logical recency avoids clock adjustments and ties between messages in one millisecond.
let activityOrder = 0;
const MAX_PENDING_RESULTS = 1024;
const MAX_RESULT_ID_LENGTH = 1024;
const resultTypes: Readonly<Record<string, string>> = {
  function_call: "function_call_output",
  custom_tool_call: "custom_tool_call_output",
  local_shell_call: "function_call_output",
  shell_call: "shell_call_output",
  computer_call: "computer_call_output",
  apply_patch_call: "apply_patch_call_output",
  tool_search_call: "tool_search_output",
  mcp_approval_request: "mcp_approval_response",
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultKey(type: string, id: string): string {
  return createHash("sha256").update(JSON.stringify([type, id])).digest("hex");
}

/** Content-free activity owned by one admitted incoming Responses socket. */
export class CodexWebSocketActivity {
  lastUsed = ++activityOrder;
  closing = false;
  private turns = 0;
  private pendingResults = new Set<string>();
  private returnedResults = new Set<string>();
  // Hashed identities only; null marks a route-authorized provider-owned call.
  private argumentCalls = new Map<string, { type: string; result: string | null }>();
  // Unknown/oversized identities cannot safely prove that client work finished.
  private untrackedResults = false;

  get idle(): boolean {
    return !this.closing && this.turns === 0 && this.pendingResults.size === 0 && !this.untrackedResults;
  }

  touch(): void {
    this.lastUsed = ++activityOrder;
  }

  /** Each turn retains its own busy reference, including superseded async cleanup. */
  beginTurn(input: unknown): () => void {
    this.turns += 1;
    this.touch();
    this.acceptResults(input);
    // Ordinary creates start a new response even when its upstream omits response.created.
    // Prior results settle old waits, but cannot suppress new calls reusing their IDs.
    this.returnedResults.clear();
    this.argumentCalls.clear();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.turns -= 1;
      if (this.turns === 0) this.touch();
    };
  }

  /** Called only after admission or native control accepts the client's results. */
  acceptResults(input: unknown): void {
    if (this.untrackedResults) return;
    if (Array.isArray(input)) {
      for (const item of input) {
        if (!record(item) || typeof item.type !== "string") continue;
        const id = item.type === "mcp_approval_response" ? item.approval_request_id : item.call_id;
        if (typeof id === "string" && id.length <= MAX_RESULT_ID_LENGTH) {
          // Ordinary Codex shell results use function_call_output; native steering
          // also accepts its explicit local_shell_call_output continuation stub.
          const type = item.type === "local_shell_call_output" ? "function_call_output" : item.type;
          const key = resultKey(type, id);
          if (this.pendingResults.delete(key)) {
            if (this.returnedResults.size >= MAX_PENDING_RESULTS) { this.protectUntracked(); return; }
            else this.returnedResults.add(key);
          }
        }
      }
    }
  }

  /** Preserve tool waits even when the response terminal omits its output array. */
  observePayload(payload: string, providerExecuted?: ReadonlySet<ProviderExecutedCallType>): void {
    if (this.untrackedResults) return;
    let frame: unknown;
    try { frame = JSON.parse(payload); } catch { return; }
    if (!record(frame)) return;
    // Native injection can return a result before the same terminal repeats its call.
    if (frame.type === "response.created") {
      this.returnedResults.clear();
      this.argumentCalls.clear();
    }
    if (frame.type === "response.output_item.added") this.rememberArgumentCall(frame.item, providerExecuted);
    if (frame.type === "response.function_call_arguments.done" || frame.type === "response.custom_tool_call_input.done") {
      const type = frame.type === "response.function_call_arguments.done" ? "function_call" : "custom_tool_call";
      const call = typeof frame.item_id === "string" && frame.item_id.length <= MAX_RESULT_ID_LENGTH
        ? this.argumentCalls.get(resultKey("item", frame.item_id)) : undefined;
      if (!call || call.type !== type) this.protectUntracked();
      else if (call.result !== null) this.observeResultKey(call.result);
    }
    if (frame.type === "response.output_item.done") this.observeOutput(frame.item, providerExecuted);
    if (["response.completed", "response.incomplete", "response.failed"].includes(String(frame.type))
      && record(frame.response) && Array.isArray(frame.response.output)) {
      for (const item of frame.response.output) this.observeOutput(item, providerExecuted);
    }
  }

  private rememberArgumentCall(item: unknown, providerExecuted?: ReadonlySet<ProviderExecutedCallType>): void {
    if (!record(item) || (item.type !== "function_call" && item.type !== "custom_tool_call")) return;
    if (typeof item.id !== "string" || !item.id.length || item.id.length > MAX_RESULT_ID_LENGTH) return;
    const key = resultKey("item", item.id);
    const hosted = providerExecuted && isAuthorizedProviderExecutedCall(item, providerExecuted);
    if (!hosted && (typeof item.call_id !== "string" || !item.call_id.length || item.call_id.length > MAX_RESULT_ID_LENGTH)) {
      if (this.argumentCalls.has(key)) this.protectUntracked();
      return;
    }
    const result = hosted ? null : resultKey(resultTypes[item.type]!, item.call_id as string);
    const previous = this.argumentCalls.get(key);
    if (previous) {
      if (previous.type !== item.type || previous.result !== result) this.protectUntracked();
      return;
    }
    if (this.argumentCalls.size >= MAX_PENDING_RESULTS) { this.protectUntracked(); return; }
    // An unfinished argument stream alone does not prove the client started work.
    this.argumentCalls.set(key, { type: item.type, result });
  }

  private observeOutput(item: unknown, providerExecuted?: ReadonlySet<ProviderExecutedCallType>): void {
    if (this.untrackedResults) return;
    if (!record(item) || typeof item.type !== "string") return;
    // Hosted execution may publish both the call and its result in the output stream.
    this.acceptResults([item]);
    if (!Object.hasOwn(resultTypes, item.type)) return;
    if (providerExecuted && isAuthorizedProviderExecutedCall(item, providerExecuted)) return;
    if (item.type === "tool_search_call" && item.execution !== "client") return;
    const id = item.type === "mcp_approval_request" ? item.id
      : item.type === "local_shell_call" || item.type === "tool_search_call" ? item.call_id ?? item.id : item.call_id;
    if (typeof id !== "string" || !id.length || id.length > MAX_RESULT_ID_LENGTH) {
      this.protectUntracked();
      return;
    }
    this.observeResultKey(resultKey(resultTypes[item.type]!, id));
  }

  private observeResultKey(key: string): void {
    if (this.pendingResults.has(key) || this.returnedResults.has(key)) return;
    if (this.pendingResults.size >= MAX_PENDING_RESULTS) this.protectUntracked();
    else this.pendingResults.add(key);
  }

  private protectUntracked(): void {
    this.untrackedResults = true;
    this.pendingResults.clear();
    this.returnedResults.clear();
    this.argumentCalls.clear();
  }
}
