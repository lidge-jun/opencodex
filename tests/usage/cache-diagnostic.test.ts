import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCodexAffinityDiagnostic } from "../../src/codex/affinity-debug";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../../src/lib/debug-settings";
import {
  appendFinalCacheDiagnostic,
  cacheDiagnosticPath,
  CACHE_DEBUG_KEEP_LINES,
  CACHE_DEBUG_MAX_LINES,
  observe,
  observeInbound,
  observeOutbound,
  rebindCacheDiagnosticBodyAlias,
  tagCacheDiagnosticValue,
  type CacheDiagnosticFinalFacts,
  type TaggedPresence,
  type PrefixComparison,
} from "../../src/usage/cache-diagnostic";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let previousDebug: string | undefined;
const TEST_PRINCIPAL = "synthetic-authenticated-admission-principal";

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
  route: { affinityMove?: string; affinityReason?: string; accountTag?: string };
  accountAffinity: {
    derivation: string;
    evidence: string;
    inbound?: TaggedPresence;
    outbound?: TaggedPresence;
  };
  session: {
    purpose: string;
    inboundHeader: TaggedPresence;
    inboundHeaders?: Record<string, TaggedPresence>;
    outboundHeaders?: Record<string, TaggedPresence>;
  };
  continuation: {
    inbound: PrefixComparison;
    outbound: PrefixComparison;
    promptCacheKey: { inbound: string; outbound: string };
    account: string;
  };
  prefix: {
    inbound: { messages: { tags: string[] } };
    outbound: { messages: { tags: string[] } };
    firstDivergentBlock?: { section: string; index: number };
    comparison: PrefixComparison;
  };
  cache: {
    rawUpstream: { present: boolean; value?: number; field?: string };
    normalized: { present: boolean; value?: number; provenance: string };
  };
}

function diagnosticRecords(): DiagnosticRecord[] {
  return records() as unknown as DiagnosticRecord[];
}

// Exercise the real adapter-observation/finalization chain, not fingerprint internals.
function turn(
  inbound: object,
  outbound: object = inbound,
  options: {
    session?: string | null;
    headers?: HeadersInit;
    outboundHeaders?: HeadersInit;
    model?: string;
    provider?: string;
    account?: string;
    affinityMove?: string;
    affinityReason?: string;
    protocol?: CacheDiagnosticFinalFacts["protocol"];
    principal?: string | null;
  } = {},
): void {
  const headers = new Headers(options.headers ?? (options.session === null ? {} : {
    session_id: options.session ?? "test-session",
  }));
  const draft = observeInbound(inbound, headers, "caller", options.principal === null ? undefined : options.principal ?? TEST_PRINCIPAL);
  observeOutbound(inbound, outbound, options.outboundHeaders ?? headers);
  appendFinalCacheDiagnostic({
    requestId: `turn-${recordsIfPresent()}`,
    protocol: options.protocol ?? "responses",
    provider: options.provider ?? "openai",
    model: options.model ?? "gpt-test",
    accountLogLabel: options.account,
    affinityMove: options.affinityMove,
    affinityReason: options.affinityReason,
    cacheProvenance: "unknown",
    draft,
  });
}

function recordsIfPresent(): number {
  return existsSync(cacheDiagnosticPath()) ? records().length : 0;
}

const message = (content: string) => ({ role: "user", content });

describe("cache diagnostic", () => {
  test("stable session_id and prompt key correlate diagnostics without claiming pool affinity identity", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const headers = { session_id: "capture-session-sentinel" };
    const body = { input: "same", prompt_cache_key: "capture-prompt-key-sentinel" };
    expect(codexPoolAffinityKey(new Headers(headers))).toBeUndefined();
    turn(body, body, { headers });
    turn(body, body, { headers });
    for (const record of diagnosticRecords()) {
      expect(record.session.purpose).toBe("diagnostic-correlation-only");
      expect(record.session.inboundHeaders!.session_id.present).toBe(true);
      expect(record.accountAffinity).toEqual({
        derivation: "codexConversationIdentity",
        evidence: "derived-key-not-binding",
        inbound: { present: false },
        outbound: { present: false },
      });
    }
    expect(diagnosticRecords()[1].continuation.inbound.status).toBe("equal");
    const text = readFileSync(cacheDiagnosticPath(), "utf8");
    expect(text).not.toContain("capture-session-sentinel");
    expect(text).not.toContain("capture-prompt-key-sentinel");
  });

  test("route labels never substitute for the derived pool key or claim a binding", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const body = { input: "same", prompt_cache_key: "label-probe-key" };
    const incomplete = { session_id: "label-probe-session" };
    const complete = { ...incomplete, "session-id": "label-probe-session", "thread-id": "label-probe-thread" };
    for (const headers of [incomplete, complete]) {
      const derived = codexPoolAffinityKey(new Headers(headers));
      for (const affinityMove of ["new_bind", "reused"]) {
        // Supply finalized labels as facts: this tests diagnostic interpretation, not routing.
        turn(body, body, { headers, affinityMove, affinityReason: "label-probe" });
        const record = diagnosticRecords().at(-1)!;
        expect(record.route).toMatchObject({ affinityMove, affinityReason: "label-probe" });
        expect(record.accountAffinity.evidence).toBe("derived-key-not-binding");
        const expected = derived === undefined ? { present: false } : {
          present: true, tag: tagCacheDiagnosticValue("codex-pool-affinity-key", derived),
        };
        expect(record.accountAffinity.inbound).toEqual(expected);
        expect(record.accountAffinity.outbound).toEqual(expected);
        expect(record.session.purpose).toBe("diagnostic-correlation-only");
      }
    }
    const rows = diagnosticRecords();
    expect(rows[1].continuation.inbound.status).toBe("equal");
    expect(rows[0].accountAffinity.inbound).toEqual({ present: false });
    expect(rows[2].accountAffinity.inbound?.present).toBe(true);
    expect(rows[2].accountAffinity.inbound).toEqual(rows[3].accountAffinity.inbound);
  });

  test("reports the real pool-key derivation separately for each observed header set", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const base = { session_id: "raw-capture-session", "session-id": "raw-affinity-session" };
    const full = { ...base, "thread-id": "raw-affinity-thread" };
    const rawKey = codexPoolAffinityKey(new Headers(full));
    expect(rawKey).toBeDefined();
    for (const headers of [base, { "thread-id": "raw-affinity-thread" }, { "x-session-id": "raw-capture-session" }]) {
      expect(codexPoolAffinityKey(new Headers(headers))).toBeUndefined();
      turn({ input: "a" }, undefined, { headers, outboundHeaders: full });
      const record = diagnosticRecords().at(-1)!;
      expect(record.accountAffinity.inbound).toEqual({ present: false });
      expect(record.accountAffinity.outbound).toEqual({
        present: true, tag: tagCacheDiagnosticValue("codex-pool-affinity-key", rawKey!),
      });
      expect(record.accountAffinity.evidence).toBe("derived-key-not-binding");
    }
    turn({ input: "a" }, undefined, { headers: full, outboundHeaders: full });
    const record = diagnosticRecords().at(-1)!;
    expect(record.accountAffinity.inbound).toEqual(record.accountAffinity.outbound);
    expect(record.accountAffinity.inbound?.tag).not.toBe(record.session.inboundHeader.tag);
    const text = readFileSync(cacheDiagnosticPath(), "utf8");
    for (const value of [rawKey!, ...Object.values(full)]) expect(text).not.toContain(value);
  });

  test("does not turn a missing outbound observation into an absent affinity key", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const draft = observeInbound({ input: "a" }, new Headers({ "session-id": "s", "thread-id": "t" }));
    append("inbound-only-affinity", draft);
    const record = diagnosticRecords()[0];
    expect(record.accountAffinity.inbound?.present).toBe(true);
    expect(record.accountAffinity.outbound).toBeUndefined();
  });

  test("compares consecutive inbound and outbound prefixes independently", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    turn({ input: [message("a")] });
    turn({ input: [message("a"), message("b")] }, { input: [message("rewritten"), message("b")] });
    turn({ input: [message("a"), message("b")] }, { input: [message("rewritten"), message("b")] });
    const [first, second, same] = diagnosticRecords();
    expect(first.continuation.inbound).toEqual({ status: "first" });
    expect(first.continuation.outbound).toEqual({ status: "first" });
    expect(second.continuation.inbound).toEqual({ status: "append-only", section: "messages", index: 1 });
    expect(second.continuation.outbound).toEqual({ status: "different", section: "messages", index: 0 });
    expect(same.continuation.inbound).toEqual({ status: "equal" });
    expect(same.continuation.outbound).toEqual({ status: "equal" });
  });

  test("seven wire-shaped turns remain append-only when skill and permission updates append input roles", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const content = (text: string) => [{ type: "input_text", text }];
    const additions = [
      [{ role: "developer", content: content("initial-policy-sentinel") }, message("task-sentinel")],
      [{ role: "assistant", content: [{ type: "output_text", text: "reply-sentinel" }] }],
      [{ role: "system", content: content("skill-update-sentinel") }, message("continue-sentinel")],
      [{ type: "function_call", call_id: "call-sentinel", name: "tool-sentinel", arguments: "{}" }],
      [{ type: "function_call_output", call_id: "call-sentinel", output: "result-sentinel" }],
      [{ role: "developer", content: content("permission-update-sentinel") }, message("next-sentinel")],
      [{ role: "system", content: content("second-update-sentinel") }],
    ];
    let input: object[] = [];
    for (const rows of additions) {
      const previousLength = input.length;
      input = [...input, ...rows];
      const body = {
        instructions: "standing-instruction-sentinel",
        system: [{ type: "text", text: "top-system-sentinel" }],
        tools: [{ type: "function", name: "tool-sentinel", parameters: { type: "object" } }],
        input,
      };
      const before = JSON.stringify(body);
      // Distinct parsed objects model the actual inbound and final outbound observations.
      turn(body, JSON.parse(before));
      expect(JSON.stringify(body)).toBe(before);
      const record = diagnosticRecords().at(-1)!;
      for (const side of ["inbound", "outbound"] as const) {
        expect(record.continuation[side]).toEqual(previousLength === 0 ? { status: "first" }
          : { status: "append-only", section: "messages", index: previousLength });
      }
      expect(record.prefix.comparison).toEqual({ status: "equal" });
      expect(record.prefix.inbound.messages.tags).toHaveLength(input.length);
    }
    expect(readFileSync(cacheDiagnosticPath(), "utf8")).not.toContain("sentinel");
  });

  test("existing system/developer input rows still detect role, position and content rewrites", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    for (const field of ["input", "messages"]) {
      for (const role of ["system", "developer"]) {
        const policy = { role, content: [{ type: "input_text", text: "original-policy" }] };
        const before = [message("first"), policy, message("last")];
        const appendSession = `${field}-${role}-append`;
        turn({ [field]: before }, undefined, { session: appendSession });
        turn({ [field]: [...before, policy] }, undefined, { session: appendSession });
        for (const side of ["inbound", "outbound"] as const) {
          expect(diagnosticRecords().at(-1)!.continuation[side]).toEqual({ status: "append-only", section: "messages", index: 3 });
        }
        const rewrites = [
          { rows: [before[0], { ...policy, role: role === "system" ? "developer" : "system" }, before[2]], index: 1 },
          { rows: [policy, before[0], before[2]], index: 0 },
          { rows: [before[0], { ...policy, content: [{ type: "input_text", text: "changed-policy" }] }, before[2]], index: 1 },
        ];
        for (const [index, rewrite] of rewrites.entries()) {
          const session = `${field}-${role}-${index}`;
          turn({ [field]: before }, undefined, { session });
          turn({ [field]: rewrite.rows }, undefined, { session });
          const record = diagnosticRecords().at(-1)!;
          for (const side of ["inbound", "outbound"] as const) {
            expect(record.continuation[side]).toEqual({ status: "different", section: "messages", index: rewrite.index });
          }
        }
      }
    }
  });

  test("appended policy rows obey the ordered input truncation boundary", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const input = Array.from({ length: 128 }, (_, index) => ({
      role: index % 2 ? "developer" : "system", content: `policy-${index}`,
    }));
    turn({ input });
    const extended = [...input, { role: "developer", content: "permission-update" }];
    turn({ input: extended });
    for (const side of ["inbound", "outbound"] as const) {
      expect(diagnosticRecords().at(-1)!.continuation[side]).toEqual({ status: "append-only", section: "messages", index: 128 });
    }
    turn({ input: [...extended, { role: "system", content: "skill-update" }] });
    for (const side of ["inbound", "outbound"] as const) {
      expect(diagnosticRecords().at(-1)!.continuation[side]).toEqual({ status: "truncated", section: "messages", index: 128 });
    }
    expect(diagnosticRecords().at(-1)!.prefix.firstDivergentBlock).toBeUndefined();
  });

  test("reports tool, system, instruction and message rewrites and removals", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const cases = [
      [{ tools: [{ type: "function", name: "a" }] }, { tools: [{ type: "function", name: "b" }] }, "tools"],
      [{ system: "a" }, { system: "b" }, "instructions"],
      [{ instructions: "a" }, { instructions: "b" }, "instructions"],
      [{ input: [{ role: "system", content: "a" }] }, { input: [{ role: "developer", content: "a" }] }, "messages"],
      [{ instructions: "a" }, { system: "a" }, "instructions"],
      [{ input: [{ role: "system", content: "a" }, message("b")] }, { input: [message("b"), { role: "system", content: "a" }] }, "messages"],
      [{ input: "a" }, { input: "b" }, "messages"],
      [{ input: [message("a")] }, { input: [] }, "messages"],
    ] as const;
    for (const [before, after, section] of cases) {
      const session = `case-${section}-${recordsIfPresent()}`;
      turn(before, before, { session });
      turn(after, after, { session });
      const record = diagnosticRecords().at(-1)!;
      for (const side of ["inbound", "outbound"] as const) {
        expect(record.continuation[side]).toEqual({ status: "different", section, index: 0 });
      }
    }
  });

  test("isolates interleaved sessions, models and protocols; tracks key and account changes", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const first = { input: [message("a")], prompt_cache_key: "key-a" };
    turn(first, first, { session: "a", account: "account-a" });
    turn({ input: [message("unrelated")] }, undefined, { session: "b" });
    turn(first, first, { session: "a", model: "another-model" });
    turn(first, first, { session: "a", protocol: "chat" });
    const next = { input: [message("a"), message("b")], prompt_cache_key: "key-b" };
    turn(next, { ...next, prompt_cache_key: "key-a" }, { session: "a", account: "account-b" });
    const rows = diagnosticRecords();
    for (const row of rows.slice(1, 4)) expect(row.continuation.inbound.status).toBe("first");
    expect(rows[4].continuation.inbound.status).toBe("append-only");
    expect(rows[4].continuation.promptCacheKey).toEqual({ inbound: "changed", outbound: "equal" });
    expect(rows[4].continuation.account).toBe("changed");
    const text = readFileSync(cacheDiagnosticPath(), "utf8");
    for (const secret of ["key-a", "key-b", "account-a", "account-b", "unrelated"]) expect(text).not.toContain(secret);
  });

  test("isolates identical sessions by trusted admission, never by mutable caller headers", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const headers = new Headers({ session_id: "shared-session", authorization: "Bearer test-upstream" });
    const a = "synthetic-admission-a";
    const b = "synthetic-admission-b";
    const body = { input: [message("same")], prompt_cache_key: "shared-key" };
    for (const principal of [a, b, null, a, b, null]) {
      turn(body, body, { headers, principal, account: "same-upstream-account" });
    }
    const rows = diagnosticRecords();
    for (const row of [rows[0], rows[1]]) {
      expect(row.continuation.inbound.status).toBe("first");
      expect(row.continuation.outbound.status).toBe("first");
      expect(row.continuation.account).toBe("first");
    }
    for (const row of [rows[3], rows[4]]) {
      expect(row.continuation.inbound.status).toBe("equal");
      expect(row.continuation.outbound.status).toBe("equal");
      expect(row.continuation.account).toBe("equal");
    }
    for (const row of [rows[2], rows[5]]) {
      expect(row.continuation.inbound).toEqual({ status: "uncomparable", reason: "missing-observation" });
      expect(row.continuation.outbound).toEqual({ status: "uncomparable", reason: "missing-observation" });
      expect(row.continuation.account).toBe("uncomparable");
      expect(row.prefix.comparison.status).toBe("equal");
    }
    const text = readFileSync(cacheDiagnosticPath(), "utf8");
    expect(text).not.toContain(headers.get("authorization")!);
    for (const scope of [a, b]) {
      expect(text).not.toContain(scope);
      expect(text).not.toContain(tagCacheDiagnosticValue("caller-scope", scope));
    }
  });

  test("provider changes preserve continuity and account evidence comes only from explicit facts", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    turn({ input: "same" }, undefined, { provider: "openai-p111111", account: "p111111" });
    turn({ input: "same" }, undefined, { provider: "openai", account: "main" });
    const rotated = diagnosticRecords().at(-1)!;
    expect(rotated.continuation.inbound.status).toBe("equal");
    expect(rotated.continuation.outbound.status).toBe("equal");
    expect(rotated.continuation.account).toBe("changed");
    turn({ input: "same" }, undefined, { provider: "anthropic-p111111" });
    turn({ input: "same" }, undefined, { provider: "anthropic-p222222" });
    const noAccount = diagnosticRecords().at(-1)!;
    expect(noAccount.continuation.outbound.status).toBe("equal");
    expect(noAccount.continuation.account).toBe("equal");
    expect(noAccount.route.accountTag).toBeUndefined();
    expect(diagnosticRecords().at(-2)!.route.accountTag).toBeUndefined();
    turn({ input: "same" }, undefined, { provider: "unrelated-provider" });
    expect(diagnosticRecords().at(-1)!.continuation.inbound.status).toBe("equal");
  });

  test("session header values share a tag domain across names and directions without merging identities", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const names = ["session_id", "session-id", "thread-id", "x-session-id"];
    const headers = Object.fromEntries(names.map(name => [name, "shared-header-value"]));
    turn({ input: "same" }, undefined, { headers, outboundHeaders: headers });
    const record = diagnosticRecords()[0];
    const expected = record.session.inboundHeaders!.session_id;
    for (const name of names) {
      expect(record.session.inboundHeaders![name]).toEqual(expected);
      expect(record.session.outboundHeaders![name]).toEqual(expected);
    }
    turn({ input: "same" }, undefined, { headers: { session_id: "shared-header-value" } });
    turn({ input: "same" }, undefined, { headers: { "x-session-id": "shared-header-value" } });
    const rows = diagnosticRecords();
    expect(rows[1].continuation.inbound.status).toBe("first");
    expect(rows[2].continuation.inbound.status).toBe("first");
    expect(rows[1].session.inboundHeaders!.session_id.tag).toBe(rows[2].session.inboundHeaders!["x-session-id"].tag);
  });

  test("records each session header independently and ignores unrelated rotating headers", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const names = ["session_id", "session-id", "thread-id", "x-session-id"];
    for (const name of names) {
      const headers = { [name]: `private-${name}`, "x-client-request-id": "request-a" };
      turn({ input: "a" }, undefined, { headers, outboundHeaders: {} });
      turn({ input: "a" }, undefined, { headers: { ...headers, "x-client-request-id": "request-b" } });
      const record = diagnosticRecords().at(-1)!;
      expect(record.continuation.inbound.status).toBe("equal");
      expect(record.session.inboundHeaders![name]).toMatchObject({ present: true, tag: expect.stringMatching(/^[0-9a-f]{12}$/) });
      for (const other of names.filter(value => value !== name)) {
        expect(record.session.inboundHeaders![other]).toEqual({ present: false });
      }
      const previous = diagnosticRecords().at(-2)!;
      expect(previous.session.outboundHeaders![name]).toEqual({ present: false });
    }
    expect(readFileSync(cacheDiagnosticPath(), "utf8")).not.toContain("private-");
  });

  test("never associates headerless requests using prompt keys or incidental headers", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const body = { prompt_cache_key: "shared-key", input: "same" };
    for (let index = 0; index < 2; index++) turn(body, body, {
      headers: { originator: "client", "x-client-request-id": "incidental", session_id: "" },
      outboundHeaders: { session_id: "synthesized" },
    });
    for (const record of diagnosticRecords()) {
      expect(record.continuation.inbound).toEqual({ status: "uncomparable", reason: "missing-session" });
      expect(record.continuation.outbound).toEqual({ status: "uncomparable", reason: "missing-session" });
    }
  });

  test("does not claim equality or an exact divergence beyond the 128-block bound", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const input = Array.from({ length: 129 }, (_, index) => message(`block-${index}`));
    turn({ input });
    turn({ input });
    turn({ input: [...input.slice(0, 128), message("hidden-rewrite")] });
    turn({ input: [...input, message("extra")] });
    for (const record of diagnosticRecords().slice(1)) {
      expect(record.continuation.inbound).toEqual({ status: "truncated", section: "messages", index: 128 });
      expect(record.continuation.outbound.status).toBe("truncated");
      expect(record.prefix.comparison.status).toBe("truncated");
      expect(record.prefix.firstDivergentBlock).toBeUndefined();
      expect(record.prefix.inbound.messages.tags).toHaveLength(128);
    }
    turn({ input: [message("visible-rewrite"), ...input.slice(1)] });
    expect(diagnosticRecords().at(-1)!.continuation.inbound).toEqual({ status: "different", section: "messages", index: 0 });
  });

  test("proves a 128-block prefix append, but treats growth before messages as a rewrite", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const input = Array.from({ length: 128 }, (_, index) => message(`message-${index}`));
    turn({ input });
    turn({ input: [...input, message("tail")] });
    expect(diagnosticRecords().at(-1)!.continuation.inbound).toEqual({ status: "append-only", section: "messages", index: 128 });
    for (const section of ["instructions", "tools"] as const) {
      turn({ [section]: ["one"], input }, undefined, { session: section });
      turn({ [section]: ["one", "two"], input }, undefined, { session: section });
      expect(diagnosticRecords().at(-1)!.continuation.inbound).toEqual({ status: "different", section, index: 1 });
    }
    const instructions = Array.from({ length: 129 }, (_, index) => `instruction-${index}`);
    turn({ instructions, input: "a" }, undefined, { session: "truncated-instructions" });
    turn({ instructions, input: "b" }, undefined, { session: "truncated-instructions" });
    expect(diagnosticRecords().at(-1)!.continuation.inbound).toEqual({ status: "truncated", section: "instructions", index: 128 });
  });

  test("uses the complete inbound header identity, not one matching header or the outbound identity", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    for (const thread of ["a", "b", "a"]) turn({ input: "a" }, undefined, {
      headers: { session_id: "shared-session", "thread-id": thread },
      outboundHeaders: { session_id: "same-upstream-session" },
    });
    const rows = diagnosticRecords();
    expect(rows[0].continuation.inbound.status).toBe("first");
    expect(rows[1].continuation.inbound.status).toBe("first");
    expect(rows[2].continuation.inbound.status).toBe("equal");
    expect(rows[2].continuation.outbound.status).toBe("equal");
  });

  test("detects prompt-key and account presence changes without coupling content comparison to them", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    turn({ input: "same", prompt_cache_key: "private-key" }, undefined, { account: "private-account" });
    turn({ input: "same" });
    turn({ input: "same" });
    const [, removed, unchanged] = diagnosticRecords();
    expect(removed.continuation.inbound.status).toBe("equal");
    expect(removed.continuation.promptCacheKey).toEqual({ inbound: "changed", outbound: "changed" });
    expect(removed.continuation.account).toBe("changed");
    expect(unchanged.continuation.account).toBe("equal");
    expect(unchanged.continuation.promptCacheKey).toEqual({ inbound: "equal", outbound: "equal" });
  });

  test("bounds previous-session records and treats an evicted session as first", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    turn({ input: "first" }, undefined, { session: "oldest" });
    for (let index = 0; index < 512; index++) turn({ input: "other" }, undefined, { session: `other-${index}` });
    turn({ input: "first" }, undefined, { session: "oldest" });
    expect(diagnosticRecords().at(-1)!.continuation.inbound.status).toBe("first");
    expect(diagnosticRecords().length).toBeLessThanOrEqual(CACHE_DEBUG_MAX_LINES);
  });

  test("missing and unsupported observations remain uncomparable, not empty equal prefixes", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const body = { input: "a" };
    const draft = observeInbound(body, new Headers({ session_id: "missing-outbound" }));
    append("missing", draft);
    expect(diagnosticRecords()[0].prefix.comparison).toEqual({ status: "uncomparable", reason: "missing-observation" });
    turn({ input: 123 });
    turn({ input: 123 });
    expect(diagnosticRecords().at(-1)!.continuation.inbound).toEqual({ status: "uncomparable", reason: "unsupported-shape" });
  });

  test("is disabled by default", () => {
    delete process.env.OPENCODEX_CACHE_DEBUG;
    append("disabled");
    expect(existsSync(cacheDiagnosticPath())).toBe(false);
  });

  test("disabled entry points never inspect bodies, headers, observations or final facts", () => {
    for (const value of [undefined, "0", "true"]) {
      if (value === undefined) delete process.env.OPENCODEX_CACHE_DEBUG;
      else process.env.OPENCODEX_CACHE_DEBUG = value;
      let reads = 0;
      const unreadable = new Proxy({}, {
        get() { reads++; throw new Error("disabled diagnostics inspected input"); },
        ownKeys() { reads++; throw new Error("disabled diagnostics enumerated input"); },
      });
      expect(observeInbound(unreadable, unreadable as Headers)).toEqual({});
      expect(observe("disabled", unreadable)).toEqual({});
      expect(() => rebindCacheDiagnosticBodyAlias(unreadable, unreadable)).not.toThrow();
      expect(() => observeOutbound(unreadable, unreadable, unreadable as Headers)).not.toThrow();
      expect(() => appendFinalCacheDiagnostic(unreadable as CacheDiagnosticFinalFacts)).not.toThrow();
      expect(reads).toBe(0);
      expect(existsSync(cacheDiagnosticPath())).toBe(false);
    }
  });

  test("missing observations stay unknown on later turns and unsupported shapes do not compare equal", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const headers = new Headers({ session_id: "partial-observation" });
    const draft = observeInbound({ input: "same" }, headers, "caller", TEST_PRINCIPAL);
    append("inbound-only", draft);
    turn({ input: "same" }, undefined, { headers });
    const next = diagnosticRecords().at(-1)!;
    expect(next.continuation.inbound).toEqual({ status: "equal" });
    expect(next.continuation.outbound).toEqual({ status: "uncomparable", reason: "missing-observation" });
    expect(next.continuation.promptCacheKey.outbound).toBe("uncomparable");
    for (const body of [{ input: null }, { messages: "unknown" }, { tools: {} }]) {
      turn(body, body, { session: JSON.stringify(body) });
      turn(body, body, { session: JSON.stringify(body) });
      const record = diagnosticRecords().at(-1)!;
      expect(record.prefix.comparison).toEqual({ status: "uncomparable", reason: "unsupported-shape" });
      expect(record.continuation.inbound).toEqual({ status: "uncomparable", reason: "unsupported-shape" });
      expect(record.prefix.firstDivergentBlock).toBeUndefined();
    }
  });

  test("missing session-header and prompt-key observations stay distinct from observed empty values", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    append("no-observation", {});
    const missing = diagnosticRecords().at(-1)!;
    expect(missing.session.inboundHeaders).toBeUndefined();
    expect(missing.session.outboundHeaders).toBeUndefined();
    expect(missing.continuation.promptCacheKey).toEqual({ inbound: "uncomparable", outbound: "uncomparable" });
    const headers = new Headers({ session_id: "inbound-only" });
    const body = { input: "same" };
    append("inbound-only", observeInbound(body, headers, "caller", TEST_PRINCIPAL));
    const partial = diagnosticRecords().at(-1)!;
    expect(partial.session.inboundHeaders?.session_id.present).toBe(true);
    expect(partial.session.outboundHeaders).toBeUndefined();
    expect(partial.continuation.promptCacheKey).toEqual({ inbound: "first", outbound: "uncomparable" });
    turn(body, body, { headers, outboundHeaders: {} });
    const observed = diagnosticRecords().at(-1)!;
    expect(observed.session.outboundHeaders).toEqual(Object.fromEntries(
      ["session_id", "session-id", "thread-id", "x-session-id"].map(name => [name, { present: false }]),
    ));
    expect(observed.continuation.promptCacheKey).toEqual({ inbound: "equal", outbound: "uncomparable" });
    turn(body, body, { headers, outboundHeaders: {} });
    expect(diagnosticRecords().at(-1)!.continuation.promptCacheKey.outbound).toBe("equal");
  });

  test("continuation compares finalization order, not ingress or request-id order", () => {
    process.env.OPENCODEX_CACHE_DEBUG = "1";
    const headers = new Headers({ session_id: "overlapping-turns" });
    const early = { input: [message("first")] };
    const later = { input: [message("first"), message("second")] };
    const earlyDraft = observeInbound(early, headers, "caller", TEST_PRINCIPAL);
    const laterDraft = observeInbound(later, headers, "caller", TEST_PRINCIPAL);
    observeOutbound(early, early, headers);
    observeOutbound(later, later, headers);
    append("later-request", laterDraft);
    append("early-request", earlyDraft);
    const [first, second] = diagnosticRecords();
    expect(first.continuation.inbound).toEqual({ status: "first" });
    expect(second.continuation.inbound).toEqual({ status: "different", section: "messages", index: 1 });
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
    expect(record.prefix.inbound.messages.tags).toHaveLength(2);
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


test("registered cache diagnostic hook retains its live enabled contract", () => {
  const hook = (globalThis as Record<symbol, { enabled(): boolean } | undefined>)[
    Symbol.for("opencodex.cache-diagnostic.v1")
  ];
  expect(typeof hook?.enabled).toBe("function");
  process.env.OPENCODEX_CACHE_DEBUG = "0";
  expect(hook?.enabled()).toBe(false);
  process.env.OPENCODEX_CACHE_DEBUG = "1";
  expect(hook?.enabled()).toBe(true);
  delete process.env.OPENCODEX_CACHE_DEBUG;
  expect(hook?.enabled()).toBe(false);
});
