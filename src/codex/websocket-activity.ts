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

function resultKeyOfItem(item: unknown): string | null {
  if (!record(item) || typeof item.type !== "string") return null;
  const id = item.type === "mcp_approval_response" ? item.approval_request_id : item.call_id;
  if (typeof id !== "string" || id.length > MAX_RESULT_ID_LENGTH) return null;
  return resultKey(item.type === "local_shell_call_output" ? "function_call_output" : item.type, id);
}

/** The hashed result keys an input returns, in the tracker's own encoding (content-free). */
export function resultKeysOf(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map(resultKeyOfItem).filter((key): key is string => key !== null);
}

/** Content-free activity owned by one admitted incoming Responses socket. */
export class CodexWebSocketActivity {
  lastUsed = ++activityOrder;
  private closingFlag = false;
  private turns = 0;
  private pendingResults = new Set<string>();
  private returnedResults = new Set<string>();
  // Hashed identities only; null marks a route-authorized provider-owned call.
  private argumentCalls = new Map<string, { type: string; result: string | null }>();
  // Unknown/oversized identities cannot safely prove that client work finished.
  private untrackedResults = false;
  // Remote Link sockets observe their own activity; local sockets register nothing.
  private listeners: Array<() => void> = [];
  private acceptedListeners: Array<(input: unknown) => void> = [];
  private beginListeners: Array<(input: unknown) => void> = [];
  /**
   * Remote Link sockets only: a turn the shared handler never reports as accepted (notifyAccepted)
   * puts the results it settled back to pending when it finishes, so a refused or failed turn cannot
   * make unfinished client work look done. Local sockets keep settling at admission.
   */
  restoreRefusedResults = false;
  private turnRecords = new Map<unknown, { seq: number; settled: string[]; accepted: boolean }>();
  private turnSeq = 0;
  // Keys an unaccepted turn put back, with that turn's sequence; a key observed again as new work
  // loses its marker, so a late acceptance of an older turn never settles newer work.
  private restoredKeys = new Map<string, number>();

  get closing(): boolean { return this.closingFlag; }

  set closing(value: boolean) {
    if (this.closingFlag === value) return;
    this.closingFlag = value;
    this.changed();
  }

  get idle(): boolean {
    return !this.closing && this.turns === 0 && this.pendingResults.size === 0 && !this.untrackedResults;
  }

  /** A turn admitted on this socket has not finished, superseded cleanup included. */
  get running(): boolean { return this.turns > 0; }

  /** How many admitted turns have not finished, superseded cleanup included. */
  get runningTurns(): number { return this.turns; }

  /** The hashed keys of the results this socket is waiting for (content-free). */
  pendingKeys(): string[] { return [...this.pendingResults]; }

  /** Identities overflowed or were ambiguous: completion of client work cannot be proved. */
  get untracked(): boolean { return this.untrackedResults; }

  /** Read-only: whether this input returns at least one result the socket is waiting for. */
  returnsPending(input: unknown): boolean {
    if (this.untrackedResults || !Array.isArray(input)) return false;
    for (const item of input) {
      const key = this.resultKeyOf(item);
      if (key !== null && this.pendingResults.has(key)) return true;
    }
    return false;
  }

  /** Called after any change that can move idle, running or the pending set. */
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(candidate => candidate !== listener); };
  }

  /** Called with a turn's input when it begins (Remote Link: the hold sequence a later acceptance may settle up to). */
  onBegin(listener: (input: unknown) => void): () => void {
    this.beginListeners.push(listener);
    return () => { this.beginListeners = this.beginListeners.filter(candidate => candidate !== listener); };
  }

  /**
   * Called with a turn's input once the shared handler got a successful response for it, after turn,
   * workflow and pipeline admission (notifyAccepted). Never for a warmup or any refusal.
   */
  onAccepted(listener: (input: unknown) => void): () => void {
    this.acceptedListeners.push(listener);
    return () => { this.acceptedListeners = this.acceptedListeners.filter(candidate => candidate !== listener); };
  }

  /** The shared handler's turn was accepted by every admission and the pipeline answered ok. */
  notifyAccepted(input: unknown): void {
    const record = this.turnRecords.get(input);
    if (record) record.accepted = true;
    // Only sockets that restore refused results (Remote Link) reconcile, and only against turns that
    // began before the accepted one: newer turns own newer work, even when it reuses a call id.
    const returned = new Set(this.restoreRefusedResults && record ? resultKeysOf(input) : []);
    if (record && returned.size) {
      // An older turn still finishing (superseded, refused) must not put these results back...
      for (const other of this.turnRecords.values()) {
        if (other.seq < record.seq) other.settled = other.settled.filter(key => !returned.has(key));
      }
      // ...and one an older turn already put back is settled again.
      let changed = false;
      for (const key of returned) {
        const by = this.restoredKeys.get(key);
        if (by !== undefined && by < record.seq && this.pendingResults.delete(key)) {
          this.restoredKeys.delete(key);
          // Not added to returnedResults: like beginTurn, a settled wait never suppresses a later
          // call that reuses its id, even from an upstream that omits response.created.
          changed = true;
        }
      }
      if (changed) this.changed();
    }
    for (const listener of [...this.acceptedListeners]) {
      try { listener(input); } catch { /* an observer never breaks the socket's own bookkeeping */ }
    }
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* an observer never breaks the socket's own bookkeeping */ }
    }
  }

  private resultKeyOf(item: unknown): string | null { return resultKeyOfItem(item); }

  touch(): void {
    this.lastUsed = ++activityOrder;
  }

  /** Each turn retains its own busy reference, including superseded async cleanup. */
  beginTurn(input: unknown): () => void {
    this.turns += 1;
    this.touch();
    const record = { seq: ++this.turnSeq, settled: this.settleResults(input), accepted: false };
    if (this.restoreRefusedResults) this.turnRecords.set(input, record);
    for (const listener of [...this.beginListeners]) {
      try { listener(input); } catch { /* an observer never breaks the socket's own bookkeeping */ }
    }
    // Ordinary creates start a new response even when its upstream omits response.created.
    // Prior results settle old waits, but cannot suppress new calls reusing their IDs.
    this.returnedResults.clear();
    this.argumentCalls.clear();
    let finished = false;
    this.changed();
    return () => {
      if (finished) return;
      finished = true;
      if (this.turnRecords.get(input) === record) this.turnRecords.delete(input);
      if (this.restoreRefusedResults && !record.accepted) this.restoreResults(record.settled, record.seq);
      this.turns -= 1;
      if (this.turns === 0) this.touch();
      this.changed();
    };
  }

  /** Called only after admission or native control accepts the client's results. */
  acceptResults(input: unknown): void {
    if (this.settleResults(input).length) this.changed();
  }

  /** Settles returned results; the keys taken off the pending set. Notifies nobody. */
  private settleResults(input: unknown): string[] {
    const settled: string[] = [];
    if (this.untrackedResults) return settled;
    if (Array.isArray(input)) {
      for (const item of input) {
        // Ordinary Codex shell results use function_call_output; native steering
        // also accepts its explicit local_shell_call_output continuation stub.
        const key = this.resultKeyOf(item);
        if (key !== null && this.pendingResults.delete(key)) {
          settled.push(key);
          this.restoredKeys.delete(key);
          if (this.returnedResults.size >= MAX_PENDING_RESULTS) { this.protectUntracked(); return []; }
          else this.returnedResults.add(key);
        }
      }
    }
    return settled;
  }

  /** A refused turn's results are owed again (restoreRefusedResults). */
  private restoreResults(keys: readonly string[], seq: number): void {
    if (this.untrackedResults) return;
    for (const key of keys) {
      // Already pending means newer work under the same key: it keeps its own generation, untagged.
      if (this.pendingResults.has(key)) continue;
      this.returnedResults.delete(key);
      if (this.pendingResults.size >= MAX_PENDING_RESULTS) { this.protectUntracked(); return; }
      this.pendingResults.add(key);
      this.restoredKeys.set(key, seq);
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
    // On a Remote Link socket only an accepted client turn returns a client result: provider-executed
    // calls never become pending, so an upstream output settling one would be ambiguous (design 5).
    if (!this.restoreRefusedResults) this.acceptResults([item]);
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
    // A call observed now is new work, whatever an older turn restored under the same key.
    this.restoredKeys.delete(key);
    // An in-flight turn may still restore an earlier call under this id. The key cannot tell the two
    // generations apart, so the socket's results become untracked: its close leaves an operator-only
    // hold rather than possibly forgetting either piece of owed work (Remote Link sockets only).
    if (this.restoreRefusedResults) {
      for (const record of this.turnRecords.values()) {
        if (record.settled.includes(key)) { this.protectUntracked(); return; }
      }
    }
    if (this.pendingResults.has(key) || this.returnedResults.has(key)) return;
    if (this.pendingResults.size >= MAX_PENDING_RESULTS) this.protectUntracked();
    else { this.pendingResults.add(key); this.changed(); }
  }

  private protectUntracked(): void {
    this.untrackedResults = true;
    this.pendingResults.clear();
    this.returnedResults.clear();
    this.argumentCalls.clear();
    this.changed();
  }
}
