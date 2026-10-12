/** Privacy-bounded, process-local cache diagnostics. Enable with OPENCODEX_CACHE_DEBUG=1. */
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_AFFINITY_DEBUG_SAFE_HEADERS } from "../codex/affinity-debug";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { CacheTelemetryProvenance } from "./log";

const CACHE_DEBUG_KEY = randomBytes(32);
const MAX_BLOCKS = 128;
const MAX_DRAFTS = 512;
export const CACHE_DEBUG_MAX_LINES = 200;
export const CACHE_DEBUG_KEEP_LINES = 100;

export type PromptCacheKeySource = "caller" | "metadata-derived" | "system-derived" | "proxy-synthesized";
export interface TaggedPresence { present: boolean; tag?: string; source?: PromptCacheKeySource }
export interface TaggedSequence { present: boolean; count: number; tags: string[]; truncated?: true }
export interface PrefixFingerprint {
  instructions: TaggedSequence;
  tools: TaggedSequence;
  messages: TaggedSequence;
}
export interface CacheDiagnosticDraft {
  promptCacheKey?: { inbound?: TaggedPresence; outbound?: TaggedPresence };
  session?: { inboundHeader?: TaggedPresence; outboundHeader?: TaggedPresence };
  prefix?: { inbound?: PrefixFingerprint; outbound?: PrefixFingerprint };
}

export interface CacheDiagnosticFinalFacts {
  requestId: string;
  logicalRequestId?: string;
  protocol: "responses" | "chat" | "messages";
  provider: string;
  model: string;
  accountLogLabel?: string;
  affinityMove?: string;
  affinityReason?: string;
  /**
   * The cache counter exactly as the upstream usage object carried it, read before any
   * client-wire defaulting. Undefined means the upstream object had no cache counter at
   * all, which keeps a measured zero distinct from an absent-then-defaulted zero.
   */
  rawCacheCounterValue?: number;
  normalizedCacheValue?: number;
  cacheProvenance: CacheTelemetryProvenance;
  draft?: CacheDiagnosticDraft;
}

const drafts = new Map<string, CacheDiagnosticDraft>();
const bodyDrafts = new WeakMap<object, CacheDiagnosticDraft>();

export function isCacheDiagnosticEnabled(): boolean {
  return process.env.OPENCODEX_CACHE_DEBUG === "1";
}

export function cacheDiagnosticPath(): string {
  return join(getConfigDir(), "cache-debug.jsonl");
}

function tag(domain: string, value: string): string {
  return createHmac("sha256", CACHE_DEBUG_KEY)
    .update(domain).update("\0").update(value).digest("hex").slice(0, 12);
}

export function tagCacheDiagnosticValue(domain: string, value: string): string {
  return tag(`cache-debug:${domain}`, value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function taggedPresence(value: unknown, domain: string, source?: PromptCacheKeySource): TaggedPresence {
  if (typeof value !== "string" || value.length === 0) return { present: false };
  return { present: true, tag: tag(domain, value), ...(source ? { source } : {}) };
}

function sessionPresence(headers: Headers | HeadersInit): TaggedPresence {
  const normalized = headers instanceof Headers ? headers : new Headers(headers);
  const values = CODEX_AFFINITY_DEBUG_SAFE_HEADERS.flatMap(name => {
    const value = normalized.get(name);
    return value === null ? [] : [[name, value] as const];
  });
  return values.length === 0
    ? { present: false }
    : { present: true, tag: tag("cache-debug:session-headers", canonicalJson(values)) };
}

function sequence(blocks: unknown[], domain: string): TaggedSequence {
  const bounded = blocks.slice(0, MAX_BLOCKS);
  return {
    present: blocks.length > 0,
    count: blocks.length,
    tags: bounded.map(block => tag(domain, canonicalJson(block))),
    ...(blocks.length > MAX_BLOCKS ? { truncated: true as const } : {}),
  };
}

function requestBlocks(body: Record<string, unknown>): { instructions: unknown[]; messages: unknown[] } {
  const instructions = body.instructions;
  // The spread is load-bearing: an array-valued instructions field must be copied, never
  // aliased, because the pushes below would otherwise mutate the live request body that
  // the adapter is about to serialize upstream.
  const instructionRows = instructions === undefined || instructions === null
    ? [] : Array.isArray(instructions) ? [...instructions] : [instructions];
  const input = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const messages: unknown[] = [];
  for (const block of input) {
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const row = block as Record<string, unknown>;
      if (row.role === "system" || row.role === "developer") {
        const content = row.content;
        instructionRows.push(...(Array.isArray(content) ? content : [content]));
        continue;
      }
    }
    messages.push(block);
  }
  return { instructions: instructionRows, messages };
}

export function prefixFingerprint(body: unknown): PrefixFingerprint {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const blocks = requestBlocks(record);
  return {
    instructions: sequence(blocks.instructions, "cache-debug:prefix:instructions"),
    tools: sequence(tools, "cache-debug:prefix:tools"),
    messages: sequence(blocks.messages, "cache-debug:prefix:messages"),
  };
}

function firstDivergence(inbound: PrefixFingerprint, outbound: PrefixFingerprint):
  { section: "instructions" | "tools" | "messages"; index: number } | undefined {
  for (const section of ["instructions", "tools", "messages"] as const) {
    const before = inbound[section].tags;
    const after = outbound[section].tags;
    const compared = Math.min(before.length, after.length);
    for (let index = 0; index < compared; index += 1) {
      if (before[index] !== after[index]) return { section, index };
    }
    if (inbound[section].count !== outbound[section].count) return { section, index: compared };
  }
  return undefined;
}

export function observe(requestId: string, observation: Partial<CacheDiagnosticDraft>): CacheDiagnosticDraft {
  const draft = drafts.get(requestId) ?? {};
  Object.assign(draft, observation);
  drafts.delete(requestId);
  drafts.set(requestId, draft);
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value!);
  return draft;
}

export function observeInbound(
  body: unknown,
  headers: Headers,
  source: PromptCacheKeySource = "caller",
): CacheDiagnosticDraft {
  if (!isCacheDiagnosticEnabled()) return {};
  try {
    const record = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
    const draft: CacheDiagnosticDraft = {
      promptCacheKey: { inbound: taggedPresence(record.prompt_cache_key, "cache-debug:prompt-cache-key", source) },
      session: { inboundHeader: sessionPresence(headers) },
      prefix: { inbound: prefixFingerprint(body) },
    };
    if (body && typeof body === "object") bodyDrafts.set(body, draft);
    return draft;
  } catch {
    return {};
  }
}

/**
 * Alias a later form of the same request body (for example after previous-response
 * expansion) to an existing draft, so the outbound observation at the adapter seam can
 * find it. The inbound fingerprint intentionally stays the literal pre-expansion body.
 */
export function rebindCacheDiagnosticBodyAlias(body: unknown, draft: CacheDiagnosticDraft | undefined): void {
  if (!isCacheDiagnosticEnabled() || !draft) return;
  if (body && typeof body === "object") bodyDrafts.set(body, draft);
}

export function observeOutbound(
  inboundBody: unknown,
  outboundBody: unknown,
  headers: HeadersInit,
  source: PromptCacheKeySource = "proxy-synthesized",
): void {
  if (!isCacheDiagnosticEnabled()) return;
  try {
    if (!inboundBody || typeof inboundBody !== "object") return;
    const draft = bodyDrafts.get(inboundBody);
    if (!draft) return;
    const record = outboundBody && typeof outboundBody === "object" && !Array.isArray(outboundBody)
      ? outboundBody as Record<string, unknown> : {};
    const outbound = taggedPresence(record.prompt_cache_key, "cache-debug:prompt-cache-key", source);
    const inboundKey = draft.promptCacheKey?.inbound;
    if (outbound.present && inboundKey && outbound.tag === inboundKey.tag) {
      outbound.source = inboundKey.source;
    }
    (draft.promptCacheKey ??= {}).outbound = outbound;
    (draft.session ??= {}).outboundHeader = sessionPresence(headers);
    (draft.prefix ??= {}).outbound = prefixFingerprint(outboundBody);
  } catch {
    /* diagnostics must never affect request handling */
  }
}

function ensureDir(): void {
  const dir = getConfigDir();
  recordOwnedConfigPath(dir, cacheDiagnosticPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
}

function trimRollingFile(path: string): void {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length <= CACHE_DEBUG_MAX_LINES) return;
  writeFileSync(path, `${lines.slice(-CACHE_DEBUG_KEEP_LINES).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export function appendFinalCacheDiagnostic(facts: CacheDiagnosticFinalFacts): void {
  if (!isCacheDiagnosticEnabled()) return;
  try {
    const draft = facts.draft ? observe(facts.requestId, facts.draft) : drafts.get(facts.requestId) ?? {};
    drafts.delete(facts.requestId);
    const inboundKey = draft.promptCacheKey?.inbound;
    const outboundKey = draft.promptCacheKey?.outbound;
    const inboundPrefix = draft.prefix?.inbound ?? prefixFingerprint(undefined);
    const outboundPrefix = draft.prefix?.outbound ?? prefixFingerprint(undefined);
    const record = {
      version: 1 as const,
      ts: Date.now(),
      requestId: facts.requestId,
      ...(facts.logicalRequestId ? { logicalRequestId: facts.logicalRequestId } : {}),
      protocol: facts.protocol,
      provider: facts.provider,
      model: facts.model,
      promptCacheKey: {
        inbound: inboundKey ?? { present: false },
        outbound: outboundKey ?? { present: false },
        ...(inboundKey?.present && outboundKey?.present ? { equal: inboundKey.tag === outboundKey.tag } : {}),
      },
      session: {
        inboundHeader: draft.session?.inboundHeader ?? { present: false },
        outboundHeader: draft.session?.outboundHeader ?? { present: false },
      },
      prefix: {
        inbound: inboundPrefix,
        outbound: outboundPrefix,
        ...(firstDivergence(inboundPrefix, outboundPrefix)
          ? { firstDivergentBlock: firstDivergence(inboundPrefix, outboundPrefix) }
          : {}),
      },
      route: {
        provider: facts.provider,
        model: facts.model,
        ...(facts.accountLogLabel
          ? { accountTag: tag("cache-debug:account-log-label", facts.accountLogLabel) }
          : {}),
        ...(facts.affinityMove ? { affinityMove: facts.affinityMove } : {}),
        ...(facts.affinityReason ? { affinityReason: facts.affinityReason } : {}),
      },
      cache: {
        rawUpstream: facts.rawCacheCounterValue !== undefined
          ? { present: true, value: facts.rawCacheCounterValue }
          : { present: false },
        normalized: {
          present: facts.normalizedCacheValue !== undefined,
          ...(facts.normalizedCacheValue !== undefined ? { value: facts.normalizedCacheValue } : {}),
          provenance: facts.cacheProvenance,
        },
      },
    };
    ensureDir();
    const path = cacheDiagnosticPath();
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (existsSync(path)) trimRollingFile(path);
  } catch {
    /* diagnostics must never affect request handling */
  }
}

const CACHE_DIAGNOSTIC_HOOK = Symbol.for("opencodex.cache-diagnostic.v1");
interface CacheDiagnosticHooks {
  observeInbound(body: unknown, headers: Headers, source: PromptCacheKeySource): CacheDiagnosticDraft;
  rebind(body: unknown, draft: CacheDiagnosticDraft | undefined): void;
  finalize(facts: CacheDiagnosticFinalFacts): void;
}
(globalThis as Record<symbol, CacheDiagnosticHooks | undefined>)[CACHE_DIAGNOSTIC_HOOK] = {
  observeInbound,
  rebind: rebindCacheDiagnosticBodyAlias,
  finalize: appendFinalCacheDiagnostic,
};
