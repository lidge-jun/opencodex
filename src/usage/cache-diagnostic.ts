/** Privacy-bounded, process-local cache diagnostics. Enable with OPENCODEX_CACHE_DEBUG=1. */
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexConversationIdentity } from "../codex/lineage";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { CacheTelemetryProvenance } from "./log";

const CACHE_DEBUG_KEY = randomBytes(32);
const MAX_BLOCKS = 128;
const MAX_DRAFTS = 512;
const SESSION_HEADERS = ["session_id", "session-id", "thread-id", "x-session-id"] as const;
type SessionHeaders = Record<typeof SESSION_HEADERS[number], TaggedPresence>;
export const CACHE_DEBUG_MAX_LINES = 200;
export const CACHE_DEBUG_KEEP_LINES = 100;

export type PromptCacheKeySource = "caller" | "metadata-derived" | "system-derived" | "proxy-synthesized";
export interface TaggedPresence { present: boolean; tag?: string; source?: PromptCacheKeySource }
export interface TaggedSequence { present: boolean; count: number; tags: string[]; truncated?: true }
export interface PrefixFingerprint {
  instructions: TaggedSequence;
  tools: TaggedSequence;
  messages: TaggedSequence;
  unsupported?: true;
}
type PrefixSection = "instructions" | "tools" | "messages";
export type PrefixComparison =
  | { status: "first" | "equal" }
  | { status: "append-only" | "different" | "truncated"; section: PrefixSection; index: number }
  | { status: "uncomparable"; reason: "missing-session" | "missing-observation" | "unsupported-shape" };
export interface CacheDiagnosticDraft {
  promptCacheKey?: { inbound?: TaggedPresence; outbound?: TaggedPresence };
  session?: {
    inboundHeader?: TaggedPresence;
    outboundHeader?: TaggedPresence;
    inboundHeaders?: SessionHeaders;
    outboundHeaders?: SessionHeaders;
  };
  prefix?: { inbound?: PrefixFingerprint; outbound?: PrefixFingerprint };
  /** The shared Pool key derivation's result, not a binding lookup or selection decision. */
  accountAffinity?: { inbound?: TaggedPresence; outbound?: TaggedPresence };
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
// Internal only: neither the caller principal nor its tag belongs in the diagnostic record.
const callerScopes = new WeakMap<object, string>();
interface PreviousObservation {
  prefix?: CacheDiagnosticDraft["prefix"];
  promptCacheKey?: CacheDiagnosticDraft["promptCacheKey"];
  account: TaggedPresence;
}
// Finalization order, process-local only. Keys include the diagnostic destination so changing
// OPENCODEX_HOME cannot join histories. Neither keys nor values retain raw session/account data.
const previousObservations = new Map<string, PreviousObservation>();

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

function accountAffinityKey(headers: HeadersInit): TaggedPresence {
  // codexPoolAffinityKey is exactly this read-only identity projection. Import its leaf
  // derivation, not auth-context (which brings credential resolution and routing with it).
  // Parent-only inputs may consult existing TTL-bounded lineage; this call records nothing.
  const normalized = headers instanceof Headers ? headers : new Headers(headers);
  return taggedPresence(codexConversationIdentity(normalized)?.conversationKey, "cache-debug:codex-pool-affinity-key");
}

function sessionHeaders(headers: HeadersInit): SessionHeaders {
  const normalized = headers instanceof Headers ? headers : new Headers(headers);
  return Object.fromEntries(SESSION_HEADERS.map(name => {
    const value = normalized.get(name);
    return [name, value === null ? { present: false } : {
      present: true, tag: tag("cache-debug:session-header", value),
    }];
  })) as SessionHeaders;
}

function sessionPresence(headers: SessionHeaders): TaggedPresence {
  const values = SESSION_HEADERS.filter(name => headers[name].present).map(name => [name, headers[name].tag]);
  return values.length === 0 ? { present: false }
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
  // Build fresh rows: pushes below must never mutate an array-valued instructions field
  // in the live request body. Include the source so moving text between fields is visible.
  const instructionRows: unknown[] = instructions === undefined || instructions === null
    ? [] : (Array.isArray(instructions) ? instructions : [instructions])
      .map(content => ({ source: "instructions", content }));
  if (body.system !== undefined && body.system !== null) {
    instructionRows.push(...(Array.isArray(body.system) ? body.system : [body.system])
      .map(content => ({ source: "system", content })));
  }
  const input = typeof body.input === "string" ? [body.input]
    : Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  // Keep every input/messages row in wire order, including system/developer updates.
  // Extracting those roles into instructions misclassifies a genuine tail append as a
  // top-level prefix rewrite. Whole-row tags still detect role, position and content edits.
  return { instructions: instructionRows, messages: input };
}

export function prefixFingerprint(body: unknown): PrefixFingerprint {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const blocks = requestBlocks(record);
  const unsupported = !body || typeof body !== "object" || Array.isArray(body)
    || (record.input !== undefined && typeof record.input !== "string" && !Array.isArray(record.input))
    || (record.messages !== undefined && !Array.isArray(record.messages))
    || (record.tools !== undefined && !Array.isArray(record.tools));
  return {
    instructions: sequence(blocks.instructions, "cache-debug:prefix:instructions"),
    tools: sequence(tools, "cache-debug:prefix:tools"),
    messages: sequence(blocks.messages, "cache-debug:prefix:messages"),
    ...(unsupported ? { unsupported: true as const } : {}),
  };
}

function comparePrefixes(before?: PrefixFingerprint, after?: PrefixFingerprint): PrefixComparison {
  if (!before || !after) return { status: "uncomparable", reason: "missing-observation" };
  if (before.unsupported || after.unsupported) return { status: "uncomparable", reason: "unsupported-shape" };
  for (const section of ["instructions", "tools", "messages"] as const) {
    const left = before[section];
    const right = after[section];
    const compared = Math.min(left.tags.length, right.tags.length);
    for (let index = 0; index < compared; index += 1) {
      if (left.tags[index] !== right.tags[index]) return { status: "different", section, index };
    }
    // A hidden difference here could precede any difference in later sections. Do not
    // infer equality, append-only, or an exact first divergence from an unobserved tail.
    if (compared < Math.min(left.count, right.count)) return { status: "truncated", section, index: compared };
    if (left.count !== right.count) {
      // Only message-tail growth is append-only. Growing instructions/tools changes the
      // cache prefix before the conversation even when all existing section tags match.
      return { status: section === "messages" && right.count > left.count ? "append-only" : "different", section, index: compared };
    }
  }
  return { status: "equal" };
}

type PresenceComparison = "first" | "equal" | "changed" | "uncomparable";
function comparePresence(before?: TaggedPresence, after?: TaggedPresence): PresenceComparison {
  if (!before || !after) return "uncomparable";
  return before.present === after.present && before.tag === after.tag ? "equal" : "changed";
}

function continuation(facts: CacheDiagnosticFinalFacts, draft: CacheDiagnosticDraft, account: TaggedPresence) {
  const headers = draft.session?.inboundHeaders;
  // Diagnostic correlation ONLY, not the account affinity identity or proof of a binding.
  // All available inbound identifiers participate. Do not use prompt_cache_key (which may
  // legitimately rotate), synthesized outbound IDs, or unrelated affinity headers as identity.
  const identity = headers && SESSION_HEADERS.filter(name => headers[name].present
    && headers[name].tag !== tag("cache-debug:session-header", ""))
    .map(name => [name, headers[name].tag]);
  const callerScope = callerScopes.get(draft);
  const key = identity?.length && callerScope ? tag("cache-debug:history", canonicalJson([
    getConfigDir(), callerScope, facts.protocol, facts.model, identity,
  ])) : undefined;
  const previous = key ? previousObservations.get(key) : undefined;
  const compare = (side: "inbound" | "outbound"): PrefixComparison => {
    if (!identity?.length) return { status: "uncomparable", reason: "missing-session" };
    if (!callerScope) return { status: "uncomparable", reason: "missing-observation" };
    const current = draft.prefix?.[side];
    if (!current) return { status: "uncomparable", reason: "missing-observation" };
    if (current.unsupported) return { status: "uncomparable", reason: "unsupported-shape" };
    return previous ? comparePrefixes(previous.prefix?.[side], current) : { status: "first" };
  };
  const presence = (side: "inbound" | "outbound"): PresenceComparison => !key || !draft.promptCacheKey?.[side] ? "uncomparable"
    : !previous ? "first" : comparePresence(previous.promptCacheKey?.[side], draft.promptCacheKey?.[side]);
  const result = {
    inbound: compare("inbound"),
    outbound: compare("outbound"),
    promptCacheKey: { inbound: presence("inbound"), outbound: presence("outbound") },
    account: !key ? "uncomparable" : !previous ? "first" : comparePresence(previous.account, account),
  };
  if (key) {
    previousObservations.delete(key);
    previousObservations.set(key, {
      prefix: { ...draft.prefix }, promptCacheKey: { ...draft.promptCacheKey }, account,
    });
    while (previousObservations.size > MAX_DRAFTS) previousObservations.delete(previousObservations.keys().next().value!);
  }
  return result;
}

export function observe(requestId: string, observation: Partial<CacheDiagnosticDraft>): CacheDiagnosticDraft {
  if (!isCacheDiagnosticEnabled()) return {};
  const draft = drafts.get(requestId) ?? {};
  Object.assign(draft, observation);
  const callerScope = callerScopes.get(observation);
  if (callerScope) callerScopes.set(draft, callerScope);
  drafts.delete(requestId);
  drafts.set(requestId, draft);
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value!);
  return draft;
}

export function observeInbound(
  body: unknown,
  headers: Headers,
  source: PromptCacheKeySource = "caller",
  admissionPrincipal?: string,
): CacheDiagnosticDraft {
  if (!isCacheDiagnosticEnabled()) return {};
  try {
    const record = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
    const inboundHeaders = sessionHeaders(headers);
    const draft: CacheDiagnosticDraft = {
      promptCacheKey: { inbound: taggedPresence(record.prompt_cache_key, "cache-debug:prompt-cache-key", source) },
      session: { inboundHeader: sessionPresence(inboundHeaders), inboundHeaders },
      prefix: { inbound: prefixFingerprint(body) },
      accountAffinity: { inbound: accountAffinityKey(headers) },
    };
    // Admission owns caller identity; bridges may remove or replace Authorization.
    // No trusted principal (including unauthenticated loopback) means no history join.
    if (admissionPrincipal) callerScopes.set(draft, tag("cache-debug:caller-scope", admissionPrincipal));
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
    const outboundHeaders = sessionHeaders(headers);
    Object.assign(draft.session ??= {}, { outboundHeader: sessionPresence(outboundHeaders), outboundHeaders });
    (draft.prefix ??= {}).outbound = prefixFingerprint(outboundBody);
    (draft.accountAffinity ??= {}).outbound = accountAffinityKey(headers);
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
    const inboundPrefix = draft.prefix?.inbound;
    const outboundPrefix = draft.prefix?.outbound;
    const comparison = comparePrefixes(inboundPrefix, outboundPrefix);
    // Only explicit account facts are evidence; never infer an account from provider text.
    const account = taggedPresence(facts.accountLogLabel, "cache-debug:account-log-label");
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
      accountAffinity: {
        derivation: "codexConversationIdentity",
        evidence: "derived-key-not-binding",
        // Missing observation stays omitted, distinct from an observed absent key.
        ...draft.accountAffinity,
      },
      session: {
        purpose: "diagnostic-correlation-only",
        inboundHeader: draft.session?.inboundHeader ?? { present: false },
        outboundHeader: draft.session?.outboundHeader ?? { present: false },
        inboundHeaders: draft.session?.inboundHeaders,
        outboundHeaders: draft.session?.outboundHeaders,
      },
      prefix: {
        inbound: inboundPrefix,
        outbound: outboundPrefix,
        comparison,
        ...(comparison.status === "different" || comparison.status === "append-only"
          ? { firstDivergentBlock: { section: comparison.section, index: comparison.index } } : {}),
      },
      continuation: continuation(facts, draft, account),
      route: {
        provider: facts.provider,
        model: facts.model,
        ...(account.present ? { accountTag: account.tag } : {}),
        // Preserve reported route labels, never infer key presence or an actual binding
        // from them: even `new_bind` can be reported when no affinity key was derived.
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
  enabled(): boolean;
  observeInbound(body: unknown, headers: Headers, source: PromptCacheKeySource, admissionPrincipal?: string): CacheDiagnosticDraft;
  rebind(body: unknown, draft: CacheDiagnosticDraft | undefined): void;
  finalize(facts: CacheDiagnosticFinalFacts): void;
}
(globalThis as Record<symbol, CacheDiagnosticHooks | undefined>)[CACHE_DIAGNOSTIC_HOOK] = {
  enabled: isCacheDiagnosticEnabled,
  observeInbound,
  rebind: rebindCacheDiagnosticBodyAlias,
  finalize: appendFinalCacheDiagnostic,
};
