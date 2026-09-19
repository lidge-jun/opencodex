import type { AdapterEvent } from "../types";
import { modelInList } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";

type ThinkingTag = "<thinking>" | "<think>" | "<reasoning>";
type ParserState = "pre" | "thinking" | "scanning" | "streaming";

const OPEN_TAGS: ThinkingTag[] = ["<thinking>", "<think>", "<reasoning>"];
const MAX_OPEN_TAG = Math.max(...OPEN_TAGS.map(t => t.length));
const MAX_CLOSE_TAG = Math.max(...OPEN_TAGS.map(t => `</${t.slice(1)}`.length));

function closeTagFor(openTag: ThinkingTag): string {
  return `</${openTag.slice(1)}`;
}

function isPossibleOpenTagPrefix(text: string): boolean {
  return OPEN_TAGS.some(tag => tag.startsWith(text) && text.length < tag.length);
}

/** Move a send boundary back one unit rather than splitting a surrogate pair into U+FFFD. */
function surrogateSafeCut(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return Math.max(0, Math.min(cut, text.length));
  const atCut = text.charCodeAt(cut - 1);
  return atCut >= 0xd800 && atCut <= 0xdbff ? cut - 1 : cut;
}

export interface InlineThinkTagOptions {
  /**
   * Keep scanning for further think blocks after the first one closes. Kiro emits a single
   * leading block, so it leaves this off and streams the rest verbatim. MiniMax M-series
   * interleaves several blocks with answer segments, so a reusing adapter opts in.
   */
  interleaved?: boolean;
}

/**
 * Recovers thinking that a gateway left inline in visible content as `<think>` blocks instead of
 * a separate `reasoning_content` / `reasoning_details` field. Shared by the Kiro adapter and by
 * the openai-chat adapter's opt-in `inlineThinkTagModels`.
 */
export class InlineThinkTagParser {
  private state: ParserState = "pre";
  private preBuffer = "";
  private thinkingBuffer = "";
  private closeTag = "";

  private readonly interleaved: boolean;

  constructor(private readonly budget?: TranslatorBudget, options?: InlineThinkTagOptions) {
    this.interleaved = options?.interleaved === true;
  }

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
    if (this.state === "scanning") {
      this.replaceCarry("preBuffer", this.preBuffer + text);
      return this.drainScanning();
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
      const events: AdapterEvent[] = [];
      if (thinking) events.push({ type: "reasoning_raw_delta", text: thinking });
      if (this.interleaved) {
        this.state = "scanning";
        this.replaceCarry("preBuffer", after);
        events.push(...this.drainScanning());
      } else {
        this.state = "streaming";
        if (after) events.push({ type: "text_delta", text: after });
      }
      return events;
    }
    if (this.thinkingBuffer.length <= MAX_CLOSE_TAG) return [];
    // Hold back a possible partial close tag, and never split a surrogate pair
    // at the send boundary: a lone high surrogate encodes as U+FFFD.
    const cut = surrogateSafeCut(this.thinkingBuffer, this.thinkingBuffer.length - MAX_CLOSE_TAG);
    const send = this.thinkingBuffer.slice(0, cut);
    this.replaceCarry("thinkingBuffer", this.thinkingBuffer.slice(cut));
    return send ? [{ type: "reasoning_raw_delta", text: send }] : [];
  }

  /**
   * Interleaved mode only: the response already proved it carries inline thinking, so a later
   * block can open anywhere in the answer text rather than only at the start.
   */
  private drainScanning(): AdapterEvent[] {
    const events: AdapterEvent[] = [];
    for (;;) {
      let openIndex = -1;
      let openTag: ThinkingTag | undefined;
      for (const tag of OPEN_TAGS) {
        const index = this.preBuffer.indexOf(tag);
        if (index >= 0 && (openIndex < 0 || index < openIndex)) {
          openIndex = index;
          openTag = tag;
        }
      }
      if (openIndex >= 0 && openTag) {
        const before = this.preBuffer.slice(0, openIndex);
        if (before) events.push({ type: "text_delta", text: before });
        this.state = "thinking";
        this.closeTag = closeTagFor(openTag);
        this.replaceCarry("thinkingBuffer", this.preBuffer.slice(openIndex + openTag.length));
        this.replaceCarry("preBuffer", "");
        events.push(...this.drainThinking());
        // drainThinking returns to "scanning" only when that block closed inside this chunk.
        if ((this.state as ParserState) !== "scanning") return events;
        continue;
      }
      // Hold back only as much as a partial open tag could occupy.
      const cut = surrogateSafeCut(this.preBuffer, this.preBuffer.length - (MAX_OPEN_TAG - 1));
      if (cut > 0) {
        events.push({ type: "text_delta", text: this.preBuffer.slice(0, cut) });
        this.replaceCarry("preBuffer", this.preBuffer.slice(cut));
      }
      return events;
    }
  }
}

/** Visible-content splitter the openai-chat adapter holds for the life of one response. */
export interface InlineThinkContentSplitter {
  feed(text: string): AdapterEvent[];
  flush(): AdapterEvent[];
  dispose(): void;
}

const PASSTHROUGH: InlineThinkContentSplitter = {
  feed: text => [{ type: "text_delta", text }],
  flush: () => [],
  dispose: () => { /* nothing carried */ },
};

/**
 * Opt-in recovery for `inlineThinkTagModels`. A model that is not listed gets a passthrough that
 * never inspects or rewrites visible content, so the 66 registry providers sharing the openai-chat
 * adapter keep byte-exact behavior.
 */
export function createInlineThinkContentSplitter(
  models: string[] | undefined,
  modelId: string | undefined,
  budget?: TranslatorBudget,
): InlineThinkContentSplitter {
  if (!modelInList(models, modelId ?? "")) return PASSTHROUGH;
  const parser = new InlineThinkTagParser(budget, { interleaved: true });
  return {
    // An empty content delta stays an empty delta: it is a wire signal, not thinking.
    feed: text => (text.length === 0 ? [{ type: "text_delta", text }] : parser.feed(text)),
    flush: () => parser.flush(),
    dispose: () => parser.dispose(),
  };
}

/** One-shot form for a non-streaming response body. */
export function splitInlineThinkContent(
  models: string[] | undefined,
  modelId: string | undefined,
  budget: TranslatorBudget | undefined,
  content: string,
): AdapterEvent[] {
  const splitter = createInlineThinkContentSplitter(models, modelId, budget);
  const events = [...splitter.feed(content), ...splitter.flush()];
  splitter.dispose();
  return events;
}
