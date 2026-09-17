/**
 * Quarantine textual pseudo tool-call markers that Cursor models emit inside
 * `textDelta` instead of (or in addition to) real `toolCall*` frames.
 *
 * `#2305` only rewrote the display alias *inside* `[TOOL_CALL]…[ARGS]`. The
 * marker still reached Codex/Claude as assistant text, which few-shot-mimics
 * later calls as inert text and stalls multi-tool turns. This drain strips
 * every complete marker from visible text and yields the parsed calls so the
 * protobuf mapper can promote advertised names onto the real tool-call path.
 *
 * Incomplete markers (split across streaming deltas) stay in `pending` until
 * the JSON object closes. Once the retained prefix exceeds the byte cap, the
 * parser switches to a constant-space suppressed scan until the object closes.
 */
import { debugProviderDiagnostic } from "../../lib/debug";
import { normalizeCursorWireName } from "./tool-naming";

export const MAX_PENDING_TEXT_TOOLCALL_BYTES = 64 * 1024;
const TOOL_CALL_OPEN = /\[TOOL_CALL\]/gi;

export interface DrainedTextToolCall {
  readonly name: string;
  readonly args: string;
}

export interface SuppressedTextToolCallScan {
  phase: "args-tag" | "json-start" | "json";
  argsTagProgress: number;
  depth: number;
  inString: boolean;
  escape: boolean;
}

export interface DrainTextToolCallsResult {
  readonly text: string;
  readonly pending: string;
  readonly calls: readonly DrainedTextToolCall[];
  readonly suppressed?: SuppressedTextToolCallScan;
}

function findJsonObjectEnd(source: string, start: number): number | undefined {
  if (source[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function newSuppressedScan(): SuppressedTextToolCallScan {
  return {
    phase: "args-tag",
    argsTagProgress: 0,
    depth: 0,
    inString: false,
    escape: false,
  };
}

const ARGS_TAG = "[args]";

function consumeSuppressedScan(
  state: SuppressedTextToolCallScan,
  source: string,
  start = 0,
): { readonly state?: SuppressedTextToolCallScan; readonly resumeAt: number } {
  for (let i = start; i < source.length; i++) {
    const ch = source[i] ?? "";
    if (state.phase === "args-tag") {
      const lower = ch.toLowerCase();
      if (lower === ARGS_TAG[state.argsTagProgress]) {
        state.argsTagProgress += 1;
        if (state.argsTagProgress === ARGS_TAG.length) {
          state.phase = "json-start";
          state.argsTagProgress = 0;
        }
      } else {
        state.argsTagProgress = lower === ARGS_TAG[0] ? 1 : 0;
      }
      continue;
    }
    if (state.phase === "json-start") {
      if (/\s/.test(ch)) continue;
      if (ch !== "{") {
        debugProviderDiagnostic("cursor", "text-toolcall-invalid-arguments", {
          reason: "arguments-did-not-start-with-object",
        });
        return { resumeAt: source.length };
      }
      state.phase = "json";
      state.depth = 1;
      continue;
    }
    if (state.inString) {
      if (state.escape) {
        state.escape = false;
      } else if (ch === "\\") {
        state.escape = true;
      } else if (ch === "\"") {
        state.inString = false;
      }
      continue;
    }
    if (ch === "\"") state.inString = true;
    else if (ch === "{") state.depth += 1;
    else if (ch === "}") {
      state.depth -= 1;
      if (state.depth === 0) return { resumeAt: i + 1 };
    }
  }
  return { state, resumeAt: source.length };
}

function holdOrSuppress(hold: string, afterOpen: number): Pick<DrainTextToolCallsResult, "pending" | "suppressed"> {
  if (byteLength(hold) <= MAX_PENDING_TEXT_TOOLCALL_BYTES) return { pending: hold };
  const suppressed = newSuppressedScan();
  const scanned = consumeSuppressedScan(suppressed, hold, afterOpen);
  return scanned.state ? { pending: "", suppressed: scanned.state } : { pending: "" };
}

/**
 * Fold `pending + chunk`, emit surrounding prose, and extract every complete
 * `[TOOL_CALL]name[ARGS]{…}` block. Names are folded through
 * `normalizeCursorWireName` so `mcp_opencodex-responses_*` display aliases
 * become the advertised wire name before promotion.
 */
export function drainCursorTextToolCalls(
  pending: string,
  chunk: string,
  suppressed?: SuppressedTextToolCallScan,
): DrainTextToolCallsResult {
  let combined = pending + chunk;
  if (suppressed) {
    const scanned = consumeSuppressedScan(suppressed, chunk);
    if (scanned.state) return { text: "", pending: "", calls: [], suppressed: scanned.state };
    combined = chunk.slice(scanned.resumeAt);
  }
  let cursor = 0;
  let text = "";
  const calls: DrainedTextToolCall[] = [];
  const opener = new RegExp(TOOL_CALL_OPEN.source, TOOL_CALL_OPEN.flags);

  while (cursor < combined.length) {
    opener.lastIndex = cursor;
    const match = opener.exec(combined);
    if (!match || match.index === undefined) {
      text += combined.slice(cursor);
      return { text, pending: "", calls };
    }

    text += combined.slice(cursor, match.index);
    const afterOpen = match.index + match[0].length;
    const rest = combined.slice(afterOpen);
    const argsTag = rest.match(/^([^\[\]]*)\[ARGS\]/i);
    if (!argsTag) {
      const hold = combined.slice(match.index);
      return { text, calls, ...holdOrSuppress(hold, afterOpen - match.index) };
    }

    const name = argsTag[1]?.trim() ?? "";
    let jsonStart = afterOpen + argsTag[0].length;
    while (jsonStart < combined.length && /\s/.test(combined[jsonStart] ?? "")) jsonStart += 1;
    if (jsonStart >= combined.length) {
      const hold = combined.slice(match.index);
      return { text, calls, ...holdOrSuppress(hold, afterOpen - match.index) };
    }
    if (combined[jsonStart] !== "{") {
      debugProviderDiagnostic("cursor", "text-toolcall-invalid-arguments", {
        reason: "arguments-did-not-start-with-object",
        ...(name ? { toolName: normalizeCursorWireName(name) } : {}),
      });
      // No delimiter identifies where a non-JSON payload ends. Resume marker
      // scanning after `[ARGS]`, while suppressing the malformed payload itself.
      opener.lastIndex = jsonStart;
      const nextMarker = opener.exec(combined);
      if (!nextMarker || nextMarker.index === undefined) return { text, pending: "", calls };
      cursor = nextMarker.index;
      continue;
    }

    const jsonEnd = findJsonObjectEnd(combined, jsonStart);
    if (jsonEnd === undefined) {
      const hold = combined.slice(match.index);
      return { text, calls, ...holdOrSuppress(hold, afterOpen - match.index) };
    }

    const args = combined.slice(jsonStart, jsonEnd);
    try {
      JSON.parse(args);
      if (name.length > 0) {
        calls.push({ name: normalizeCursorWireName(name), args });
      }
    } catch {
      debugProviderDiagnostic("cursor", "text-toolcall-invalid-arguments", {
        reason: "arguments-json-parse-failed",
        ...(name ? { toolName: normalizeCursorWireName(name) } : {}),
      });
    }
    cursor = jsonEnd;
  }

  return { text, pending: "", calls };
}
