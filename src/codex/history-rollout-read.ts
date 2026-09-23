import { existsSync, readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

/**
 * Reading side of Codex rollout JSONL files: the `session_meta` fold and the thread fields a
 * quarantine restore reconstructs from a rollout.
 *
 * Split out of `history-provider.ts` when that file crossed the repository file-size ratchet at
 * 2009 lines. The cut follows a real seam rather than a line count: everything here reads a
 * rollout file and returns plain data, while the module it left keeps the database and manifest
 * writes. Nothing here opens a database or touches a backup manifest.
 *
 * `history-provider.ts` re-exports the public names, so existing importers are unaffected.
 */
/**
 * Cap for decompressing a lone `.jsonl.zst` rollout during quarantine restore.
 * Bounds peak memory while reconstructing thread rows; never write the decoded
 * JSONL to disk.
 */
export const MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export interface ParsedSessionMeta {
  record: { type?: unknown; timestamp?: unknown; payload: { model_provider?: unknown; source?: unknown } & Record<string, unknown> };
}

/** Parse one JSONL line into a `session_meta` record, or null if it isn't one. */
export function parseSessionMetaLine(line: string): ParsedSessionMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as ParsedSessionMeta["record"];
  if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object") return null;
  return { record };
}

/**
 * Fields needed to re-insert a production-shaped `threads` row from a rollout JSONL when a
 * Phase-2 quarantine predates full `satellite-backup.json` thread snapshots.
 *
 * Uses the same last-writer-wins `session_meta` fold as {@link readLatestSessionMeta}, plus the
 * first user-message preview (codex-rs `list.rs` / `EventMsg::UserMessage` path).
 */
export interface RolloutThreadFields {
  id: string;
  modelProvider: string;
  source: string;
  firstUserMessage: string;
  hasUserEvent: number;
  cwd?: string;
  historyMode?: string;
  cliVersion?: string;
}

function textFromContentParts(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) return content.trim();
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string" && p.text.trim()) parts.push(p.text.trim());
    else if (typeof p.input_text === "string" && p.input_text.trim()) parts.push(p.input_text.trim());
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

/** Extract the first user-message preview from a rollout line, or null. */
function extractUserMessagePreview(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { type?: unknown; payload?: unknown };
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  if (record.type === "event_msg") {
    // codex-rs EventMsg::UserMessage — payload.type is "user_message" (or omitted in fixtures).
    if (p.type === "user_message" || typeof p.message === "string") {
      if (typeof p.message === "string" && p.message.trim()) return p.message.trim();
      const fromContent = textFromContentParts(p.content);
      if (fromContent) return fromContent;
    }
    return null;
  }

  if (record.type === "response_item") {
    if (p.type === "message" && p.role === "user") {
      return textFromContentParts(p.content);
    }
  }
  return null;
}

/**
 * Reconstruct thread identity + listing fields from a staged/restored rollout JSONL.
 * Returns null when the file is missing or has no parseable `session_meta`.
 *
 * Accepts plain `.jsonl` or a lone `.jsonl.zst` (legacy Phase-2 quarantine). Compressed
 * rollouts are decompressed in memory with {@link MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES};
 * no decompressed copy is written to disk.
 */
export function readThreadFieldsFromRollout(path: string): RolloutThreadFields | null {
  if (!path || !existsSync(path)) return null;
  let raw: string;
  try {
    raw = path.endsWith(".zst")
      ? decompressRolloutZstUtf8(path)
      : readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseThreadFieldsFromRolloutText(raw);
}

function decompressRolloutZstUtf8(
  path: string,
  maxBytes: number = MAX_ROLLOUT_ZST_DECOMPRESSED_BYTES,
): string {
  const compressed = readFileSync(path);
  const decoded = zstdDecompressSync(compressed as Uint8Array<ArrayBuffer>, {
    maxOutputLength: maxBytes,
  });
  if (decoded.byteLength > maxBytes) {
    throw new Error("rollout_zst_too_large");
  }
  return new TextDecoder().decode(decoded);
}

function parseThreadFieldsFromRolloutText(raw: string): RolloutThreadFields | null {
  const lines = raw.split("\n");
  let latest: ParsedSessionMeta | null = null;
  let firstUserMessage = "";
  for (const line of lines) {
    if (!line) continue;
    if (line.includes("\"session_meta\"")) {
      const meta = parseSessionMetaLine(line);
      if (meta) latest = meta;
    }
    if (!firstUserMessage) {
      const preview = extractUserMessagePreview(line);
      if (preview) firstUserMessage = preview;
    }
  }
  if (!latest) return null;
  const payload = latest.record.payload;
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return null;
  const modelProvider = typeof payload.model_provider === "string" && payload.model_provider
    ? payload.model_provider
    : "openai";
  const source = typeof payload.source === "string" && payload.source
    ? payload.source
    : "cli";
  return {
    id,
    modelProvider,
    source,
    firstUserMessage,
    hasUserEvent: firstUserMessage.trim() ? 1 : 0,
    ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
    ...(typeof payload.history_mode === "string" ? { historyMode: payload.history_mode } : {}),
    ...(typeof payload.cli_version === "string" ? { cliVersion: payload.cli_version } : {}),
  };
}
