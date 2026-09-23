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
  private preWhitespaceChunks: string[] = [];
  private preWhitespaceLength = 0;
  private preWhitespaceBytes = 0;
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

  private appendPreWhitespace(text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    const reservation = this.budget?.reserveTransient(bytes, { kind: "reasoning" });
    this.preWhitespaceChunks.push(text);
    this.preWhitespaceLength += text.length;
    this.preWhitespaceBytes += bytes;
    reservation?.commitRetained();
  }

  private finishPreWhitespace(emit: boolean): string {
    if (this.preWhitespaceLength === 0) return "";
    const reservation = emit ? this.budget?.reserveTransient(this.preWhitespaceBytes, { kind: "reasoning" }) : undefined;
    try {
      return emit ? this.preWhitespaceChunks.join("") : "";
    } finally {
      this.preWhitespaceChunks.length = 0;
      this.preWhitespaceLength = 0;
      this.budget?.releaseRetained(this.preWhitespaceBytes, { kind: "reasoning" });
      this.preWhitespaceBytes = 0;
      reservation?.release();
    }
  }

  feed(text: string): AdapterEvent[] {
    if (!text) return [];
    if (this.state === "streaming") return [{ type: "text_delta", text }];
    let input = text;
    if (this.state === "pre") {
      if (this.preBuffer) {
        input = this.preBuffer + text;
        this.replaceCarry("preBuffer", "");
      } else {
        const stripped = text.trimStart();
        const leadingLength = text.length - stripped.length;
        if (leadingLength > 0) this.appendPreWhitespace(text.slice(0, leadingLength));
        if (!stripped) return [];
        input = stripped;
      }
      const openTag = OPEN_TAGS.find(tag => input.startsWith(tag));
      if (openTag) {
        const leading = this.finishPreWhitespace(this.interleaved);
        this.state = "thinking";
        this.closeTag = closeTagFor(openTag);
        const events: AdapterEvent[] = leading ? [{ type: "text_delta", text: leading }] : [];
        return this.drainChunk(input, openTag.length, events);
      }
      if (input.length <= MAX_OPEN_TAG && isPossibleOpenTagPrefix(input)) {
        this.replaceCarry("preBuffer", input);
        return [];
      }
      this.state = "streaming";
      return [{ type: "text_delta", text: this.finishPreWhitespace(true) + input }];
    }
    if (this.state === "thinking") {
      input = this.thinkingBuffer + text;
      this.replaceCarry("thinkingBuffer", "");
    } else {
      input = this.preBuffer + text;
      this.replaceCarry("preBuffer", "");
    }
    return this.drainChunk(input, 0, []);
  }

  flush(): AdapterEvent[] {
    if (this.state === "thinking") {
      const out = this.thinkingBuffer;
      this.replaceCarry("thinkingBuffer", "");
      this.state = "streaming";
      return out ? [{ type: "reasoning_raw_delta", text: out }] : [];
    }
    if (this.preWhitespaceLength > 0 || this.preBuffer) {
      const out = this.finishPreWhitespace(true) + this.preBuffer;
      this.replaceCarry("preBuffer", "");
      this.state = "streaming";
      return [{ type: "text_delta", text: out }];
    }
    return [];
  }

  /** Release any partial tag/content carry when the owning stream stops early. */
  dispose(): void {
    this.finishPreWhitespace(false);
    this.replaceCarry("preBuffer", "");
    this.replaceCarry("thinkingBuffer", "");
    this.closeTag = "";
    this.state = "streaming";
  }

  private drainChunk(input: string, start: number, events: AdapterEvent[]): AdapterEvent[] {
    let offset = start;
    for (;;) {
      if (this.state === "thinking") {
        const idx = input.indexOf(this.closeTag, offset);
        if (idx >= 0) {
          if (idx > offset) events.push({ type: "reasoning_raw_delta", text: input.slice(offset, idx) });
          offset = idx + this.closeTag.length;
          if (!this.interleaved) {
            // Opt-in Chat answers are byte-preserving; keep Kiro's legacy normalization.
            const after = input.slice(offset).trimStart();
            this.state = "streaming";
            if (after) events.push({ type: "text_delta", text: after });
            return events;
          }
          this.state = "scanning";
          continue;
        }
        // Keep only a possible close tag, and do not split a surrogate pair.
        const cut = Math.max(offset, surrogateSafeCut(input, input.length - MAX_CLOSE_TAG));
        if (cut > offset) events.push({ type: "reasoning_raw_delta", text: input.slice(offset, cut) });
        this.replaceCarry("thinkingBuffer", input.slice(cut));
        return events;
      }

      // Interleaved mode has already seen a leading tag; later tags delimit anywhere.
      let openIndex = input.indexOf("<", offset);
      let openTag: ThinkingTag | undefined;
      while (openIndex >= 0) {
        openTag = OPEN_TAGS.find(tag => input.startsWith(tag, openIndex));
        if (openTag) break;
        openIndex = input.indexOf("<", openIndex + 1);
      }
      if (openIndex >= 0 && openTag) {
        if (openIndex > offset) events.push({ type: "text_delta", text: input.slice(offset, openIndex) });
        offset = openIndex + openTag.length;
        this.state = "thinking";
        this.closeTag = closeTagFor(openTag);
        continue;
      }
      // Hold back only a possible open-tag prefix, with a surrogate-safe boundary.
      const cut = Math.max(offset, surrogateSafeCut(input, input.length - (MAX_OPEN_TAG - 1)));
      if (cut > offset) events.push({ type: "text_delta", text: input.slice(offset, cut) });
      this.replaceCarry("preBuffer", input.slice(cut));
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
  try {
    return [...splitter.feed(content), ...splitter.flush()];
  } finally {
    splitter.dispose();
  }
}
