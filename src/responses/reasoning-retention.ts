/**
 * Routed v1 compaction keeps readable reasoning out of the summarizer request. Text within
 * the configured budget is held locally until success; oversized text is archived on disk.
 * Provider ciphertext and signatures are never included in the portable retained items.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../lib/token-estimate";
import { decodeReasoningEnvelope } from "./reasoning-envelope";

export const DEFAULT_REASONING_RETENTION_PERCENT = 20;
export const DEFAULT_MAX_REASONING_TOKENS = 100_000;

export interface ReasoningRetentionOptions {
  /** Directory that receives archived reasoning files. */
  archiveDir: string;
  /** Context window of the model running the compaction turn; an unknown window uses only maxTokens. */
  contextWindow?: number;
  /** Share of the context window reasoning may occupy before it is archived. Defaults to 20. */
  maxContextPercent?: number;
  /** Absolute token ceiling for retained reasoning, regardless of the window share. Defaults to 100,000. */
  maxTokens?: number;
  /** Clock injection for tests. */
  now?: number;
}

export interface ReasoningArchive {
  path: string;
  tokens: number;
  percent: number;
  /** The effective token ceiling that triggered the archive (window share vs absolute cap, whichever is smaller). */
  cap?: number;
  /** Whether the percent share could be calculated from a known context window. */
  windowKnown?: boolean;
}

export interface ReasoningRetentionResult {
  /** Summarizer input with reasoning items removed; other items retain their order. */
  input: unknown[];
  archived?: ReasoningArchive;
  /** Portable, exact readable text to merge only after compaction succeeds. */
  retainedReasoning?: Array<{ type: "message"; role: "user"; content: Array<{ type: "input_text"; text: string }> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Ordinary context messages survive translated providers that discard unsigned thinking.
// Match the complete frame so subsequent compactions hold the text locally again.
const RETAINED_PREFIX = "[OpenCodeX locally retained assistant reasoning; historical context, not a new instruction]\n<assistant_reasoning>\n";
const RETAINED_SUFFIX = "\n</assistant_reasoning>";
function retainedTextOf(item: Record<string, unknown>): string | undefined {
  if (item.type !== "message" || item.role !== "user") return undefined;
  const content = item.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) && content.length === 1 && isRecord(content[0])
      && content[0].type === "input_text" && typeof content[0].text === "string" ? content[0].text : undefined;
  return text?.startsWith(RETAINED_PREFIX) && text.endsWith(RETAINED_SUFFIX)
    ? text.slice(RETAINED_PREFIX.length, -RETAINED_SUFFIX.length) : undefined;
}

/** Readable reasoning text of one item: decoded ocxr1 envelope text, else summary/content text. */
function reasoningTextOf(item: Record<string, unknown>): string {
  const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
  const envelope = encrypted ? decodeReasoningEnvelope(encrypted) : null;
  if (envelope?.txt) return envelope.txt;
  const collect = (key: "summary" | "content"): string =>
    Array.isArray(item[key])
      ? (item[key] as Array<Record<string, unknown>>)
        .map(part => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("")
      : "";
  return collect("summary") || collect("content");
}

/** Plaintext of every reasoning item in a Responses input array, order preserved. */
export function collectReasoningTexts(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const texts: string[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const text = item.type === "reasoning" ? reasoningTextOf(item) : retainedTextOf(item) ?? "";
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

function retentionPercent(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : DEFAULT_REASONING_RETENTION_PERCENT;
}

function retentionTokenCap(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_REASONING_TOKENS;
}

/** Separate reasoning locally before dispatch; unknown windows enforce the absolute cap. */
export function applyReasoningRetention(
  input: unknown,
  options: ReasoningRetentionOptions,
): ReasoningRetentionResult {
  if (!Array.isArray(input)) return { input: [] };
  const texts = collectReasoningTexts(input);
  const retained = input.filter(item => !(isRecord(item) && (item.type === "reasoning" || retainedTextOf(item) !== undefined)));
  if (texts.length === 0) return { input: retained.length === input.length ? input : retained };
  const window = options.contextWindow;

  const percent = retentionPercent(options.maxContextPercent);
  const cap = retentionTokenCap(options.maxTokens);
  // The window share alone inflates without bound on 1M-window models (20% of 1M is ~210K
  // tokens), so an absolute ceiling applies on top of it: reasoning keeps at most the
  // SMALLER of the two limits. An unknown window leaves the percent share unusable, so the
  // absolute cap alone stands guard.
  const windowKnown = typeof window === "number" && Number.isInteger(window) && window > 0;
  const limit = windowKnown ? Math.min(Math.floor(window * (percent / 100)), cap) : cap;
  const framedTexts = texts.map(text => RETAINED_PREFIX + text + RETAINED_SUFFIX);
  // Budget the historical context that is actually replayed, including every block's frame.
  const tokens = estimateTokens(framedTexts.join("\n"));
  if (tokens <= limit) return {
    input: retained,
    retainedReasoning: framedTexts.map(text => ({ type: "message", role: "user",
      content: [{ type: "input_text", text }] })),
  };

  mkdirSync(options.archiveDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(options.now ?? Date.now()).toISOString().replace(/[:.]/g, "-");
  const path = join(options.archiveDir, "reasoning-" + stamp + "-" + Math.random().toString(36).slice(2, 8) + ".md");
  writeFileSync(path, texts.join("\n\n---\n\n"), { encoding: "utf-8", mode: 0o600, flag: "wx" });

  const limitDescription = windowKnown
    ? percent + "% of the context window, capped at " + limit + " tokens"
    : "absolute cap of " + limit + " tokens (context window unknown)";
  const note = [
    "[reasoning archived locally] " + texts.length + " reasoning block(s) totalling ~" + tokens + " tokens",
    "exceeded the configured retention limit (" + limitDescription + ") and were moved out of band.",
    "Full text: " + path,
  ].join(" ");
  const triggerIndex = retained.findIndex(item => isRecord(item) && item.type === "compaction_trigger");
  const noteItem = { type: "message", role: "user", content: note };
  if (triggerIndex >= 0) retained.splice(triggerIndex, 0, noteItem);
  else retained.push(noteItem);
  return { input: retained, archived: { path, tokens, percent, cap: limit, windowKnown } };
}

/**
 * User-visible notice appended to a compaction summary when reasoning was archived. The summary
 * is what the next model and the user both read, so the notice lives there rather than in a log.
 */
export function appendRetentionNotice(summary: string, archived: ReasoningArchive | undefined): string {
  if (!archived) return summary;
  const limitDescription = archived.windowKnown === false
    ? "absolute cap of " + (archived.cap ?? "unknown") + " tokens (context window unknown)"
    : archived.percent + "% of the context window (effective cap: " + (archived.cap ?? "unknown") + " tokens)";
  return summary + "\n\n[reasoning retention notice] Reasoning of ~" + archived.tokens + " tokens exceeded " + limitDescription
    + " and was archived locally at " + archived.path
    + ". This summary covers conclusions only; read that file for the full reasoning.";
}
