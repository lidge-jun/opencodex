import { isConformingToolCallId } from "./tool-call-id";
import type { AdapterEvent, OcxAssistantMessage } from "../types";
import { isTranslatorBudgetExceededError, type TranslatorBudget, type TranslatorTransientReservation } from "../lib/translator-budget";
import { jsonUtf8Bytes } from "../lib/json-byte-size";

type Block = Record<string, unknown>;
export interface AnthropicReplaySnapshot { readonly content: readonly Block[]; release(): void }
const enabled = new WeakSet<Response>();
const terminals = new WeakMap<object, AnthropicReplaySnapshot>();
const pending = new WeakMap<Response, AnthropicReplaySnapshot>();
const owners = new WeakMap<object, Response>();
const issued = new WeakSet<object>();
const messages = new WeakMap<object, AnthropicReplaySnapshot>();
export function enableAnthropicReplayCapture(response: Response): () => void {
  enabled.add(response);
  return () => { enabled.delete(response); pending.get(response)?.release(); pending.delete(response); };
}
export function takeAnthropicReplay(event: object): AnthropicReplaySnapshot | undefined {
  const snapshot = terminals.get(event); terminals.delete(event);
  const owner = owners.get(event); if (owner) pending.delete(owner); owners.delete(event); return snapshot;
}
export function bindAnthropicReplay(message: OcxAssistantMessage, snapshot: AnthropicReplaySnapshot): void {
  if (!issued.has(snapshot)) throw new Error("Untrusted Anthropic replay snapshot");
  messages.set(message, snapshot);
}
/** Top-level copies let cache-control decoration leave the captured provider response untouched. */
export function anthropicReplayContent(message: OcxAssistantMessage): Block[] | undefined {
  const snapshot = messages.get(message);
  if (snapshot && !issued.has(snapshot)) throw new Error("Expired Anthropic replay snapshot");
  return snapshot?.content.map(block => ({ ...block }));
}

/** Capture only explicitly opted-in search streams; no client data can manufacture a snapshot. */
export function createAnthropicReplayCapture(response: Response, budget: TranslatorBudget) {
  if (!enabled.delete(response)) return undefined;
  let bytes = 0, valid = true, transferred = false;
  let active: number | undefined;
  let started = false, stopped = false;
  const toolIds = new Set<string>();
  const blocks: Array<{ value: Block; text: string[]; thinking: string[]; args: string[] }> = [];
  const release = () => { if (bytes) budget.releaseRetained(bytes, { kind: "retained_collectors" }); bytes = 0; };
  const invalidate = () => { valid = false; release(); blocks.length = 0; toolIds.clear(); active = undefined; };
  const retain = (value: unknown) => {
    // Charge each frame once, before retaining its values. This conservative linear bound also
    // covers array/object overhead and replacement signatures without serializing a growing block.
    try {
      const size = jsonUtf8Bytes(value) * 4 + 64;
      budget.chargeRetained(size, { kind: "retained_collectors" }); bytes += size;
      return true;
    } catch (error) {
      if (!isTranslatorBudgetExceededError(error)) throw error;
      invalidate();
      return false;
    }
  };
  return {
    invalidate,
    accept(data: Record<string, unknown>): void {
      if (!valid) return;
      const type = data.type;
      if (type === "ping") return;
      if (type === "message_start") {
        const message = data.message as Block | undefined;
        if (started || (message?.content !== undefined && (!Array.isArray(message.content) || message.content.length > 0))) invalidate();
        else started = true;
        return;
      }
      if (!started || stopped) { invalidate(); return; }
      if (type === "message_stop") { stopped = true; if (active !== undefined) invalidate(); return; }
      if (type === "content_block_start") {
        const block = data.content_block as Block | undefined;
        if (active !== undefined || data.index !== blocks.length || !block
          || !(block.type === "text" && typeof block.text === "string"
            || block.type === "thinking" && typeof block.thinking === "string"
            || block.type === "redacted_thinking" && typeof block.data === "string"
            || block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string"
              && !!block.input && typeof block.input === "object" && !Array.isArray(block.input))) { invalidate(); return; }
        if (block.type === "tool_use") {
          const id = block.id as string;
          if (!isConformingToolCallId(id) || toolIds.has(id)) { invalidate(); return; }
          toolIds.add(id);
        }
        if (!retain(block)) return;
        active = blocks.length;
        blocks.push({ value: { ...block, ...(Array.isArray(block.citations) ? { citations: [...block.citations] } : {}) }, text: typeof block.text === "string" ? [block.text] : [],
          thinking: typeof block.thinking === "string" ? [block.thinking] : [], args: [] });
      } else if (type === "content_block_delta") {
        const delta = data.delta as Block | undefined;
        if (active === undefined || data.index !== active || !delta) { invalidate(); return; }
        const block = blocks[active]!;
        if (!retain(delta)) return;
        if (delta.type === "text_delta" && block.value.type === "text" && typeof delta.text === "string") block.text.push(delta.text);
        else if (delta.type === "thinking_delta" && block.value.type === "thinking" && typeof delta.thinking === "string") block.thinking.push(delta.thinking);
        else if (delta.type === "signature_delta" && block.value.type === "thinking" && typeof delta.signature === "string") block.value.signature = delta.signature;
        else if (delta.type === "input_json_delta" && block.value.type === "tool_use" && typeof delta.partial_json === "string") block.args.push(delta.partial_json);
        else if (delta.type === "citations_delta" && block.value.type === "text" && delta.citation && typeof delta.citation === "object") {
          const citations = block.value.citations;
          if (citations !== undefined && !Array.isArray(citations)) { invalidate(); return; }
          if (citations === undefined) block.value.citations = [delta.citation];
          else (citations as unknown[]).push(delta.citation);
        } else invalidate();
      } else if (type === "content_block_stop") {
        if (active === undefined || data.index !== active) { invalidate(); return; }
        active = undefined;
      } else if (type !== "message_start" && type !== "message_delta" && type !== "message_stop" && type !== "ping") invalidate();
    },
    finish(event: AdapterEvent): void {
      if (!valid || !stopped || active !== undefined || event.type !== "done") { invalidate(); return; }
      let reservation: TranslatorTransientReservation | undefined;
      try {
        reservation = budget.reserveTransient(bytes * 2, { kind: "retained_collectors" });
        const content = blocks.map(block => {
          const value = block.value;
          if (value.type === "text") value.text = block.text.join("");
          if (value.type === "thinking") {
            value.thinking = block.thinking.join("");
            if (typeof value.signature !== "string" || value.signature.length === 0) throw new Error("incomplete thinking signature");
          }
          if (value.type === "tool_use" && block.args.length) {
            value.input = JSON.parse(block.args.join(""));
            if (!value.input || typeof value.input !== "object" || Array.isArray(value.input)) throw new Error("invalid tool input");
          }
          return Object.freeze(value);
        });
        const snapshot = { content: Object.freeze(content), release: () => { issued.delete(snapshot); release(); } };
        issued.add(snapshot);
        terminals.set(event, snapshot); owners.set(event, response); pending.set(response, snapshot);
        blocks.length = 0; toolIds.clear();
        transferred = true;
      } catch { invalidate(); }
      finally { reservation?.release(); }
    },
    discard(): void { if (!transferred) invalidate(); },
  };
}
