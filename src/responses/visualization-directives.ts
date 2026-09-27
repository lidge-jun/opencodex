/**
 * Codex App visualization references for models that cannot see private-use characters.
 *
 * The bundled Visualize skill teaches the model to answer with
 *
 *     \uE200visualize\uE202{"path":"/abs/chart.html"}\uE201
 *
 * and the Codex App renders that span as an inline visualization. Some providers drop Basic
 * Multilingual Plane private-use characters before the model sees them (every Claude route checked
 * on 2026-09-27, direct and through Cursor), so the model reads and writes a bare
 * `visualize{"path":...}` that the app shows verbatim.
 *
 * The app does not need the private-use form. Its own renderer rewrites each span into the plain
 * directive `::codex-inline-vis{path="/abs/chart.html"}` before parsing, and it renders that
 * directive when it appears directly. Rewriting the span the same way in model-visible text gives
 * every model an ASCII instruction it can read and repeat.
 *
 * The rules mirror the app (26.924.22138, `f2` in app-shared) with two deliberate differences: code
 * blocks are rewritten too, because the skill's example sits in a fenced block, and the skill's
 * `<absolute-path>/<title>.html` placeholder is accepted so the model still sees the template.
 * Matching follows the app's regex `/\uE200visualize\uE202([^\uE201]+)\uE201/g` exactly, scanned in
 * linear time. Anything the app would keep as-is is kept as-is here.
 *
 * Only the parsed context is rewritten. The raw request body, which native passthrough serializes
 * and which is stored for `previous_response_id` replay, is never touched.
 */
import { posix } from "node:path";
import type { OcxContentPart, OcxContext, OcxMessage, OcxTextContent } from "../types";

const START = "\uE200";
const END = "\uE201";
const PREFIX = `${START}visualize\uE202`;
const INLINE_DIRECTIVE = "codex-inline-vis";
const LIVE_DIRECTIVE = "codex-live-vis";
/** The placeholder path in the Visualize skill's own template. */
const TEMPLATE_PATH = "<absolute-path>/<title>.html";
const HTML_BASENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const UNSAFE_ATTRIBUTE = /["\n\r]/;

/** The app's absolute-path test: POSIX (not `//`), drive letter, UNC with either slash. */
function isAbsoluteAppPath(path: string): boolean {
  return (path.startsWith("/") && !path.startsWith("//"))
    || /^[A-Za-z]:[\\/]/.test(path)
    || /^\\\\[^\\]+\\[^\\]+/.test(path)
    || /^\/\/[^/]+\/[^/]+/.test(path);
}

interface VisualizationReference {
  path: string | null;
  title?: string;
  type?: "inline" | "live";
  mode?: "wide";
}

/** The app's payload schema: `path` is required but nullable; the rest are optional and typed. */
function parseReference(value: unknown): VisualizationReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!("path" in record) || (record.path !== null && typeof record.path !== "string")) return undefined;
  if (record.title !== undefined && typeof record.title !== "string") return undefined;
  if (record.type !== undefined && record.type !== "inline" && record.type !== "live") return undefined;
  if (record.mode !== undefined && record.mode !== "wide") return undefined;
  if (record.wide !== undefined && typeof record.wide !== "boolean") return undefined;
  return {
    path: record.path as string | null,
    ...(record.title !== undefined ? { title: record.title as string } : {}),
    ...(record.type !== undefined ? { type: record.type as "inline" | "live" } : {}),
    ...(record.mode !== undefined ? { mode: "wide" as const } : {}),
  };
}

/** The ASCII directive for one span payload, or undefined when the app would keep the span. */
function toAsciiDirective(payload: string): string | undefined {
  const isJson = payload.startsWith("{");
  let raw: unknown = { path: payload };
  if (isJson) {
    try {
      raw = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  const reference = parseReference(raw);
  if (!reference) return undefined;
  const live = reference.type === "live";
  const { path } = reference;
  if (path === null) return live ? `::${LIVE_DIRECTIVE}{}` : undefined;

  const template = isJson && path === TEMPLATE_PATH;
  if (!template) {
    const basename = posix.basename(path.replaceAll("\\", "/"));
    if (PARENT_SEGMENT.test(path) || UNSAFE_ATTRIBUTE.test(path) || !HTML_BASENAME.test(basename)) return undefined;
    if (!isAbsoluteAppPath(path) && (isJson || path !== basename)) return undefined;
  }
  const attribute = template || isAbsoluteAppPath(path) ? "path" : "file";
  const title = reference.title !== undefined && !UNSAFE_ATTRIBUTE.test(reference.title)
    ? ` title="${reference.title}"`
    : "";
  const mode = !live && reference.mode === "wide" ? ` mode="wide"` : "";
  return `::${live ? LIVE_DIRECTIVE : INLINE_DIRECTIVE}{${attribute}="${path}"${title}${mode}}`;
}

/**
 * Rewrite every visualization span in `text` to the app's ASCII directive.
 *
 * Returns the same string when nothing changes. The scan finds the same matches as the app's regex:
 * a prefix, one or more characters that are not END, then END. When no END follows a prefix, no
 * later prefix can match either, so the scan stops instead of rescanning the tail for every prefix.
 */
export function normalizeVisualizationText(text: string): string {
  let prefixAt = text.indexOf(PREFIX);
  if (prefixAt === -1) return text;
  let out = "";
  let copiedTo = 0;
  while (prefixAt !== -1) {
    const payloadStart = prefixAt + PREFIX.length;
    const endAt = text.indexOf(END, payloadStart);
    if (endAt === -1) break;
    if (endAt === payloadStart) {
      // Empty payload: the regex moves on one character and tries again.
      prefixAt = text.indexOf(PREFIX, prefixAt + 1);
      continue;
    }
    const directive = toAsciiDirective(text.slice(payloadStart, endAt));
    if (directive !== undefined) {
      out += text.slice(copiedTo, prefixAt) + directive;
      copiedTo = endAt + 1;
    }
    prefixAt = text.indexOf(PREFIX, endAt + 1);
  }
  return copiedTo === 0 ? text : out + text.slice(copiedTo);
}

function normalizeParts<P extends { type: string }>(parts: P[]): P[] {
  let changed = false;
  const next = parts.map((part) => {
    if (part.type !== "text") return part;
    const text = (part as unknown as OcxTextContent).text;
    if (typeof text !== "string") return part;
    const normalized = normalizeVisualizationText(text);
    if (normalized === text) return part;
    changed = true;
    return { ...part, text: normalized };
  });
  return changed ? next : parts;
}

function normalizeContent<P extends { type: string }>(content: string | P[]): string | P[] {
  return typeof content === "string" ? normalizeVisualizationText(content) : normalizeParts(content);
}

function normalizeMessage(message: OcxMessage): OcxMessage {
  if (message.role === "assistant") {
    const content = normalizeParts(message.content);
    return content === message.content ? message : { ...message, content };
  }
  const content = normalizeContent<OcxContentPart>(message.content);
  return content === message.content ? message : { ...message, content } as OcxMessage;
}

/**
 * Rewrite visualization spans in the conversation text a routed model reads: the system prompt,
 * string message content, and text parts of every role. Other fields, including images, tool calls,
 * reasoning parts, and tool definitions, are returned by reference. The context itself is returned
 * unchanged when no text changed.
 */
export function normalizeVisualizationContext(context: OcxContext): OcxContext {
  let changed = false;
  const systemPrompt = context.systemPrompt?.map((text) => {
    const normalized = normalizeVisualizationText(text);
    if (normalized !== text) changed = true;
    return normalized;
  });
  const messages = context.messages.map((message) => {
    const normalized = normalizeMessage(message);
    if (normalized !== message) changed = true;
    return normalized;
  });
  if (!changed) return context;
  return { ...context, ...(systemPrompt ? { systemPrompt } : {}), messages };
}
