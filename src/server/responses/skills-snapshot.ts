/**
 * runtime skills catalog session snapshotting (#5569).
 *
 * Preserves the Anthropic/LLM prompt cache prefix across turns by freezing
 * incoming <skills_instructions> for the duration of a trustworthy session.
 * Gated by config `skills.catalog_refresh`: "per_session" (default) or "per_turn".
 *
 * Lifecycle & Bounds:
 * - 4 hours idle TTL (sliding on access)
 * - 1,000 maximum tracked sessions (LRU eviction)
 * - 512 KiB maximum per snapshotted skills block
 * - 8 MiB global retained byte bound across all sessions
 */
import type { OcxConfig, SkillsCatalogRefresh } from "../../types/config";
import { isApiAuthRequired, resolveContextPrincipal, type DataPlaneAdmission } from "../auth-cors";
import {
  reasoningReplayConversationIdFromResponsesRequest,
  sessionIdHeaderFromRequest,
} from "../request-log-conversation";

const SKILLS_BLOCK_GLOBAL_REGEX = /<skills_instructions>([\s\S]*?)<\/skills_instructions>/g;

/** Maximum distinct sessions tracked in the memory LRU. */
export const MAX_SNAPSHOT_SESSIONS = 1000;
/** Slide expiry after 4 hours of inactivity. */
export const SNAPSHOT_TTL_MS = 4 * 60 * 60 * 1000;
/** Bounded byte ceiling per snapshotted skills block (512 KiB). */
export const MAX_SKILLS_BLOCK_BYTES = 512 * 1024;
/** Global retained byte bound across all tracked sessions (8 MiB). */
export const MAX_TOTAL_RETAINED_BYTES = 8 * 1024 * 1024;

interface SnapshotEntry {
  skillsBlock: string; // The full <skills_instructions>...</skills_instructions> block
  byteLength: number;
  lastAccessed: number;
}

const snapshotCache = new Map<string, SnapshotEntry>();
let totalRetainedBytes = 0;

function evictOldestEntry(): boolean {
  const oldest = snapshotCache.entries().next().value;
  if (!oldest) return false;
  const [key, entry] = oldest;
  totalRetainedBytes -= entry.byteLength;
  snapshotCache.delete(key);
  return true;
}

export function resolveSkillsCatalogRefresh(config: OcxConfig | undefined): SkillsCatalogRefresh {
  const configured = config?.skills?.catalog_refresh;
  if (configured === "per_turn") return "per_turn";
  return "per_session";
}

export interface ResolveSkillsSessionScopeInput {
  req: Request;
  config: OcxConfig;
  admission?: DataPlaneAdmission;
  cursorConversationId?: string;
  promptCacheKeyIsSharedCohort?: boolean;
}

/**
 * The principal a snapshot is scoped to. Without a named principal, only a server that requires
 * no data-plane auth may share by conversation id (loopback admission, or an internal caller that
 * passed none on such a server): its callers already share one trust domain, which on a no-auth
 * server bound beyond loopback includes remote callers. Any other anonymous request gets no
 * snapshot.
 */
function snapshotPrincipal(input: ResolveSkillsSessionScopeInput): string | null | undefined {
  const principal = resolveContextPrincipal(input.req, input.config, input.admission);
  if (principal) return principal;
  if (input.admission) return input.admission.kind === "loopback" ? null : undefined;
  return isApiAuthRequired(input.config) ? undefined : null;
}

/**
 * Resolves a trustworthy cache key for skills catalog snapshotting.
 * Returns null if no specific, reliable thread/session identity is available,
 * or if the identity comes from a shared cohort fallback.
 */
export function resolveSkillsSnapshotScopeKey(input: ResolveSkillsSessionScopeInput): string | null {
  if (input.promptCacheKeyIsSharedCohort === true) {
    return null;
  }

  const parentThread = input.req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const ownThreadId = input.req.headers.get("thread-id")?.trim() || undefined;
  const cursorId = input.cursorConversationId?.trim() || undefined;

  // When a parent thread is present, subagents/children may share a root session-id header.
  // To prevent cross-thread/sibling collapse or parent-level caching, require an explicit
  // own thread-id (or cursor id). If parentThread is present without an own child thread,
  // bypass snapshotting completely.
  if (parentThread) {
    const childId = ownThreadId ?? cursorId;
    if (!childId || childId === parentThread) {
      return null;
    }
    const qualifiedId = `${parentThread}\u0000${childId}`;
    const principal = snapshotPrincipal(input);
    if (principal === undefined) return null;
    return JSON.stringify(["skills_catalog_snapshot_v1", principal, qualifiedId]);
  }

  // Standalone conversation (no parent thread)
  const standaloneId = reasoningReplayConversationIdFromResponsesRequest({
    threadIdHeader: ownThreadId,
    cursorConversationId: cursorId,
    sessionIdHeader: sessionIdHeaderFromRequest(input.req.headers),
  });
  if (!standaloneId) {
    return null;
  }
  const principal = snapshotPrincipal(input);
  if (principal === undefined) return null;
  return JSON.stringify(["skills_catalog_snapshot_v1", principal, standaloneId]);
}

/** One text slot that may carry a catalog: `instructions` or a developer/system text part. */
interface CatalogSlot {
  text: string;
  write(next: string): void;
}

/** Every developer/system text slot, walked the same way the replacement writes. */
function catalogSlots(body: Record<string, unknown>): CatalogSlot[] {
  const slots: CatalogSlot[] = [];
  if (typeof body.instructions === "string") {
    slots.push({ text: body.instructions, write: next => { body.instructions = next; } });
  }
  if (!Array.isArray(body.input)) return slots;
  for (const item of body.input) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    // Restrict message item type: must be undefined or "message", so role-like tool objects are untouched
    if (it.type !== undefined && it.type !== "message") continue;
    // Only developer and system content is inspected/transformed
    if (it.role !== "developer" && it.role !== "system") continue;
    const content = it.content;
    if (typeof content === "string") {
      slots.push({ text: content, write: next => { it.content = next; } });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        // Restrict text parts to known text / input_text
        if (p.type !== "text" && p.type !== "input_text") continue;
        if (typeof p.text === "string") slots.push({ text: p.text, write: next => { p.text = next; } });
      }
    }
  }
  return slots;
}

function liveSnapshot(scopeKey: string, now: number): SnapshotEntry | undefined {
  const existing = snapshotCache.get(scopeKey);
  if (!existing) return undefined;
  if (now - existing.lastAccessed > SNAPSHOT_TTL_MS) {
    totalRetainedBytes -= existing.byteLength;
    snapshotCache.delete(scopeKey);
    return undefined;
  }
  existing.lastAccessed = now;
  // Refresh Map order for true LRU behavior
  snapshotCache.delete(scopeKey);
  snapshotCache.set(scopeKey, existing);
  return existing;
}

function storeSnapshot(scopeKey: string, skillsBlock: string, now: number): void {
  const blockBytes = Buffer.byteLength(skillsBlock, "utf8");
  if (blockBytes > MAX_SKILLS_BLOCK_BYTES || blockBytes > MAX_TOTAL_RETAINED_BYTES) return;
  // A concurrent request of the same conversation may have stored first; the first catalog wins.
  if (snapshotCache.has(scopeKey)) return;
  // Evict oldest entries until under count ceiling AND under global byte ceiling
  while (
    (snapshotCache.size >= MAX_SNAPSHOT_SESSIONS || totalRetainedBytes + blockBytes > MAX_TOTAL_RETAINED_BYTES)
    && snapshotCache.size > 0
  ) {
    if (!evictOldestEntry()) break;
  }
  if (totalRetainedBytes + blockBytes > MAX_TOTAL_RETAINED_BYTES) return;
  snapshotCache.set(scopeKey, { skillsBlock, byteLength: blockBytes, lastAccessed: now });
  totalRetainedBytes += blockBytes;
}

/**
 * Reuses the session's snapshotted <skills_instructions> in developer/system content, preserving
 * the prompt cache prefix across turns. User and assistant messages and tool calls are never
 * modified.
 *
 * Only a body with exactly one catalog block across all of those slots takes part: with two or
 * more there is no way to tell which one the snapshot stands for, so the body passes through
 * untouched rather than rewriting every block to one catalog.
 *
 * A known snapshot is substituted at once, so parsing and the verbatim passthrough body both see
 * it. A new catalog is only stored through the returned commit, which the caller runs once the
 * request has passed parsing and admission, so a rejected first request pins nothing.
 */
export function snapshotSkillsCatalogInBody(
  body: unknown,
  scopeKey: string | null,
  config: OcxConfig,
  now: number = Date.now(),
): (() => void) | undefined {
  if (!scopeKey) return undefined;
  if (resolveSkillsCatalogRefresh(config) === "per_turn") return undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;

  let found: { slot: CatalogSlot; block: string } | undefined;
  let blocks = 0;
  for (const slot of catalogSlots(body as Record<string, unknown>)) {
    if (!slot.text.includes("<skills_instructions>")) continue;
    for (const match of slot.text.matchAll(SKILLS_BLOCK_GLOBAL_REGEX)) {
      blocks++;
      found ??= { slot, block: match[0] };
    }
  }
  if (blocks !== 1 || !found) return undefined;

  const existing = liveSnapshot(scopeKey, now);
  if (existing) {
    const { slot, block } = found;
    const at = slot.text.indexOf(block);
    slot.write(slot.text.slice(0, at) + existing.skillsBlock + slot.text.slice(at + block.length));
    return undefined;
  }
  const incoming = found.block;
  return () => storeSnapshot(scopeKey, incoming, now);
}

/** Test helpers */
export function resetSkillsSnapshotCacheForTests(): void {
  snapshotCache.clear();
  totalRetainedBytes = 0;
}

