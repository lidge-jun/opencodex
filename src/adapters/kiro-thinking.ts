import type { AdapterEvent } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";

type ThinkingTag = "<thinking>" | "<think>" | "<reasoning>";
type ParserState = "pre" | "thinking" | "streaming";

const OPEN_TAGS: ThinkingTag[] = ["<thinking>", "<think>", "<reasoning>"];
const MAX_OPEN_TAG = Math.max(...OPEN_TAGS.map(t => t.length));
const MAX_CLOSE_TAG = Math.max(...OPEN_TAGS.map(t => `</${t.slice(1)}`.length));

function closeTagFor(openTag: ThinkingTag): string {
  return `</${openTag.slice(1)}`;
}

function isPossibleOpenTagPrefix(text: string): boolean {
  return OPEN_TAGS.some(tag => tag.startsWith(text) && text.length < tag.length);
}

export class KiroThinkingParser {
  private state: ParserState = "pre";
  private preBuffer = "";
  private thinkingBuffer = "";
  private closeTag = "";

  constructor(private readonly budget?: TranslatorBudget) {}

  private replaceCarry(field: "preBuffer" | "thinkingBuffer", next: string): void {
    const previous = this[field];
    if (previous === next) return;
    const previousBytes = Buffer.byteLength(previous);
    const nextBytes = Buffer.byteLength(next);
    const reservation = this.budget?.reserveTransient(nextBytes, { kind: "reasoning" });
    this[field] = next;
    reservation?.commitRetained();
    this.budget?.releaseRetained(previousBytes, { kind: "reasoning" });
  }

  feed(text: string): AdapterEvent[] {
    if (!text) return [];
    if (this.state === "streaming") return [{ type: "text_delta", text }];
    if (this.state === "thinking") {
      this.replaceCarry("thinkingBuffer", this.thinkingBuffer + text);
      return this.drainThinking();
    }
    this.replaceCarry("preBuffer", this.preBuffer + text);
    const stripped = this.preBuffer.trimStart();
    const openTag = OPEN_TAGS.find(tag => stripped.startsWith(tag));
    if (openTag) {
      this.state = "thinking";
      this.closeTag = closeTagFor(openTag);
      this.replaceCarry("thinkingBuffer", stripped.slice(openTag.length));
      this.replaceCarry("preBuffer", "");
      return this.drainThinking();
    }
    if (stripped.length <= MAX_OPEN_TAG && isPossibleOpenTagPrefix(stripped)) return [];
    this.state = "streaming";
    const out = this.preBuffer;
    this.replaceCarry("preBuffer", "");
    return out ? [{ type: "text_delta", text: out }] : [];
  }

  flush(): AdapterEvent[] {
    if (this.state === "thinking") {
      const out = this.thinkingBuffer;
      this.replaceCarry("thinkingBuffer", "");
      this.state = "streaming";
      return out ? [{ type: "reasoning_raw_delta", text: out }] : [];
    }
    if (this.preBuffer) {
      const out = this.preBuffer;
      this.replaceCarry("preBuffer", "");
      this.state = "streaming";
      return [{ type: "text_delta", text: out }];
    }
    return [];
  }

  /** Release any partial tag/content carry when the owning stream stops early. */
  dispose(): void {
    this.replaceCarry("preBuffer", "");
    this.replaceCarry("thinkingBuffer", "");
    this.closeTag = "";
    this.state = "streaming";
  }

  private drainThinking(): AdapterEvent[] {
    const close = this.closeTag;
    const idx = this.thinkingBuffer.indexOf(close);
    if (idx >= 0) {
      const thinking = this.thinkingBuffer.slice(0, idx);
      const after = this.thinkingBuffer.slice(idx + close.length).trimStart();
      this.replaceCarry("thinkingBuffer", "");
      this.state = "streaming";
      const events: AdapterEvent[] = [];
      if (thinking) events.push({ type: "reasoning_raw_delta", text: thinking });
      if (after) events.push({ type: "text_delta", text: after });
      return events;
    }
    if (this.thinkingBuffer.length <= MAX_CLOSE_TAG) return [];
    // Never split a surrogate pair at the send boundary: a lone high
    // surrogate at the end of one delta encodes as U+FFFD. Move the cut one
    // unit earlier so the whole pair stays in the carry.
    let cut = this.thinkingBuffer.length - MAX_CLOSE_TAG;
    if (cut > 0 && cut < this.thinkingBuffer.length) {
      const atCut = this.thinkingBuffer.charCodeAt(cut - 1);
      if (atCut >= 0xd800 && atCut <= 0xdbff) cut -= 1;
    }
    const send = this.thinkingBuffer.slice(0, cut);
    this.replaceCarry("thinkingBuffer", this.thinkingBuffer.slice(cut));
    return send ? [{ type: "reasoning_raw_delta", text: send }] : [];
  }
}
