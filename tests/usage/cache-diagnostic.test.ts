import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCodexAffinityDiagnostic } from "../../src/codex/affinity-debug";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../../src/lib/debug-settings";
import {
  appendFinalCacheDiagnostic,
  cacheDiagnosticPath,
  CACHE_DEBUG_KEEP_LINES,
  CACHE_DEBUG_MAX_LINES,
  observeInbound,
  observeOutbound,
  rebindCacheDiagnosticBodyAlias,
  tagCacheDiagnosticValue,
} from "../../src/usage/cache-diagnostic";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let previousDebug: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDebug = process.env.OPENCODEX_CACHE_DEBUG;
  testDir = mkdtempSync(join(tmpdir(), "ocx-cache-debug-"));
  process.env.OPENCODEX_HOME = testDir;
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDebug === undefined) delete process.env.OPENCODEX_CACHE_DEBUG;
  else process.env.OPENCODEX_CACHE_DEBUG = previousDebug;
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  if (testDir) removeTreeWithRetry(testDir);
});

function append(
  requestId: string,
  draft = observeInbound({}, new Headers()),
  cache: { raw?: number; value?: number; provenance?: "observed" | "synthesized" | "unknown" } = {},
): void {
  appendFinalCacheDiagnostic({
    requestId,
    protocol: "responses",
    provider: "openai",
    model: "gpt-test",
    ...(cache.raw !== undefined ? { rawCacheCounterValue: cache.raw } : {}),
    ...(cache.value !== undefined ? { normalizedCacheValue: cache.value } : {}),
    cacheProvenance: cache.provenance ?? "unknown",
    draft,
  });
}

function records(): Array<Record<string, unknown>> {
  return readFileSync(cacheDiagnosticPath(), "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

interface DiagnosticRecord {
  requestId: string;
  promptCacheKey: { inbound: { present: boolean; source?: string; tag?: string } };
  session: { inboundHeader: { tag?: string } };
  prefix: {
    inbound: { messages: { tags: string[] } };
    outbound: { messages: { tags: string[] } };
    firstDivergentBlock?: { section: string; index: number };
  };
  cache: {
    rawUpstream: { present: boolean; value?: number; field?: string };
    normalized: { present: boolean; value?: number; provenance: string };
  };
}

function diagnosticRecords(): DiagnosticRecord[] {
  return records() as unknown as DiagnosticRecord[];
}

describe("cache diagnostic", () => {
  test("is disabled by default", () => {
    delete process.env.OPENCODEX_CACHE_DEBUG;
    append("disabled");
    expect(existsSync(cacheDiagnosticPath())).toBe(false);
  });

  test("writes only presence, process tags, counts, and bounded metadata", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const cacheKey = "raw-cache-key-sentinel";
    const session = "raw-session-sentinel";
    const prompt = "raw-prompt-sentinel";
    const inbound = { prompt_cache_key: cacheKey, input: [{ role: "user", content: prompt }] };
    const draft = observeInbound(inbound, new Headers({ session_id: session }));
    observeOutbound(inbound, inbound, { session_id: session });
    append("privacy", draft);

    const text = readFileSync(cacheDiagnosticPath(), "utf8");
    expect(text).not.toContain(cacheKey);
    expect(text).not.toContain(session);
    expect(text).not.toContain(prompt);
    const record = diagnosticRecords()[0];
    expect(record.promptCacheKey.inbound).toMatchObject({ present: true, source: "caller" });
    expect(record.promptCacheKey.inbound.tag).toMatch(/^[0-9a-f]{12}$/);
    expect(record.session.inboundHeader.tag).toMatch(/^[0-9a-f]{12}$/);
    expect(record.prefix.inbound.messages.tags[0]).toMatch(/^[0-9a-f]{12}$/);
    if (process.platform !== "win32") expect(statSync(cacheDiagnosticPath()).mode & 0o777).toBe(0o600);
  });

  test("fingerprints equal bodies equally and locates the first changed message", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const first = { input: [{ role: "user", content: "first" }] };
    const same = { input: [{ role: "user", content: "first" }] };
    const changed = { input: [{ role: "user", content: "changed" }] };
    const equalDraft = observeInbound(first, new Headers());
    observeOutbound(first, same, {});
    append("equal", equalDraft);
    const changedDraft = observeInbound(first, new Headers());
    observeOutbound(first, changed, {});
    append("changed", changedDraft);

    const [equal, different] = diagnosticRecords();
    expect(equal.prefix.inbound.messages.tags).toEqual(equal.prefix.outbound.messages.tags);
    expect(equal.prefix.firstDivergentBlock).toBeUndefined();
    expect(different.prefix.firstDivergentBlock).toEqual({ section: "messages", index: 0 });
  });

  test("a rebuilt request body stays bound to the same draft through an alias", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    // The previous-response expansion rebuilds the body object after the inbound
    // observation; the adapter seam sees only the rebuilt one.
    const inbound = { input: [{ role: "user", content: "literal-inbound" }] };
    const rebuilt = { input: [{ role: "user", content: "literal-inbound" }, { role: "user", content: "expanded" }] };
    const draft = observeInbound(inbound, new Headers());
    rebindCacheDiagnosticBodyAlias(rebuilt, draft);
    observeOutbound(rebuilt, rebuilt, {});
    append("aliased", draft);

    const [record] = diagnosticRecords();
    expect(record.prefix.inbound.messages.tags).toHaveLength(1);
    expect(record.prefix.outbound.messages.tags).toHaveLength(2);
    expect(record.prefix.firstDivergentBlock).toEqual({ section: "messages", index: 1 });
  });

  test("observation never mutates the live request body", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    // An array-valued instructions field aliases the body's own array in the block
    // splitter; appending system/developer content into it would rewrite the request
    // the adapter is about to send upstream.
    const body = {
      instructions: ["standing-instruction"],
      input: [
        { role: "system", content: "system-note" },
        { role: "user", content: "hello" },
      ],
    };
    const before = JSON.stringify(body);
    const draft = observeInbound(body, new Headers());
    observeOutbound(body, body, {});
    append("immutability", draft);

    expect(JSON.stringify(body)).toBe(before);
    const [record] = diagnosticRecords();
    expect(record.prefix.inbound.messages.tags).toHaveLength(1);
  });

  test("keeps an observed upstream zero distinct from an absent counter", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    append("zero", observeInbound({}, new Headers()), { raw: 0, value: 0, provenance: "observed" });
    append("absent", observeInbound({}, new Headers()), { provenance: "unknown" });

    const [zero, absent] = diagnosticRecords();
    expect(zero.cache.rawUpstream).toEqual({ present: true, value: 0 });
    expect(zero.cache.normalized).toEqual({ present: true, value: 0, provenance: "observed" });
    expect(absent.cache.rawUpstream).toEqual({ present: false });
    expect(absent.cache.normalized).toEqual({ present: false, provenance: "unknown" });
  });

  test("retains the newest records after crossing the rolling limit", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    for (let index = 0; index <= CACHE_DEBUG_MAX_LINES; index += 1) append(`request-${index}`);
    const kept = diagnosticRecords();
    expect(kept).toHaveLength(CACHE_DEBUG_KEEP_LINES);
    expect(kept[0].requestId).toBe(`request-${CACHE_DEBUG_MAX_LINES + 1 - CACHE_DEBUG_KEEP_LINES}`);
    expect(kept.at(-1)?.requestId).toBe(`request-${CACHE_DEBUG_MAX_LINES}`);
  });

  test("uses tags that cannot be joined to affinity-debug output", () => {
    const value = "same-private-value";
    setDebugSettings({ debug: true });
    captureCodexAffinityDiagnostic({
      inboundHeaders: new Headers({ session_id: value }),
      outboundHeaders: {},
      authKind: "pool",
      accountMode: "pool",
      fixedAccount: false,
      credentialSubstituted: false,
      accountGatedModel: false,
      wireModelNormalized: false,
      status: 200,
    });
    const line = getDebugLogEntries().at(-1)!.line;
    const payload = JSON.parse(line.slice("[ocx:codex:affinity] ".length)) as { inbound: Array<{ tag: string }> };
    expect(tagCacheDiagnosticValue("session_id", value)).toMatch(/^[0-9a-f]{12}$/);
    expect(tagCacheDiagnosticValue("session_id", value)).not.toBe(payload.inbound[0].tag);
  });
});
