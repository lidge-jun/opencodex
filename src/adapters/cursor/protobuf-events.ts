import type { OcxUsage } from "../../types";
import type { AgentServerMessage, McpArgs, ToolCall } from "./gen/agent_pb";
import { decodeCursorArgsMap } from "./arg-codec";
import { normalizeArgKeys } from "./arg-normalize";
import {
  CODEX_APPLY_PATCH_TOOL,
  CURSOR_MULTI_EDIT_TOOL,
  cursorShellBridgeArgsValid,
  cursorShellBridgeDropError,
  defaultShellBridgeArgNormalizeSchema,
  isCodexShellBridgeToolName,
  isCursorStructuredEditToolName,
  normalizeCursorWireName,
  OCX_RESPONSES_TOOL_PROVIDER,
  resolveShellBridgeAliasKey,
  responsesToolNameFromCursorWire,
} from "./tool-definitions";
import type { CursorServerMessage } from "./types";
import type { TranslatorBudget } from "../../lib/translator-budget";

const DEFAULT_CONTEXT_USAGE_MAX_ENTRIES = 200;
const DEFAULT_CONTEXT_USAGE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_CLIENT_TOOL_CALLS = 330;

export interface CursorContextUsageControls {
  /**
   * Last observed absolute context size for the same Cursor conversation and uncompacted context
   * epoch. Used only when the current turn produces output but no checkpoint.
   */
  carryForwardTokens?: number;
  /** Persist a fresh checkpoint for later turns in this conversation. */
  recordContextTokens?: (tokens: number) => void;
}

export interface CursorContextUsageTracker {
  controlsForConversation(conversationId: string, options?: { clearPrior?: boolean; storeCheckpoints?: boolean }): CursorContextUsageControls;
  get(conversationId: string): number | undefined;
  record(conversationId: string, tokens: number): void;
  /** Copy numeric carry-forward totals when a conversation id is rotated for replay. */
  rekey(fromConversationId: string, toConversationId: string): void;
  clear(conversationId: string): void;
  clearAll(): void;
}

interface CursorContextUsageEntry {
  tokens: number;
  updatedAt: number;
}

/**
 * Bounded numeric-only carry-forward for Cursor context usage. Cursor checkpoints are absolute
 * active-context sizes, but client-tool suspension can end a turn before a checkpoint arrives. Keep
 * only the last known total per provider conversation so a no-checkpoint finalize does not overwrite
 * a real active-context value with the current turn's tiny output delta. Context text, tool args,
 * and model output are never stored here.
 */
export function createCursorContextUsageTracker(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}): CursorContextUsageTracker {
  const maxEntries = options.maxEntries ?? DEFAULT_CONTEXT_USAGE_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_CONTEXT_USAGE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, CursorContextUsageEntry>();

  const prune = () => {
    const at = now();
    for (const [conversationId, entry] of entries) {
      if (at - entry.updatedAt > ttlMs) entries.delete(conversationId);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (!oldest) break;
      entries.delete(oldest);
    }
  };

  const record = (conversationId: string, tokens: number) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    prune();
    const existing = entries.get(conversationId);
    if (existing && existing.tokens >= tokens) {
      entries.delete(conversationId);
      entries.set(conversationId, { tokens: existing.tokens, updatedAt: now() });
      return;
    }
    entries.delete(conversationId);
    entries.set(conversationId, { tokens, updatedAt: now() });
    prune();
  };

  const get = (conversationId: string): number | undefined => {
    prune();
    const entry = entries.get(conversationId);
    if (!entry) return undefined;
    entries.delete(conversationId);
    entries.set(conversationId, { tokens: entry.tokens, updatedAt: now() });
    return entry.tokens;
  };

  return {
    controlsForConversation(conversationId, requestOptions = {}) {
      if (requestOptions.clearPrior === true) entries.delete(conversationId);
      const storeCheckpoints = requestOptions.storeCheckpoints !== false;
      const carryForwardTokens = storeCheckpoints ? get(conversationId) : undefined;
      return {
        ...(carryForwardTokens !== undefined ? { carryForwardTokens } : {}),
        ...(storeCheckpoints ? { recordContextTokens: tokens => record(conversationId, tokens) } : {}),
      };
    },
    get,
    record,
    rekey(fromConversationId, toConversationId) {
      if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return;
      prune();
      const from = entries.get(fromConversationId);
      if (!from) return;
      const to = entries.get(toConversationId);
      const tokens = Math.max(from.tokens, to?.tokens ?? 0);
      entries.delete(fromConversationId);
      entries.delete(toConversationId);
      entries.set(toConversationId, { tokens, updatedAt: now() });
      prune();
    },
    clear(conversationId) {
      entries.delete(conversationId);
    },
    clearAll() {
      entries.clear();
    },
  };
}

export interface CursorProtobufEventState {
  usage: OcxUsage;
  /**
   * Absolute conversation context size from Cursor's `conversationCheckpointUpdate.usedTokens`
   * (authoritative cumulative context, NOT a per-turn delta). Kept separate from `usage.outputTokens`
   * so it is never folded into the additive per-turn output count. Surfaced as `done.usage.totalTokens`
   * so Codex's `last_token_usage.total_tokens` reflects the real active context. Mirrors the Kiro
   * contextUsagePercentage SOT fix (devlog 142.10): absolute context and additive output must not
   * share one field, or Codex double-counts (e.g. 10000 then 10300 surfacing as 20300).
   */
  contextTokens?: number;
  /**
   * Request-local input estimate derived from the payload actually sent to Cursor.
   * Used only when neither a checkpoint nor a carry-forward is available — a restart
   * clears the tracker, and reporting inputTokens=0 makes Codex see an almost-empty
   * context (#373). Never written back into the tracker: only real checkpoints are.
   */
  estimatedInputTokens?: number;
  /**
   * Session-level last-known absolute context size for this Cursor conversation. This is a fallback
   * for no-checkpoint client-tool finalize turns only; any checkpoint observed during the current
   * turn remains authoritative, with monotonic max semantics unless a compaction boundary reset the
   * conversation cache before the turn.
   */
  contextCarryForwardTokens?: number;
  recordContextTokens?: (tokens: number) => void;
  openToolCalls: Map<string, { name: string; args: string; awaitingNativeArgs?: boolean }>;
  completedToolCalls: Set<string>;
  /** Set once a terminal `done`/truncation has been emitted, so post-terminal frames stay inert. */
  terminated?: boolean;
  clientToolNames?: Set<string>;
  /** Responses/Codex names of request-declared freeform tools advertised to Cursor. */
  freeformToolNames?: ReadonlySet<string>;
  parallelToolCalls?: boolean;
  startedClientToolCalls: number;
  /** Hard cap on client tool-call records retained during one upstream turn. */
  maxClientToolCalls: number;
  /** Tool wire-name → original JSON Schema parameters object, for arg-key normalization. */
  toolSchemas?: Map<string, unknown>;
  /** Cursor wire-name → original Responses/Codex tool name for this request. */
  cursorToolNameMap?: Map<string, string>;
  /**
   * Bare names WE advertised as synthetic structured-edit tools on this request.
   * See structuredEditCallIsOurs: conversion is gated on provenance, not on the name.
   */
  syntheticStructuredEditToolNames?: ReadonlySet<string>;
  translatorBudget?: TranslatorBudget;
}


/**
 * Did WE advertise this bare tool name as a synthetic structured-edit tool on this request?
 *
 * Provenance, not a name test. `edit_file` / `multi_edit` are ordinary names a client or MCP
 * server may legitimately expose, and `cursorStructuredEditTools` already refuses to shadow one
 * that exists. Converting on the name alone would undo that refusal at the other end of the
 * request: the client's own call would be silently re-emitted as `apply_patch`, or dropped with
 * an error naming a conversion the user never asked for.
 *
 * Absent set = we advertised nothing, so nothing converts. Fail-closed in the safe direction:
 * an unconverted structured call is a visible, recoverable failure; a wrongly converted one
 * edits a file.
 */
function structuredEditCallIsOurs(
  advertised: ReadonlySet<string> | undefined,
  toolName: string,
): boolean {
  return advertised?.has(toolName) === true;
}

export function createCursorProtobufEventState(options: {
  clientToolNames?: Iterable<string>;
  freeformToolNames?: Iterable<string>;
  parallelToolCalls?: boolean;
  maxClientToolCalls?: number;
  toolSchemas?: Map<string, unknown>;
  cursorToolNameMap?: Map<string, string>;
  syntheticStructuredEditToolNames?: Iterable<string>;
  contextUsage?: CursorContextUsageControls;
  /**
   * Request-local input estimate derived from the payload actually sent. Used only
   * when neither a checkpoint nor a carry-forward is available; never recorded into
   * the checkpoint tracker (#373).
   */
  estimatedInputTokens?: number;
  translatorBudget?: TranslatorBudget;
} = {}): CursorProtobufEventState {
  return {
    // Cursor provides no authoritative usage frame; token counts are heuristic estimates from
    // checkpoint/delta events, so mark estimated from the start.
    usage: { inputTokens: 0, outputTokens: 0, estimated: true },
    openToolCalls: new Map(),
    completedToolCalls: new Set(),
    ...(options.clientToolNames ? { clientToolNames: new Set(options.clientToolNames) } : {}),
    ...(options.freeformToolNames ? { freeformToolNames: new Set(options.freeformToolNames) } : {}),
    ...(options.syntheticStructuredEditToolNames
      ? { syntheticStructuredEditToolNames: new Set(options.syntheticStructuredEditToolNames) }
      : {}),
    ...(options.parallelToolCalls !== undefined ? { parallelToolCalls: options.parallelToolCalls } : {}),
    startedClientToolCalls: 0,
    maxClientToolCalls: typeof options.maxClientToolCalls === "number"
      && Number.isFinite(options.maxClientToolCalls)
      && options.maxClientToolCalls > 0
      ? Math.floor(options.maxClientToolCalls)
      : DEFAULT_MAX_CLIENT_TOOL_CALLS,
    ...(options.toolSchemas ? { toolSchemas: options.toolSchemas } : {}),
    ...(options.cursorToolNameMap ? { cursorToolNameMap: options.cursorToolNameMap } : {}),
    ...(options.translatorBudget ? { translatorBudget: options.translatorBudget } : {}),
    ...(options.contextUsage?.carryForwardTokens !== undefined ? { contextCarryForwardTokens: options.contextUsage.carryForwardTokens } : {}),
    ...(options.contextUsage?.recordContextTokens ? { recordContextTokens: options.contextUsage.recordContextTokens } : {}),
    ...(typeof options.estimatedInputTokens === "number"
      && Number.isFinite(options.estimatedInputTokens)
      && options.estimatedInputTokens > 0
      ? { estimatedInputTokens: options.estimatedInputTokens }
      : {}),
  };
}

function observeContextTokens(state: CursorProtobufEventState, usedTokens: number): void {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return;
  if (usedTokens > (state.contextTokens ?? 0)) state.contextTokens = usedTokens;
  state.recordContextTokens?.(usedTokens);
}

export function reportableContextTokens(state: CursorProtobufEventState): number | undefined {
  const current = state.contextTokens;
  const carry = state.contextCarryForwardTokens;
  if (current === undefined) return carry;
  if (carry === undefined) return current;
  return Math.max(current, carry);
}

export function usageFromContextTokens(state: CursorProtobufEventState, contextTokens: number): OcxUsage {
  return {
    ...state.usage,
    inputTokens: Math.max(0, contextTokens - state.usage.outputTokens),
    totalTokens: contextTokens,
  };
}

/** Exported for live-transport's client-tool frame classification (finalize revocation). */
export function mcpArgsFromToolCall(toolCall: ToolCall | undefined): McpArgs | undefined {
  if (toolCall?.tool.case !== "mcpToolCall") return undefined;
  const args = toolCall.tool.value.args;
  return args?.providerIdentifier === OCX_RESPONSES_TOOL_PROVIDER ? args : undefined;
}

function mcpWireNameFromArgs(args: McpArgs | undefined): string | undefined {
  const raw = args?.toolName || args?.name;
  // Models may call the Cursor-displayed `mcp_<provider>_<tool>` name; fold it to the advertised name.
  return raw && raw.length > 0 ? normalizeCursorWireName(raw) : undefined;
}

function mcpCursorWireName(toolCall: ToolCall | undefined): string | undefined {
  return mcpWireNameFromArgs(mcpArgsFromToolCall(toolCall));
}

function decodeMcpArgs(args: McpArgs | undefined): string {
  return JSON.stringify(decodeCursorArgsMap(args?.args));
}

/** Resolve an advertised client-tool wire name, including shell_command/exec_command aliases (#399). */
function resolveAdvertisedClientToolName(
  state: CursorProtobufEventState,
  cursorWireName: string,
): string | undefined {
  const normalized = normalizeCursorWireName(cursorWireName);
  if (!state.clientToolNames) return normalized;
  return resolveShellBridgeAliasKey(normalized, alias => (state.clientToolNames!.has(alias) ? alias : undefined));
}

function toolSchemaForWireName(state: CursorProtobufEventState, toolName: string | undefined): unknown | undefined {
  if (!toolName || !state.toolSchemas) return undefined;
  return resolveShellBridgeAliasKey(toolName, alias => state.toolSchemas!.get(alias));
}

function decodeMcpArgsNormalized(args: McpArgs | undefined, state: CursorProtobufEventState): string {
  const decoded = decodeCursorArgsMap(args?.args);
  const toolName = mcpWireNameFromArgs(args);
  const schema = toolSchemaForWireName(state, toolName);
  if (schema) return JSON.stringify(normalizeArgKeys(decoded, schema));
  return JSON.stringify(decoded);
}

function hasMcpArgBytes(args: McpArgs | undefined): boolean {
  return Object.keys(args?.args ?? {}).length > 0;
}

function isCompleteJson(text: string): boolean {
  if (text.length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Schema-normalize a JSON-text argument blob for a named tool, if a schema is known. */
function normalizeJsonText(text: string, toolName: string | undefined, state: CursorProtobufEventState): string {
  const schema = toolSchemaForWireName(state, toolName);
  if (!schema) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(normalizeArgKeys(parsed as Record<string, unknown>, schema));
    }
  } catch {
    // Not parseable as an object: leave as-is.
  }
  return text;
}

/**
 * Resolve the authoritative argument string for a completed client tool call.
 *
 * Cursor sends args two ways: incrementally as `argsTextDelta` (buffered into `open.args`, never
 * streamed onward), and/or as a structured protobuf map on `toolCallCompleted`. We emit the args
 * exactly once, at completion, so they can always be schema-normalized regardless of which form
 * arrived. The completed map wins when present (canonical); otherwise the buffered streamed text is
 * preserved verbatim so the bridge can reject malformed or truncated JSON instead of silently
 * converting it to `{}`. A genuinely empty buffer remains the no-argument case.
 */
function resolveCompletedArgs(buffered: string, args: McpArgs | undefined, state: CursorProtobufEventState): string {
  if (hasMcpArgBytes(args)) return decodeMcpArgsNormalized(args, state);
  const name = mcpWireNameFromArgs(args);
  if (isCompleteJson(buffered)) return normalizeJsonText(buffered, name, state);
  return buffered;
}

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const GIT_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)?(?: @@.*)?$/;
const MARKDOWN_FENCE = /^```[\w+-]*\s*$/;
const PATH_ARG_KEYS = ["file_path", "filePath", "path", "filepath", "filename", "file", "target_file", "targetFile", "target_path", "targetPath"] as const;
const OLD_STRING_KEYS = ["old_string", "oldString", "oldtext", "old_text", "old_content", "oldContent", "before", "search"] as const;
const NEW_STRING_KEYS = ["new_string", "newString", "newtext", "new_text", "contents", "content", "new_contents", "newContents", "after", "replace"] as const;

export type StructuredEditPair = { old_string: string; new_string: string };

/** First index where `needle` appears as consecutive whole lines in `haystack`, or -1. */
function lineBlockIndex(haystack: string, needle: string): number {
  if (needle.length === 0) return -1;
  const hay = patchLines(haystack);
  const ned = patchLines(needle);
  if (ned.length === 0 || ned.length > hay.length) return -1;
  for (let i = 0; i <= hay.length - ned.length; i++) {
    if (ned.every((line, j) => hay[i + j] === line)) return i;
  }
  return -1;
}

function replaceLineBlock(haystack: string, needle: string, replacement: string): string {
  const at = lineBlockIndex(haystack, needle);
  if (at < 0) return haystack;
  const hay = patchLines(haystack);
  const ned = patchLines(needle);
  const next = [...hay.slice(0, at), ...patchLines(replacement), ...hay.slice(at + ned.length)];
  return next.join("\n");
}

/**
 * Codex apply_patch matches every hunk against the original file (atomic). Cursor models
 * emit sequential multi_edit (later old_string is the text after an earlier replacement).
 * Fold only when one side contains the other as whole lines — raw substring includes()
 * merged independent edits (B8: `hello world` inside `x = hello world`).
 */
export function foldSequentialStructuredEdits(edits: StructuredEditPair[]): StructuredEditPair[] {
  const folded: StructuredEditPair[] = [];
  for (const edit of edits) {
    let absorbed = false;
    for (let i = folded.length - 1; i >= 0; i--) {
      const prior = folded[i];
      if (lineBlockIndex(prior.new_string, edit.old_string) >= 0) {
        folded[i] = {
          old_string: prior.old_string,
          new_string: replaceLineBlock(prior.new_string, edit.old_string, edit.new_string),
        };
        absorbed = true;
        break;
      }
      if (lineBlockIndex(edit.old_string, prior.new_string) >= 0) {
        folded[i] = {
          old_string: replaceLineBlock(edit.old_string, prior.new_string, prior.old_string),
          new_string: edit.new_string,
        };
        absorbed = true;
        break;
      }
    }
    if (!absorbed) folded.push({ old_string: edit.old_string, new_string: edit.new_string });
  }
  return folded;
}

const GIT_NO_NEWLINE = /^\\ No newline at end of file\s*$/;
const GIT_META_PREFIX = /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;
const GIT_FILE_HEADER = /^(---|\+\+\+) (?:\/dev\/null|"[ab]\/|[ab]\/)/;

function isCodexFileOpLine(line: string): boolean {
  return line.startsWith("*** Update File:")
    || line.startsWith("*** Add File:")
    || line.startsWith("*** Delete File:");
}

function canonicalizeCodexLine(line: string): string {
  const trimmed = line.replace(/^\uFEFF/, "");
  const lower = trimmed.toLowerCase();
  if (lower === "*** begin patch" || lower.startsWith("*** begin patch ")) return PATCH_BEGIN;
  if (lower === "*** end patch" || lower.startsWith("*** end patch ")) return PATCH_END;
  const colonOps = [
    ["*** update file:", "*** Update File:"],
    ["*** add file:", "*** Add File:"],
    ["*** delete file:", "*** Delete File:"],
    ["*** move to:", "*** Move to:"],
  ] as const;
  for (const [needle, canon] of colonOps) {
    if (lower.startsWith(needle)) return `${canon}${trimmed.slice(needle.length)}`;
  }
  const spaceOps = [
    ["*** update file ", "*** Update File: "],
    ["*** add file ", "*** Add File: "],
    ["*** delete file ", "*** Delete File: "],
  ] as const;
  for (const [needle, canon] of spaceOps) {
    if (lower.startsWith(needle)) return `${canon}${trimmed.slice(needle.length)}`;
  }
  return trimmed;
}

function isGitPreambleLine(line: string): boolean {
  return line === "---"
    || GIT_NO_NEWLINE.test(line)
    || GIT_META_PREFIX.test(line)
    || GIT_FILE_HEADER.test(line);
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return normalizePatchPath(trimmed.slice(1, -1));
  }
  return normalizePatchPath(trimmed);
}

/** Grammar-only path cleanup: trim, POSIX slashes, drop a leading `./`. */
function normalizePatchPath(path: string): string {
  let next = path.trim().replace(/\\/g, "/");
  while (next.startsWith("./")) next = next.slice(2);
  return next;
}

function parseDiffGitPaths(line: string): { a: string; b: string } | undefined {
  const quoted = /^diff --git "a\/(.+)" "b\/(.+)"$/.exec(line);
  if (quoted) return { a: unquoteGitPath(quoted[1]), b: unquoteGitPath(quoted[2]) };
  const plain = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (plain) return { a: unquoteGitPath(plain[1]), b: unquoteGitPath(plain[2]) };
  return undefined;
}

function parseGitSidePath(line: string, side: "a" | "b"): string | undefined {
  const quoted = new RegExp(`^(?:---|[+][+][+]) "${side}\\/(.+)"$`).exec(line);
  if (quoted) return unquoteGitPath(quoted[1]);
  const plain = new RegExp(`^(?:---|[+][+][+]) ${side}\\/(.+)$`).exec(line);
  if (plain) return unquoteGitPath(plain[1]);
  return undefined;
}

function isDevNull(line: string): boolean {
  return /^(---|\+\+\+) \/dev\/null$/.test(line);
}

function rewriteHunkHeader(line: string): string {
  return GIT_HUNK_HEADER.test(line) ? "@@" : line;
}

function isFenceLine(line: string): boolean {
  return MARKDOWN_FENCE.test(line);
}

function isHunkBodyLine(line: string): boolean {
  return line === "@@"
    || line.startsWith("@@ ")
    || GIT_HUNK_HEADER.test(line)
    || line.startsWith("+")
    || line.startsWith("-")
    || line.startsWith(" ")
    || line === "";
}

function rewriteCodexFileOpLine(line: string): string {
  for (const prefix of ["*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"] as const) {
    if (!line.startsWith(prefix)) continue;
    const path = normalizePatchPath(line.slice(prefix.length).replace(/^\s+/, ""));
    return path ? `${prefix} ${path}` : line;
  }
  return line;
}

function normalizeAddFileBody(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inAdd = false;
  for (const line of lines) {
    if (line.startsWith("*** Add File:")) {
      inAdd = true;
      out.push(line);
      continue;
    }
    if (isCodexFileOpLine(line)) {
      inAdd = false;
      out.push(line);
      continue;
    }
    if (inAdd && (line === "@@" || line.startsWith("@@ ") || GIT_HUNK_HEADER.test(line))) continue;
    if (inAdd && line.length > 0 && !line.startsWith("+")) {
      out.push(`+${line}`);
      continue;
    }
    out.push(line);
  }
  return out;
}

function hasNonEmptyCodexOp(lines: readonly string[]): boolean {
  let kind: "add" | "update" | "delete" | undefined;
  let hunk = false;
  let any = false;
  const flush = () => {
    if (kind === "delete" || ((kind === "add" || kind === "update") && hunk)) any = true;
  };
  for (const line of lines) {
    if (line.startsWith("*** Update File:")) {
      flush();
      kind = "update";
      hunk = false;
      continue;
    }
    if (line.startsWith("*** Add File:")) {
      flush();
      kind = "add";
      hunk = false;
      continue;
    }
    if (line.startsWith("*** Delete File:")) {
      flush();
      kind = "delete";
      hunk = false;
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line === "@@" || line.startsWith("@@ ")) hunk = true;
  }
  flush();
  return any;
}

function trimEmptyEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start++;
  while (end > start && lines[end - 1] === "") end--;
  return lines.slice(start, end);
}

function cleanHunkLines(lines: readonly string[]): string[] {
  return trimEmptyEdges(
    lines
      .filter(line =>
        !isGitPreambleLine(line)
        && !isFenceLine(line)
        && line !== PATCH_BEGIN
        && line !== PATCH_END
        && !isCodexFileOpLine(line)
        && !line.startsWith("*** Move to:")
      )
      .map(rewriteHunkHeader)
      .filter(line => isHunkBodyLine(line)),
  );
}

function isGitSectionStart(line: string, splitOnDiffGit: boolean): boolean {
  if (splitOnDiffGit) return line.startsWith("diff --git ");
  return /^(--- )(?:\/dev\/null|"a\/|a\/)/.test(line);
}

function splitGitSections(lines: readonly string[]): string[][] {
  const splitOnDiffGit = lines.some(line => line.startsWith("diff --git "));
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (isGitSectionStart(line, splitOnDiffGit) && current.length > 0) {
      sections.push(current);
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

function isGitBinarySection(lines: readonly string[]): boolean {
  return lines.some(line => /^Binary files /.test(line) || line.startsWith("GIT binary patch"));
}

function isGitCopySection(lines: readonly string[]): boolean {
  return lines.some(line => line.startsWith("copy from ") || line.startsWith("copy to "));
}

function isGitEmptyRenameSection(lines: readonly string[]): boolean {
  const hasRenameMeta = lines.some(line => line.startsWith("rename from ") || line.startsWith("rename to "));
  const diff = lines.map(parseDiffGitPaths).find(path => path !== undefined);
  if (!hasRenameMeta && !(diff && diff.a !== diff.b)) return false;
  const body = cleanHunkLines(lines);
  return !body.some(line => line === "@@" || line.startsWith("@@ ") || line.startsWith("+") || line.startsWith("-"));
}

function isGitUntranslatableSection(lines: readonly string[]): boolean {
  return isGitBinarySection(lines) || isGitCopySection(lines) || isGitEmptyRenameSection(lines);
}

function convertGitSection(lines: readonly string[]): string[] | undefined {
  if (isGitBinarySection(lines)) return undefined;
  const existingOp = lines.find(isCodexFileOpLine);
  if (existingOp) {
    const move = lines.filter(line => line.startsWith("*** Move to:"));
    return [existingOp, ...move, ...cleanHunkLines(lines)];
  }
  const diffPaths = lines.map(parseDiffGitPaths).find(path => path !== undefined);
  const plusPath = lines.map(line => parseGitSidePath(line, "b")).find(path => path !== undefined);
  const minusPath = lines.map(line => parseGitSidePath(line, "a")).find(path => path !== undefined);
  const renameFrom = lines.find(line => line.startsWith("rename from "))?.slice("rename from ".length);
  const renameTo = lines.find(line => line.startsWith("rename to "))?.slice("rename to ".length);
  const plusIsNull = lines.some(line => line.startsWith("+++ ") && isDevNull(line));
  const minusIsNull = lines.some(line => line.startsWith("--- ") && isDevNull(line));
  const isNewFile = lines.some(line => line.startsWith("new file mode ")) || minusIsNull;
  const isDeleted = lines.some(line => line.startsWith("deleted file mode ")) || plusIsNull;
  const pathA = minusPath ?? (renameFrom ? unquoteGitPath(renameFrom) : undefined) ?? diffPaths?.a;
  const pathB = plusPath ?? (renameTo ? unquoteGitPath(renameTo) : undefined) ?? diffPaths?.b;
  const body = cleanHunkLines(lines);
  if (isDeleted) {
    const path = pathA ?? pathB;
    return path ? [`*** Delete File: ${path}`] : undefined;
  }
  if (isNewFile) {
    const path = pathB ?? pathA;
    if (!path) return undefined;
    return [`*** Add File: ${path}`, ...body.filter(line => line.startsWith("+"))];
  }
  const hasMinus = body.some(line => line.startsWith("-"));
  if (plusPath && !minusPath && !diffPaths && !hasMinus) {
    return [`*** Add File: ${plusPath}`, ...body.filter(line => line.startsWith("+"))];
  }
  const from = (renameFrom ? unquoteGitPath(renameFrom) : undefined) ?? pathA ?? pathB;
  const to = (renameTo ? unquoteGitPath(renameTo) : undefined) ?? pathB;
  if (!from) return undefined;
  const hasHunk = body.some(line => line === "@@" || line.startsWith("@@ ") || line.startsWith("+") || line.startsWith("-"));
  // Codex 0.147 rejects "Update file hunk ... is empty" (mode-only diffs, 100% renames).
  if (!hasHunk) return undefined;
  const header = [`*** Update File: ${from}`];
  if (to && to !== from) header.push(`*** Move to: ${to}`);
  return [...header, ...body];
}

function hasCodexFileOp(lines: readonly string[]): boolean {
  return lines.some(isCodexFileOpLine);
}

/** Grammar-only repair for Cursor-emitted freeform apply_patch. Not a fuzzy filesystem apply. */
export function sanitizeCodexApplyPatch(patch: string): string {
  const trimmed = patch.replace(/^\uFEFF/, "").replace(/\n+$/, "");
  const rawLines = trimmed.split("\n").map(line => canonicalizeCodexLine(line.endsWith("\r") ? line.slice(0, -1) : line));
  const hasCodex = rawLines.some(isCodexFileOpLine);
  const hasGitHeaders = rawLines.some(line => line.startsWith("diff --git ") || GIT_FILE_HEADER.test(line));
  if (hasGitHeaders && !hasCodex) {
    const sections = splitGitSections(rawLines);
    // A binary hunk cannot be expressed in Codex apply_patch. Leave the original
    // text alone rather than wrapping the text files and dropping the binary one.
    if (sections.some(isGitUntranslatableSection)) return patch.replace(/^\uFEFF/, "");
    const ops = sections
      .map(convertGitSection)
      .filter((section): section is string[] => section !== undefined && hasCodexFileOp(section))
      .map(normalizeAddFileBody);
    if (ops.length > 0) return [PATCH_BEGIN, ...ops.flat(), PATCH_END].join("\n");
  }
  const selected: string[] = [];
  let inAdd = false;
  for (const raw of rawLines) {
    if (isGitPreambleLine(raw) || isFenceLine(raw) || raw === PATCH_BEGIN || raw === PATCH_END) continue;
    const line = rewriteCodexFileOpLine(rewriteHunkHeader(raw));
    if (line.startsWith("*** Add File:")) {
      inAdd = true;
      selected.push(line);
      continue;
    }
    if (isCodexFileOpLine(line)) {
      inAdd = false;
      selected.push(line);
      continue;
    }
    if (line.startsWith("*** Move to:") || isHunkBodyLine(line) || (inAdd && line.length > 0)) {
      selected.push(line);
    }
  }
  const lines = normalizeAddFileBody(trimEmptyEdges(selected));
  const looksLikePatch = lines.some(line =>
    line === "@@"
    || line.startsWith("@@ ")
    || isCodexFileOpLine(line)
  );
  if (!looksLikePatch) return patch.replace(/^\uFEFF/, "");
  // A hunk with no file op is not a valid Codex patch. Do not invent Begin/End around it.
  if (!hasCodexFileOp(lines)) return lines.join("\n");
  if (!hasNonEmptyCodexOp(lines)) return patch.replace(/^\uFEFF/, "");
  return [PATCH_BEGIN, ...lines, PATCH_END].join("\n");
}

function coercePatchInput(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try {
        const inner: unknown = JSON.parse(trimmed);
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          const record = inner as Record<string, unknown>;
          if (typeof record.input === "string") return record.input;
          if (Array.isArray(record.input) && record.input.every(item => typeof item === "string")) {
            return record.input.join("\n");
          }
        }
      } catch {
        // The string is the patch, not nested JSON.
      }
    }
    return value;
  }
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value.join("\n");
  return undefined;
}

export function sanitizeEmittedApplyPatchArgs(argsText: string): string {
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const raw = coercePatchInput(record.input) ?? coercePatchInput(record.patch) ?? coercePatchInput(record.content);
      if (raw !== undefined) {
        const input = sanitizeCodexApplyPatch(raw);
        if (input !== record.input) {
          const next: Record<string, unknown> = { ...record, input };
          delete next.patch;
          delete next.content;
          return JSON.stringify(next);
        }
      }
    }
  } catch {
    if (
      argsText.includes("@@")
      || argsText.includes("***")
      || argsText.includes("diff --git")
      || argsText.includes("--- a/")
      || argsText.includes("+++ b/")
      || argsText.includes("--- /dev/null")
    ) {
      return JSON.stringify({ input: sanitizeCodexApplyPatch(argsText) });
    }
  }
  return argsText;
}

function firstStringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstStringOrLines(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string")) {
      return value.join("\n");
    }
  }
  return undefined;
}

/** Split a replacement into patch lines, ignoring one trailing newline (line-based patch semantics). */
function patchLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Models often copy indent in old_string and omit it in new_string. Codex trim-matches the
 * old line and writes new_string verbatim, which strips indent. Copy old leading whitespace
 * onto a flush-left new line of the same line count. Do not change a new line that already
 * has indent (intentional dedent stays possible).
 */
function restoreFlushLeftIndent(oldString: string, newString: string): string {
  const oldLines = patchLines(oldString);
  const newLines = patchLines(newString);
  if (oldLines.length !== newLines.length || oldLines.length === 0) return newString;
  // If the only difference is leading whitespace, the edit IS a deliberate
  // indent change — restoring old indent would erase the user's intent.
  const contentSame = oldLines.every((ol, i) => ol.trimStart() === newLines[i].trimStart());
  const whitespaceDiffers = oldLines.some((ol, i) => {
    const oldLead = /^[ \t]*/.exec(ol)?.[0] ?? "";
    const newLead = /^[ \t]*/.exec(newLines[i])?.[0] ?? "";
    return oldLead !== newLead;
  });
  if (contentSame && whitespaceDiffers) return newString;
  return newLines.map((line, i) => {
    const oldLead = /^[ \t]*/.exec(oldLines[i])?.[0] ?? "";
    const newLead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (oldLead.length > 0 && newLead.length === 0 && line.length > 0) return oldLead + line;
    return line;
  }).join("\n");
}

function addFilePatch(path: string, newString: string): StructuredEditTranslation {
  const newLines = patchLines(newString);
  if (newLines.length === 0) {
    return { error: "structured edit requires a non-empty old_string; an empty replacement is not a valid edit" };
  }
  return { patch: [PATCH_BEGIN, `*** Add File: ${path}`, ...newLines.map(line => `+${line}`), PATCH_END].join("\n") };
}

/** One `@@` hunk replacing `oldString` with `newString`. */
function replacementHunk(oldString: string, newString: string): { hunk: string } | { error: string } {
  if (oldString.length === 0) {
    return {
      error:
        "structured edit requires a non-empty old_string to locate the replacement; for new files or insertions without existing text, call apply_patch with an `*** Add File` / context hunk or use the shell bridge",
    };
  }
  const oldLines = patchLines(oldString);
  const rawNewLines = patchLines(newString);
  // Line-based patch semantics cannot express an edit that only adds or removes the file's
  // final newline, and an old/new pair that normalizes to the same lines is a silent no-op —
  // reject it rather than emitting an empty hunk that apply_patch would drop.
  if (oldLines.length === 0 && rawNewLines.length === 0) {
    return { error: "structured edit requires a non-empty old_string; an empty replacement is not a valid edit" };
  }
  // Check for no-op against the RAW new_string (before indent restoration) so that
  // intentional dedent edits are not falsely classified as identical.
  if (oldLines.length === rawNewLines.length && oldLines.every((line, i) => line === rawNewLines[i])) {
    return { error: "structured edit old_string and new_string are identical after line normalization; the replacement is a no-op and was dropped" };
  }
  const restoredNew = restoreFlushLeftIndent(oldString, newString);
  const newLines = patchLines(restoredNew);
  const removed = oldLines.map(line => `-${line}`);
  const added = newLines.map(line => `+${line}`);
  return { hunk: ["@@", ...removed, ...added].join("\n") };
}

/**
 * Convert a completed Cursor structured edit call (`edit_file` / `multi_edit`) into a valid Codex
 * apply_patch freeform payload (#1017). Cursor-trained models cannot emit Codex's freeform patch
 * grammar, so the adapter advertises exact-match replacement tools and performs the grammar here.
 * Returns `{ patch }` for a valid conversion, `{ error }` for a malformed call (which must never be
 * relayed verbatim: Codex would reject it locally after the HTTP 200, the reported failure mode),
 * and `undefined` for tools that are not structured edits.
 */
export type StructuredEditTranslation =
  | { patch: string; error?: undefined }
  | { error: string; patch?: undefined };

export function translateStructuredEditCall(
  toolName: string,
  argsText: string,
): StructuredEditTranslation | undefined {
  if (!isCursorStructuredEditToolName(toolName)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    return {
      error: `${toolName} arguments were not valid JSON; the call was dropped. ${
        toolName === CURSOR_MULTI_EDIT_TOOL
          ? "Use file_path and edits[] (each edit with old_string and new_string)."
          : "Use file_path, old_string and new_string."
      }`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${toolName} arguments must be a JSON object; the call was dropped.` };
  }
  const args = parsed as Record<string, unknown>;
  const rawPath = firstStringArg(args, PATH_ARG_KEYS);
  const path = rawPath ? normalizePatchPath(rawPath) : undefined;
  if (!path) {
    return { error: `${toolName} is missing a non-empty file_path; the call was dropped.` };
  }
  if (/[\n\r\0]/.test(path)) {
    return { error: `${toolName} file_path must not contain a newline, CR, or NUL; the call was dropped.` };
  }
  if (args.replace_all === true || args.replaceAll === true) {
    return {
      error:
        `${toolName} replace_all is not supported; Codex apply_patch first-matches only. Split into unique old_string hunks or include more surrounding lines.`,
    };
  }
  if (args.delete_file === true || args.deleteFile === true) {
    return { patch: [PATCH_BEGIN, `*** Delete File: ${path}`, PATCH_END].join("\n") };
  }
  const hunks: string[] = [];
  const addReplacement = (record: Record<string, unknown>): StructuredEditTranslation => {
    const oldString = firstStringOrLines(record, OLD_STRING_KEYS);
    const newString = firstStringOrLines(record, NEW_STRING_KEYS);
    if (oldString === undefined || newString === undefined) {
      return { error: `${toolName} requires old_string and new_string; the call was dropped.` };
    }
    const hunk = replacementHunk(oldString, newString);
    if ("error" in hunk) return { error: hunk.error };
    return { patch: hunk.hunk };
  };
  if (toolName === CURSOR_MULTI_EDIT_TOOL) {
    let edits: unknown = args.edits;
    if (typeof edits === "string") {
      try {
        edits = JSON.parse(edits);
      } catch {
        return { error: "multi_edit edits were not valid JSON; the call was dropped." };
      }
    }
    if (!Array.isArray(edits) || edits.length === 0) {
      return { error: "multi_edit requires a non-empty edits array; the call was dropped." };
    }
    // Cap edit count to prevent quadratic CPU exhaustion in the fold and overlap scans.
    if (edits.length > 500) {
      return { error: "multi_edit exceeds the 500-edit limit; split into smaller batches." };
    }
    const pairs: StructuredEditPair[] = [];
    for (const edit of edits) {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
        return { error: "multi_edit edits entries must be objects with old_string and new_string; the call was dropped." };
      }
      const record = edit as Record<string, unknown>;
      if (record.replace_all === true || record.replaceAll === true) {
        return {
          error:
            "multi_edit replace_all is not supported; Codex apply_patch first-matches only. Split into unique old_string hunks or include more surrounding lines.",
        };
      }
      const oldString = firstStringOrLines(record, OLD_STRING_KEYS);
      const newString = firstStringOrLines(record, NEW_STRING_KEYS);
      if (oldString === undefined || newString === undefined) {
        return { error: `${toolName} requires old_string and new_string; the call was dropped.` };
      }
      pairs.push({ old_string: oldString, new_string: newString });
    }
    const folded = foldSequentialStructuredEdits(pairs);
    const seenOld = new Set<string>();
    for (const edit of folded) {
      const oldKey = patchLines(edit.old_string).join("\n");
      if (seenOld.has(oldKey)) {
        return {
          error:
            "multi_edit has two edits with the same old_string after line normalization; Codex apply_patch first-matches, so both hunks would hit the same location. Include more surrounding lines to disambiguate.",
        };
      }
      seenOld.add(oldKey);
    }
    for (let i = 0; i < folded.length; i++) {
      for (let j = 0; j < folded.length; j++) {
        if (i === j || folded[j].old_string.length === 0) continue;
        if (lineBlockIndex(folded[i].old_string, folded[j].old_string) >= 0) {
          return {
            error:
              "multi_edit hunks overlap: one old_string is a whole-line subset of another. Codex apply_patch matches every hunk against the original file, so both would first-match the same region. Include more surrounding lines to disambiguate.",
          };
        }
      }
    }
    if (folded.length === 1 && folded[0].old_string.length === 0) {
      return addFilePatch(path, folded[0].new_string);
    }
    if (folded.some(edit => edit.old_string.length === 0)) {
      return {
        error:
          "multi_edit cannot mix an Add File (empty old_string) with an independent Update hunk on the same path; put the full new-file contents in one empty-old_string edit, or create the file first.",
      };
    }
    for (const edit of folded) {
      const hunk = replacementHunk(edit.old_string, edit.new_string);
      if ("error" in hunk) return { error: hunk.error };
      hunks.push(hunk.hunk);
    }
  } else {
    const oldString = firstStringOrLines(args, OLD_STRING_KEYS);
    const newString = firstStringOrLines(args, NEW_STRING_KEYS);
    if (oldString === "") {
      if (newString === undefined) {
        return { error: `${toolName} requires old_string and new_string; the call was dropped.` };
      }
      return addFilePatch(path, newString);
    }
    const editResult = addReplacement(args);
    if (editResult.error !== undefined) return editResult;
    hunks.push(editResult.patch);
  }
  return { patch: [PATCH_BEGIN, `*** Update File: ${path}`, ...hunks, PATCH_END].join("\n") };
}

export function mapSyntheticMcpExecToToolEvents(
  args: McpArgs,
  fallbackCallId = "cursor_mcp_exec",
  options: { allowEmptyArgs?: boolean; state?: CursorProtobufEventState } = {},
): CursorServerMessage[] {
  if (args.providerIdentifier !== OCX_RESPONSES_TOOL_PROVIDER) return [];
  if (options.state?.terminated) return [];
  if (options.allowEmptyArgs !== true && !hasMcpArgBytes(args)) return [];
  const cursorWireName = mcpWireNameFromArgs(args);
  if (!cursorWireName) return [{ type: "error", message: "Cursor requested a Responses tool without a tool name" }];
  const callId = args.toolCallId || fallbackCallId;
  if (options.state?.completedToolCalls.has(callId)) return [];
  if (options.state) {
    // Native-exec delivers the whole client tool call at once. Record it (no-op if already opened by
    // an earlier started/partial event), then emit the atomic start -> delta -> end unit.
    const out: CursorServerMessage[] = [...recordToolCall(options.state, callId, cursorWireName)];
    if (out.some(event => event.type === "error")) return out;
    const open = options.state.openToolCalls.get(callId);
    const finalArgs = resolveCompletedArgs(open?.args ?? "", args, options.state);
    out.push(...commitToolCall(options.state, callId, finalArgs));
    return out;
  }
  const responsesName = responsesToolNameFromCursorWire(cursorWireName);
  const normSchema = defaultShellBridgeArgNormalizeSchema(responsesName);
  const normalizedArgs = JSON.stringify(normalizeArgKeys(decodeCursorArgsMap(args?.args), normSchema));
  if (!cursorShellBridgeArgsValid(normalizedArgs, responsesName, normSchema)) {
    if (isCodexShellBridgeToolName(responsesName)) {
      return [{ type: "error", message: cursorShellBridgeDropError(responsesName) }];
    }
  }
  // Stateless fallback (no shared event state): emit a complete, self-contained tool call.
  //
  // No conversion happens here by design (#1036 review). Structured-edit translation is gated on
  // provenance — did WE advertise this bare name on THIS request — and that record lives on the
  // request state, which this branch does not have. Converting anyway would reinstate the exact
  // hazard the gate exists to close: a client or MCP tool legitimately named `edit_file` would be
  // rewritten into an apply_patch it never asked for. The live path always carries state
  // (live-transport seeds it), so this only affects direct/unit callers.
  const emittedName = responsesName;
  const emittedArgs = normalizedArgs;
  return [
    { type: "tool_call_start", id: callId, name: emittedName },
    ...(emittedArgs.length > 2
      ? [{ type: "tool_call_delta" as const, arguments: emittedArgs }]
      : []),
    { type: "tool_call_end", id: callId },
  ];
}

/**
 * Record (open) a client tool call WITHOUT emitting `tool_call_start`. The outward start is deferred
 * to completion (see commitToolCall) so each Cursor tool call surfaces to the bridge as one atomic,
 * self-contained start -> delta -> end unit. This lets Cursor open several tool calls in parallel
 * (or interleave their partial-arg streams) without cross-wiring: nothing reaches the single-current-
 * call bridge until a call completes, and completed calls are emitted whole, one after another.
 * Returns an error only for a genuinely unknown (un-advertised) tool name.
 */
function recordToolCall(state: CursorProtobufEventState, callId: string, cursorWireName: string): CursorServerMessage[] {
  if (state.completedToolCalls.has(callId)) return [];
  if (state.openToolCalls.has(callId)) return [];
  const advertisedName = resolveAdvertisedClientToolName(state, cursorWireName);
  if (state.clientToolNames && !advertisedName) {
    return [{ type: "error", message: `Cursor requested unknown Responses tool: ${cursorWireName}` }];
  }
  if (state.startedClientToolCalls >= state.maxClientToolCalls) {
    return [{ type: "error", message: `Cursor exceeded client tool-call limit (${state.maxClientToolCalls})` }];
  }
  // Prefer the advertised catalog name for Responses mapping so shell_command/exec_command aliases
  // land on the tool Codex actually exposed this turn (#399).
  const mapKey = advertisedName ?? normalizeCursorWireName(cursorWireName);
  state.openToolCalls.set(callId, { name: responsesToolNameFromCursorWire(mapKey, state.cursorToolNameMap), args: "" });
  state.translatorBudget?.openCall(callId);
  state.startedClientToolCalls++;
  return [];
}

/**
 * Emit a completed client tool call as one atomic unit: `tool_call_start` (deferred from open time),
 * the full normalized arguments delta when present, then `tool_call_end`. The call must already be
 * recorded in `openToolCalls`. Because each completion emits a whole non-interleaved unit, the bridge
 * (which tracks a single current tool call) serializes parallel Cursor calls correctly.
 */
function cursorFreeformWrapperValid(args: string): boolean {
  try {
    const parsed = JSON.parse(args) as unknown;
    return !!parsed
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && typeof (parsed as Record<string, unknown>).input === "string";
  } catch {
    return false;
  }
}

function dropInvalidFreeformCall(state: CursorProtobufEventState, callId: string, toolName: string): CursorServerMessage[] {
  state.openToolCalls.delete(callId);
  state.translatorBudget?.closeCall(callId);
  state.completedToolCalls.add(callId);
  return [{ type: "error", message: `${toolName} call had invalid freeform arguments; expected {input:string}` }];
}

function dropShellBridgeCall(state: CursorProtobufEventState, callId: string, toolName: string): CursorServerMessage[] {
  state.openToolCalls.delete(callId);
  state.translatorBudget?.closeCall(callId);
  state.completedToolCalls.add(callId);
  return [{ type: "error", message: cursorShellBridgeDropError(toolName) }];
}

function dropStructuredEditCall(state: CursorProtobufEventState, callId: string, toolName: string, reason: string): CursorServerMessage[] {
  state.openToolCalls.delete(callId);
  state.translatorBudget?.closeCall(callId);
  state.completedToolCalls.add(callId);
  // Recoverable: a fatal adapter error becomes response.failed / upstream_server_error and
  // the model never sees the reason. Completing with text keeps the turn alive (#1388).
  return [{ type: "text", text: `\n${toolName} call was not converted to apply_patch: ${reason}` }];
}

function commitToolCall(state: CursorProtobufEventState, callId: string, finalArgs: string): CursorServerMessage[] {
  const open = state.openToolCalls.get(callId);
  if (!open) return [];
  if (state.freeformToolNames?.has(open.name) && !cursorFreeformWrapperValid(finalArgs)) {
    return dropInvalidFreeformCall(state, callId, open.name);
  }
  const schema = toolSchemaForWireName(state, open.name);
  if (!cursorShellBridgeArgsValid(finalArgs, open.name, schema)) {
    if (isCodexShellBridgeToolName(open.name)) return dropShellBridgeCall(state, callId, open.name);
  }
  // Structured edit calls are converted to apply_patch here so both the interactionUpdate and the
  // native-exec mcpArgs paths emit the same valid freeform payload (#1017).
  const translation = structuredEditCallIsOurs(state.syntheticStructuredEditToolNames, open.name)
    ? translateStructuredEditCall(open.name, finalArgs)
    : undefined;
  if (translation?.error !== undefined) {
    return dropStructuredEditCall(state, callId, open.name, translation.error);
  }
  if (finalArgs !== open.args) {
    const previousBytes = Buffer.byteLength(open.args);
    const reservation = state.translatorBudget?.reserveTransient(
      Buffer.byteLength(finalArgs),
      { kind: "tool_args", callId },
    );
    open.args = finalArgs;
    reservation?.commitRetained();
    state.translatorBudget?.releaseRetained(previousBytes, { kind: "tool_args", callId });
  }
  const emittedName = translation ? CODEX_APPLY_PATCH_TOOL : open.name;
  const rawArgs = translation ? JSON.stringify({ input: translation.patch }) : finalArgs;
  const emittedArgs = emittedName === CODEX_APPLY_PATCH_TOOL ? sanitizeEmittedApplyPatchArgs(rawArgs) : rawArgs;
  const out: CursorServerMessage[] = [{ type: "tool_call_start", id: callId, name: emittedName }];
  if (emittedArgs.length > 0) out.push({ type: "tool_call_delta", arguments: emittedArgs });
  out.push(...endToolCall(state, callId));
  return out;
}

/**
 * Buffer Cursor's cumulative `argsTextDelta` into the open call WITHOUT emitting a delta. Args are
 * emitted once, normalized, at completion (see resolveCompletedArgs), so a mis-keyed or
 * non-canonical streamed blob can still be repaired before Codex sees it. `argsTextDelta` is
 * cumulative; keep the longest value seen.
 */
function bufferToolArgs(state: CursorProtobufEventState, callId: string, cumulative: string): void {
  const open = state.openToolCalls.get(callId);
  if (!open) return;
  if (cumulative.length >= open.args.length) {
    const encoder = new TextEncoder();
    const previousBytes = encoder.encode(open.args).byteLength;
    const reservation = state.translatorBudget?.reserveTransient(
      encoder.encode(cumulative).byteLength,
      { kind: "tool_args", callId },
    );
    open.args = cumulative;
    reservation?.commitRetained();
    state.translatorBudget?.releaseRetained(previousBytes, { kind: "tool_args", callId });
  }
}

function endToolCall(state: CursorProtobufEventState, callId: string): CursorServerMessage[] {
  if (!state.openToolCalls.has(callId)) return [];
  state.openToolCalls.delete(callId);
  state.translatorBudget?.closeCall(callId);
  state.completedToolCalls.add(callId);
  return [{ type: "tool_call_end", id: callId }];
}

export function mapCursorProtobufServerMessage(
  serverMessage: AgentServerMessage,
  state: CursorProtobufEventState,
): CursorServerMessage[] {
  if (state.terminated) return [];

  if (serverMessage.message.case === "conversationCheckpointUpdate") {
    const usedTokens = serverMessage.message.value.tokenDetails?.usedTokens ?? 0;
    // `usedTokens` is the ABSOLUTE conversation context size, not a per-turn output delta. Track it
    // separately (monotonic max) and surface it as `done.usage.totalTokens`; folding it into
    // `outputTokens` (which also accumulates `tokenDelta`) double-counts in Codex. See contextTokens.
    observeContextTokens(state, usedTokens);
    return [];
  }

  if (serverMessage.message.case !== "interactionUpdate") return [];
  const update = serverMessage.message.value.message;
  switch (update.case) {
    case "textDelta":
      return update.value.text ? [{ type: "text", text: update.value.text }] : [];
    case "thinkingDelta":
      return update.value.text ? [{ type: "thinking", thinking: update.value.text }] : [];
    case "toolCallStarted": {
      const name = mcpCursorWireName(update.value.toolCall);
      // Record the open call but defer the outward tool_call_start to completion (atomic emission).
      return name ? recordToolCall(state, update.value.callId, name) : [];
    }
    case "partialToolCall": {
      const out: CursorServerMessage[] = [];
      const name = mcpCursorWireName(update.value.toolCall);
      if (name) out.push(...recordToolCall(state, update.value.callId, name));
      if (out.some(event => event.type === "error")) return out;
      // Buffer cumulative args; do not emit a delta. Args are emitted once, normalized, at completion.
      if (state.openToolCalls.has(update.value.callId)) {
        bufferToolArgs(state, update.value.callId, update.value.argsTextDelta);
      }
      return out;
    }
    case "toolCallDelta":
      // Cursor's typed deltas currently cover native exec internals (shell/task/edit). Client
      // Responses tools return as McpToolCall plus partial args text, so native deltas stay internal.
      return [];
    case "toolCallCompleted": {
      const out: CursorServerMessage[] = [];
      if (state.completedToolCalls.has(update.value.callId)) return [];
      const name = mcpCursorWireName(update.value.toolCall);
      const args = mcpArgsFromToolCall(update.value.toolCall);
      const openBeforeStart = state.openToolCalls.get(update.value.callId);
      // Empty-arg completion handling:
      //  - already-open named ordinary call with no buffered or structured args -> wait for native exec.
      //  - request-declared freeform completion -> wait while its required input wrapper is absent or
      //    incomplete, whether the completion repeats the name or is compact callId-only. A valid
      //    buffered wrapper can commit immediately.
      //    A compact ordinary no-arg call remains legitimate and commits below.
      //  - never started + not advertised -> Cursor prelude noise, drop it.
      //  - advertised client tool, not yet open -> a legitimate no-arg call: commit it (start+end)
      //    so it is not silently dropped; the bridge serializes empty args as "{}".
      if (
        openBeforeStart && !hasMcpArgBytes(args)
        && (
          (name !== undefined && openBeforeStart.args.length === 0)
          || (state.freeformToolNames?.has(openBeforeStart.name) === true
            && !cursorFreeformWrapperValid(openBeforeStart.args)
          )
        )
      ) {
        openBeforeStart.awaitingNativeArgs = true;
        return [];
      }
      if (name && !hasMcpArgBytes(args)) {
        // Only commit a no-arg call when the tool is *explicitly* advertised. Without an advertised
        // tool list we cannot tell a real no-arg call from a Cursor prelude, so we keep dropping it.
        const advertised = state.clientToolNames?.has(name) ?? false;
        if (!openBeforeStart && !advertised) return [];
      }
      // Ensure the call is recorded (covers a completion with no prior started/partial event), then
      // emit it as one atomic start -> delta -> end unit so parallel Cursor calls serialize cleanly.
      if (name) out.push(...recordToolCall(state, update.value.callId, name));
      if (out.some(event => event.type === "error")) return out;
      const open = state.openToolCalls.get(update.value.callId);
      // A request-declared freeform call may first appear only in its completion frame. Record it so
      // later same-ID native mcpArgs can supply the authoritative wrapper, but do not broaden the
      // wait to ordinary advertised no-arg tools: those still commit immediately below.
      if (
        !openBeforeStart && open && !hasMcpArgBytes(args)
        && state.freeformToolNames?.has(open.name) === true
        && !cursorFreeformWrapperValid(open.args)
      ) {
        open.awaitingNativeArgs = true;
        return [];
      }
      if (open) {
        const finalArgs = resolveCompletedArgs(open.args, args, state);
        out.push(...commitToolCall(state, update.value.callId, finalArgs));
      }
      return out;
    }
    case "tokenDelta":
      state.usage.outputTokens += update.value.tokens;
      return [];
    case "turnEnded":
      return finalizeTurnEvents(state);
    default:
      return [];
  }
}

/**
 * Resolve the usage to report for a turn, in order of trustworthiness: a checkpoint
 * observed this turn, then the session carry-forward, then the request-local estimate,
 * then the raw per-turn counters. Shared with the partial-usage path in live-transport
 * so a failed turn reports the same input side as a clean one (#373).
 */
export function resolvedTurnUsage(state: CursorProtobufEventState): OcxUsage {
  const contextTokens = reportableContextTokens(state);
  if (contextTokens !== undefined) return usageFromContextTokens(state, contextTokens);
  const estimate = state.estimatedInputTokens;
  if (estimate !== undefined) {
    return {
      ...state.usage,
      inputTokens: estimate,
      totalTokens: estimate + state.usage.outputTokens,
      estimated: true,
    };
  }
  return { ...state.usage };
}

/**
 * Finalize a Cursor turn. If any client tool call is still open (started but never completed),
 * the stream was truncated and the partial tool call must not reach Codex as a completed call
 * with corrupt/empty arguments. Emit an explicit error instead of done (fail-closed).
 * Mirrors kiro-truncation.ts behavior.
 */
export function finalizeTurnEvents(state: CursorProtobufEventState): CursorServerMessage[] {
  state.terminated = true;
  if (state.openToolCalls.size > 0) {
    const openCallIds = [...state.openToolCalls.keys()];
    const openIds = openCallIds.join(", ");
    // Clear so a second turnEnded (should not happen, but defensive) doesn't re-emit.
    for (const callId of openCallIds) state.translatorBudget?.closeCall(callId);
    state.openToolCalls.clear();
    return [{ type: "error", message: `Cursor stream ended with incomplete tool call(s): ${openIds}. Arguments may be truncated; the call was not committed.` }];
  }
  // Surface the absolute context size (when Cursor reported a checkpoint) as both totalTokens and
  // the estimated input side of Codex's visible `input + output` counter. Codex status lines can
  // render the additive pair instead of total_tokens, so leaving inputTokens at 0 makes a 16k-context
  // first turn display as "9 used". Keep outputTokens as the per-turn delta and clamp the inferred
  // input to 0 in case Cursor reports a checkpoint smaller than the streamed output delta.
  return [{ type: "done", usage: resolvedTurnUsage(state) }];
}
