const OPEN_TAG = "<tool_call>";
const FUNCTION_TAG = "<function=";
// MiMo gateways append an opaque hexadecimal identity to both delimiters.
export const TAG_SUFFIX = "(?:_[a-fA-F0-9]{1,64})?";
export const MAX_TAG_LENGTH = "</tool_call_".length + 64 + 1;
const OPENING = new RegExp(`^<tool_call${TAG_SUFFIX}>`);
const OPEN_PREFIX = /^<tool_call(?:_[a-fA-F0-9]{0,64})?$/;

export interface TextContext {
  fence: string | null;
  lineStart: boolean;
  inlineTicks?: number;
  literalLine?: boolean;
}

/** Splits safe visible text from a possible control block while carrying Markdown context across chunks. */
export function splitAtPossibleSerializedToolCall(
  text: string,
  initialContext: TextContext = { fence: null, lineStart: true },
  final = false,
  allowMidLineBare = false,
): {
  emit: string;
  defer: string;
  hasOpenTag: boolean;
  context: TextContext;
} {
  const context = { ...initialContext };
  const split = (at: number, hasOpenTag = false) => ({
    emit: text.slice(0, at), defer: text.slice(at), hasOpenTag, context,
  });
  for (let index = 0; index < text.length; index++) {
    if (context.lineStart) {
      const rest = text.slice(index);
      const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(rest);
      if (!context.inlineTicks && fence && (!context.fence || (fence[1]![0] === context.fence[0]
          && fence[1]!.length >= context.fence.length && /^[ \t\r]*$/.test(fence[2]!)))) {
        if (!final && !rest.includes("\n")) return split(index);
        context.fence = context.fence ? null : fence[1]!;
        index += fence[0].length - 1;
        context.lineStart = false;
        continue;
      }
      if (!final && /^ {0,3}(`*|~*)$/.test(rest)) return split(index);
      context.literalLine = /[ \t>]/.test(text[index]!);
    }
    // Plain wrappers retain their bare-line rule. Nonced wrappers also occur after prose;
    // quotes, indentation and Markdown code remain literal, even beside a matching call.
    if (!context.fence && !context.inlineTicks && !context.literalLine && text[index] === "<") {
      const rest = text.slice(index);
      const opening = OPENING.exec(rest)?.[0];
      if (opening && (context.lineStart || opening !== OPEN_TAG || allowMidLineBare)) {
        const header = rest.slice(opening.length).trimStart();
        if (/^<function=[^>\r\n]+>/.test(header)) return split(index, true);
        if (!final && (FUNCTION_TAG.startsWith(header)
            || (header.startsWith(FUNCTION_TAG) && !/[>\r\n]/.test(header.slice(FUNCTION_TAG.length))))) {
          return split(index);
        }
      } else if (!final && (OPEN_TAG.startsWith(rest) || OPEN_PREFIX.test(rest))) return split(index);
    }
    if (!context.fence && text[index] === "`") {
      let end = index + 1;
      while (text[end] === "`") end++;
      if (!final && end === text.length) return split(index);
      const ticks = end - index;
      if (!context.inlineTicks) context.inlineTicks = ticks;
      else if (context.inlineTicks === ticks) context.inlineTicks = undefined;
      index = end - 1;
    }
    context.lineStart = text[index] === "\n";
  }
  return split(text.length);
}

/**
 * The line, fence and inline-code state after `text`. Serialized blocks are neutralised first so
 * the scan runs through the whole text instead of stopping at the first opening tag; a block ends
 * mid-line, which is exactly what the neutral spelling reports too.
 */
export function contextAfter(text: string, context: TextContext): TextContext {
  if (text.length === 0) return context;
  return splitAtPossibleSerializedToolCall(text.replace(new RegExp(`<tool_call${TAG_SUFFIX}>`, "g"), "<tool-call>"), context, true).context;
}

/**
 * A deferred header/fence can itself be long. While its unresolved portion only grows, a
 * chunk-local check suffices; the first resolving character goes back through the full splitter.
 * Each unbounded phase is scanned once on entry and once on exit, preserving its Markdown rules.
 */
export function deferredContinuationBreak(text: string, context: TextContext): RegExp | undefined {
  const opening = OPENING.exec(text)?.[0];
  if (opening) {
    const header = text.slice(opening.length);
    if (/^\s*$/.test(header)) return /\S/;
    if (/^\s*<function=[^>\r\n]*$/.test(header)) return /[>\r\n]/;
  }
  if (!context.inlineTicks && context.lineStart) {
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(text);
    if (fence) {
      if (!context.fence) return /\n/;
      // Closing-fence ticks may grow only before its optional whitespace suffix.
      if (!fence[2]) return fence[1]![0] === "`" ? /[^`]/ : /[^~]/;
      return /[^ \t\r]/;
    }
  }
  if (/^`+$/.test(text)) return /[^`]/;
  return undefined;
}
