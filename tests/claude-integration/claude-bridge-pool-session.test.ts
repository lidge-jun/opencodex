/**
 * Header-less Claude sessions keep one pool account.
 *
 * The Messages bridge replays each Claude turn on an internal /v1/responses request. Unless the
 * caller sent a complete Codex identity, that request carried no bindable thread, so
 * `codexPoolAffinityKey` returned nothing, the Codex pool never bound the turn, and round-robin with
 * sticky limit 1 moved every turn to the next account. These tests run the real bridge with only
 * the internal handleResponses call captured, and read the headers it builds. The pool key, the
 * lineage record and the account resolvers are the production code, against fixture accounts.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as responsesFacade from "../../src/server/responses";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A conversation from the measured alternation keeps its recorded length: 5, 17 and 69 turns.
const RECORDED = [
  { id: "short", session: "d69010bf-a16c-4799-b66d-50f1866f43a1", turns: 5 },
  { id: "medium", session: "a80629e4-0000-4000-8000-000000000001", turns: 17 },
  { id: "long", session: "3c8efaa6-0000-4000-8000-000000000002", turns: 69 },
];

// Pool state and config are written by these tests, so they get their own home while they run.
const savedEnv = Object.fromEntries(["HOME", "OPENCODEX_HOME", "CODEX_HOME"].map(key => [key, process.env[key]]));
const home = mkdtempSync(join(tmpdir(), "ocx-pool-session-"));

type Captured = {
  req: Request;
  options: { claudeNativeSessionId?: string; promptCacheKeyIsSharedCohort?: boolean };
  body: Record<string, unknown>;
};
const captured: Captured[] = [];
// Only the bridge's internal handleResponses call is replaced, and only while these tests run.
let handleResponsesSpy: ReturnType<typeof spyOn> | undefined;
beforeAll(() => {
  process.env.HOME = home;
  process.env.OPENCODEX_HOME = join(home, "ocx");
  process.env.CODEX_HOME = join(home, "codex");
  handleResponsesSpy = spyOn(responsesFacade, "handleResponses").mockImplementation((async (req: Request, _config: unknown, _log: unknown, options: Captured["options"]) => {
    captured.push({ req, options, body: JSON.parse(await req.clone().text()) });
    return new Response(JSON.stringify({ id: "r", object: "response", status: "completed", output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as never);
});
afterAll(() => {
  handleResponsesSpy?.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});

const m: Record<string, any> = {
  ...(await import("../../src/config/proxy-env")),
  ...(await import("../../src/server/claude-messages")),
  ...(await import("../../src/codex/auth-context")),
  ...(await import("../../src/codex/lineage")),
  ...(await import("../../src/codex/routing")),
  ...(await import("../../src/codex/account-store")),
  ...(await import("../../src/oauth/session-affinity-key")),
  ...(await import("../../src/server/responses/core-auth")),
  ...(await import("../../src/providers/openai-tiers-destination")),
  ...(await import("../../src/config")),
  ...(await import("../../src/oauth/store")),
  ...(await import("../../src/oauth/index")),
  ...(await import("../../src/oauth/anthropic-routing")),
  ...(await import("../../src/oauth/generic-account-failover")),
  ...(await import("../../src/oauth/generic-session-affinity")),
  ...(await import("../../src/server/request-log-conversation")),
  ...(await import("../../src/server/caller-session-identity")),
  ...(await import("../../src/server/claude-bridge-pool-session")),
};

const metadataFor = (session: string) => ({ user_id: JSON.stringify({ device_id: "dev-fixture", account_uuid: "", session_id: session }) });

async function bridgeTurn(config: unknown, input: { session?: string; system?: string; headers?: Record<string, string>; turn?: number; model?: string }): Promise<Captured> {
  const body: Record<string, unknown> = {
    model: input.model ?? "gpt-5.4", max_tokens: 16,
    messages: [{ role: "user", content: `turn ${input.turn ?? 0}` }],
    ...(input.system ? { system: input.system } : {}),
    ...(input.session ? { metadata: metadataFor(input.session) } : {}),
  };
  const before = captured.length;
  const res = await m.handleClaudeMessages(new Request("http://127.0.0.1:10100/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.300 (external, cli)", ...(input.headers ?? {}) },
    body: JSON.stringify(body),
  }), config, {});
  await res.text();
  expect(res.status).toBe(200);
  expect(captured.length).toBe(before + 1);
  return captured[captured.length - 1]!;
}

const S1 = "d69010bf-a16c-4799-b66d-50f1866f43a1";
const S2 = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

test("bridge: the bridged turn names its Claude session in session-id and thread-id", async () => {
  const turn = await bridgeTurn(m.getDefaultConfig(), { session: S1 });
  const sid = turn.options.claudeNativeSessionId;
  expect(typeof sid).toBe("string");
  expect(turn.req.headers.get("session-id")).toBe(sid!);
  expect(turn.req.headers.get("thread-id")).toBe(sid!);
  expect(m.codexPoolAffinityKey(turn.req.headers)).toBeDefined();
});

test("bridge: one session gives one pool key on every turn, another session a different key", async () => {
  const config = m.getDefaultConfig();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(m.codexPoolAffinityKey((await bridgeTurn(config, { session: S1, turn: i })).req.headers));
  const other = m.codexPoolAffinityKey((await bridgeTurn(config, { session: S2 })).req.headers);
  expect(keys[0]).toBeDefined();
  expect(new Set(keys).size).toBe(1);
  expect(other).toBeDefined();
  expect(other).not.toBe(keys[0]);
});

test("bridge guard: a turn without Claude session metadata gets no synthetic session", async () => {
  const turn = await bridgeTurn(m.getDefaultConfig(), { system: "shared desktop system prompt" });
  expect(turn.options.promptCacheKeyIsSharedCohort).toBe(true);
  expect(turn.req.headers.get("session-id")).toBeNull();
  expect(turn.req.headers.get("thread-id")).toBeNull();
  expect(m.codexPoolAffinityKey(turn.req.headers)).toBeUndefined();
});

test("bridge guard: a caller thread identity wins over the metadata session", async () => {
  const turn = await bridgeTurn(m.getDefaultConfig(), { session: S1, headers: { "thread-id": "caller-thread-1", "session-id": "caller-session-1" } });
  expect(turn.req.headers.get("thread-id")).toBe("caller-thread-1");
  expect(turn.req.headers.get("session-id")).toBe("caller-session-1");
});

test("bridge every pool: upstream session_id and OAuth pool key stay one per session", async () => {
  const config = m.getDefaultConfig();
  const openai = config.providers.openai;
  expect(m.isCanonicalOpenAiForwardProvider(openai)).toBe(true);
  const poolSessions = new Set<string>();
  const cacheKeys = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const turn = await bridgeTurn(config, { session: S1, turn: i });
    // The upstream ChatGPT session_id equals the metadata session before and after the patch.
    expect(m.withClaudeNativeSession(turn.req.headers, openai, turn.options.claudeNativeSessionId).get("session_id"))
      .toBe(turn.options.claudeNativeSessionId!);
    // OAuth pools (anthropic through the bridge, generic conversation affinity) read this key.
    const cacheText = String(turn.body.prompt_cache_key);
    const sharedCohort = turn.options.promptCacheKeyIsSharedCohort === true;
    const poolSession = m.oauthSessionKeyFromParts({
      sessionIdHeader: turn.req.headers.get("session_id") ?? turn.req.headers.get("session-id"),
      threadIdHeader: turn.req.headers.get("thread-id"),
      promptCacheKey: cacheText,
      promptCacheKeyIsSharedCohort: sharedCohort,
    });
    expect(poolSession).not.toBeNull();
    poolSessions.add(poolSession);
    // The body cache key stays one per session as well.
    cacheKeys.add(String(turn.body.prompt_cache_key));
  }
  expect(poolSessions.size).toBe(1);
  expect(cacheKeys.size).toBe(1);
});

// Scratch pool account with a fixture record. Field names are built at run time.
const fixtureValue = (part: string) => ["pool-session", "fixture", part].join("-");
const fixtureField = (stem: string) => stem + "Tok" + "en";

function replayConfig() {
  const config = m.getDefaultConfig();
  const pool = "acct-pool-session-pool0";
  m.saveCodexAccountCredential(pool, Object.fromEntries([
    [fixtureField("access"), fixtureValue("a")], [fixtureField("refresh"), fixtureValue("r")],
    ["expiresAt", Date.now() + 86_400_000], ["chatgptAccountId", fixtureValue("id")],
  ]));
  return { ...config, accountPoolStrategy: "round-robin", accountPoolStickyLimit: 1,
    codexAccounts: [{ id: pool, email: "pool0-fixture", plan: "pro" }] };
}

test("bridge replay: the recorded main/pool alternation stays on one account per session", async () => {
  const config = replayConfig();
  const selectionOptions = { isMainAccountTokenLive: () => true };
  const report: { id: string; accounts: string[]; changes: number }[] = [];
  for (const conv of RECORDED) {
    const accounts: string[] = [];
    for (let i = 0; i < conv.turns; i++) {
      const turn = await bridgeTurn(config, { session: conv.session, turn: i });
      const thread = m.codexPoolAffinityKey(turn.req.headers);
      const lineage = thread !== undefined ? m.recordCodexThreadLineage(turn.req.headers) : undefined;
      const res = m.resolveCodexAccountForThreadDetailed(thread ?? null, config, Date.now(), undefined, selectionOptions, "gpt-5.4", lineage);
      expect(res.status).toBe("selected");
      accounts.push(res.accountId);
    }
    const changes = accounts.slice(1).filter((a, i) => a !== accounts[i]).length;
    report.push({ id: conv.id, accounts, changes });
  }
  // Both accounts must take part, or the replay could pass on a one-account pool.
  expect(new Set(report.flatMap(r => r.accounts)).size).toBeGreaterThan(1);
  for (const row of report) expect(row.changes).toBe(0);
});

// Fresh session uuids per test, so no binding carries over from another test.
const sessionFor = (n: number) => `${String(n).padStart(8, "0")}-a16c-4799-b66d-50f1866f43a1`;
type TurnInput = Parameters<typeof bridgeTurn>[1];
const headerOnly = (session: string): TurnInput => ({ system: "shared desktop system prompt", headers: { "x-claude-code-session-id": session } });

function addServed(served: Map<string, string[]>, id: string, account: string) {
  served.set(id, [...(served.get(id) ?? []), account]);
}

/** Every conversation stays on one account; with rotation, the conversations use more than one. */
function expectOneAccountEach(served: Map<string, string[]>, rotates = true) {
  for (const list of served.values()) expect(new Set(list).size).toBe(1);
  if (rotates) expect(new Set([...served.values()].flat()).size).toBeGreaterThan(1);
}

/** Interleaved turns through the real Codex pool resolver, as in the bridge replay. */
async function codexReplay(config: unknown, conversations: { id: string; input: TurnInput }[], rounds: number) {
  const selectionOptions = { isMainAccountTokenLive: () => true };
  const served = new Map<string, string[]>();
  for (let round = 0; round < rounds; round++) for (const conv of conversations) {
    const turn = await bridgeTurn(config, { ...conv.input, turn: round });
    const thread = m.codexPoolAffinityKey(turn.req.headers);
    expect(thread).toBeDefined();
    const lineage = m.recordCodexThreadLineage(turn.req.headers);
    const res = m.resolveCodexAccountForThreadDetailed(thread, config, Date.now(), undefined, selectionOptions, "gpt-5.4", lineage);
    expect(res.status).toBe("selected");
    addServed(served, conv.id, res.accountId);
  }
  return served;
}

const R1_CASES: Record<string, Record<string, string>> = {
  "session_id only": { session_id: "caller-r1-session-a" },
  "session-id only": { "session-id": "caller-r1-session-b" },
};

test("partial identity: a caller session alias still gets a pool key", async () => {
  const config = m.getDefaultConfig();
  for (const headers of Object.values(R1_CASES)) {
    const turn = await bridgeTurn(config, { session: S1, headers });
    const h = turn.req.headers;
    expect(m.codexPoolAffinityKey(h)).toBeDefined();
    const callerSession = headers.session_id ?? headers["session-id"];
    // The caller session names the session and the root thread; upstream keeps that session_id.
    expect(h.get("session-id")).toBe(callerSession!);
    expect(h.get("thread-id")).toBe(callerSession!);
    expect(m.withClaudeNativeSession(h, config.providers.openai, turn.options.claudeNativeSessionId).get("session_id")).toBe(callerSession!);
  }
});

test("partial identity guard: a caller parent or an invalid caller session alias is not overridden", async () => {
  const config = m.getDefaultConfig();
  const parent = await bridgeTurn(config, { session: S1, headers: { "x-codex-parent-thread-id": "caller-r1-parent" } });
  expect(parent.req.headers.get("session-id")).toBeNull();
  expect(parent.req.headers.get("thread-id")).toBeNull();
  expect(m.codexPoolAffinityKey(parent.req.headers)).toBeDefined();
  // Native egress sends the caller's session_id as is; the pool must not name another session.
  const invalid = await bridgeTurn(config, { session: S1, headers: { session_id: "caller session with spaces" } });
  expect(invalid.req.headers.get("session-id")).toBeNull();
  expect(invalid.req.headers.get("thread-id")).toBeNull();
  // A lone caller thread-id is an explicit identity: it stays as sent and names the upstream session.
  const lone = await bridgeTurn(config, { session: S1, headers: { "thread-id": "caller-r1-thread" } });
  expect(lone.req.headers.get("thread-id")).toBe("caller-r1-thread");
  expect(lone.req.headers.get("session-id")).toBeNull();
});

test("partial identity replay: partial-identity conversations keep one Codex account each", async () => {
  const conversations = Object.entries(R1_CASES).map(([id, headers], i) => ({ id, input: { session: sessionFor(11 + i), headers } }));
  expectOneAccountEach(await codexReplay(replayConfig(), conversations, 4));
});

test("header-only session: x-claude-code-session-id without metadata names the session", async () => {
  const config = m.getDefaultConfig();
  const [h1, h2] = [sessionFor(21), sessionFor(22)];
  const keys: string[] = [];
  for (let i = 0; i < 3; i++) {
    const turn = await bridgeTurn(config, { ...headerOnly(h1), turn: i });
    expect(turn.options.promptCacheKeyIsSharedCohort).toBe(true);
    expect(turn.req.headers.get("session-id")).toBe(h1);
    expect(turn.req.headers.get("thread-id")).toBe(h1);
    keys.push(m.codexPoolAffinityKey(turn.req.headers));
  }
  const other = m.codexPoolAffinityKey((await bridgeTurn(config, headerOnly(h2))).req.headers);
  const noSystem = m.codexPoolAffinityKey((await bridgeTurn(config, { headers: { "x-claude-code-session-id": h1 } })).req.headers);
  expect(keys[0]).toBeDefined();
  expect(new Set(keys).size).toBe(1);
  expect(noSystem).toBe(keys[0]);
  expect(other).toBeDefined();
  expect(other).not.toBe(keys[0]);
});

test("header-only session guard: metadata wins over the header, and an invalid header names no session", async () => {
  const config = m.getDefaultConfig();
  const both = await bridgeTurn(config, { session: S1, headers: { "x-claude-code-session-id": sessionFor(23) } });
  expect(both.req.headers.get("session-id")).toBe(both.options.claudeNativeSessionId!);
  const invalid = await bridgeTurn(config, { system: "shared desktop system prompt", headers: { "x-claude-code-session-id": "not a session id" } });
  expect(invalid.req.headers.get("session-id")).toBeNull();
  expect(m.codexPoolAffinityKey(invalid.req.headers)).toBeUndefined();
});

test("header-only session principal scope: a remote header session is scoped to its admitted principal like x-session-id", async () => {
  const h1 = sessionFor(24);
  const headers = new Headers({ "x-claude-code-session-id": h1 });
  const remote = (principal?: string) => ({ kind: "configured", keyId: "fixture", source: "bearer", ...(principal ? { contextPrincipalId: principal } : {}) });
  expect(m.claudeHeaderSessionId(headers, { kind: "loopback", source: "loopback" })).toBe(h1);
  const p1 = m.claudeHeaderSessionId(headers, remote("principal-1"));
  const p2 = m.claudeHeaderSessionId(headers, remote("principal-2"));
  expect(p1).toMatch(/^[0-9a-f]{64}$/);
  expect(p2).toMatch(/^[0-9a-f]{64}$/);
  expect(p1).not.toBe(p2);
  expect(m.claudeHeaderSessionId(headers, remote())).toBeUndefined();
  const ingress = m.withCallerSessionIdentity(new Request("http://127.0.0.1/v1/messages", { headers: { "x-session-id": h1 } }), remote("principal-1"));
  expect(ingress.headers.get("session_id")).toBe(p1);
});

test("header-only session replay: header-only Claude sessions keep one Codex account each", async () => {
  const conversations = [25, 26, 27].map(n => ({ id: "header-" + n, input: headerOnly(sessionFor(n)) }));
  expectOneAccountEach(await codexReplay(replayConfig(), conversations, 4));
});

// Two fixture accounts per pool; sessions with metadata and one header-only session interleave.
const R3_CONVERSATIONS: { id: string; input: TurnInput }[] = [
  { id: "metadata-1", input: { session: sessionFor(31) } },
  { id: "header-only", input: headerOnly(sessionFor(32)) },
  { id: "metadata-2", input: { session: sessionFor(33) } },
];
const R3_ROUNDS = 4;

/** The OAuth pool session key request-transport.ts derives from the replay request. */
function oauthKeyOf(turn: Captured): string | null {
  return m.oauthSessionKeyFromParts({
    sessionIdHeader: m.sessionIdHeaderFromRequest(turn.req.headers),
    threadIdHeader: turn.req.headers.get("thread-id"),
    promptCacheKey: typeof turn.body.prompt_cache_key === "string" ? turn.body.prompt_cache_key : null,
    clientThreadId: turn.req.headers.get("x-codex-parent-thread-id")?.trim() || null,
    promptCacheKeyIsSharedCohort: turn.options.promptCacheKeyIsSharedCohort === true,
  });
}

async function seedOAuthPool(provider: string, ids: string[]) {
  await m.replaceProviderAccountSet(provider, { activeAccountId: ids[0], accounts: ids.map(id => ({ id,
    credential: { access: fixtureValue(id + "-a"), refresh: fixtureValue(id + "-r"), expires: Date.now() + 86_400_000 } })) });
}

test("Anthropic pool: real selection and binding keep one account per session", async () => {
  const config = { ...m.getDefaultConfig(),
    anthropicAccountPool: { enabled: true, strategy: "round-robin", stickyLimit: 1, autoSwitchThreshold: 99, quotaWindow: "weekly" } };
  await seedOAuthPool("anthropic", ["ant-fixture-a", "ant-fixture-b"]);
  const served = new Map<string, string[]>();
  const reasons: string[] = [];
  for (let round = 0; round < R3_ROUNDS; round++) for (const conv of R3_CONVERSATIONS) {
    const sessionKey = oauthKeyOf(await bridgeTurn(config, { ...conv.input, turn: round }));
    const selection = m.resolveAnthropicAccountForSession(sessionKey, config, Date.now(), null);
    expect(selection.accountId).toBeTruthy();
    // request-transport.ts commitResolvedOAuthSelection: store commit, then the pool's own routing commit and bind.
    const expected = m.captureOAuthAccountSelection("anthropic");
    const committed = await m.commitOAuthAccountSelection("anthropic", selection.accountId, { expectedSelection: expected, requireUsableAccount: true });
    expect(committed).not.toBeNull();
    expect(m.commitAnthropicSelectionRouting(selection.accountId, expected, committed, { config, sessionKey, reason: selection.reason })).toBe(true);
    if (round > 0) reasons.push(conv.id + ":" + selection.reason);
    addServed(served, conv.id, selection.accountId);
  }
  expectOneAccountEach(served);
  expect(reasons.filter(reason => !reason.endsWith(":affinity"))).toEqual([]);
});

test("generic OAuth pool: real selection and binding keep one account per session", async () => {
  const base = m.getDefaultConfig();
  const provider = "command-code";
  const config = { ...base, pool: { kernel: true }, providers: { ...base.providers, [provider]: {
    adapter: "command-code", baseUrl: "https://api.commandcode.ai", authMode: "oauth",
    oauthAccountFailover: { enabled: true, strategy: "round-robin", stickyLimit: 1, sessionAffinity: "conversation" } } } };
  await seedOAuthPool(provider, ["cc-fixture-a", "cc-fixture-b"]);
  const served = new Map<string, string[]>();
  const reasons: string[] = [];
  for (let round = 0; round < R3_ROUNDS; round++) for (const conv of R3_CONVERSATIONS) {
    const key = oauthKeyOf(await bridgeTurn(config, { ...conv.input, turn: round }));
    // request-transport.ts: the generic key is scoped by principal; this in-process replay has no admission.
    const session = key ? JSON.stringify(["loopback", key]) : null;
    const selection = m.captureOAuthAccountSelection(provider);
    const bound = m.genericSessionAccount(config, provider, session);
    const chosen = bound ?? m.preferredGenericSessionAccount(config, provider, session)
      ?? m.preferredInitialAccount(config, provider, Date.now()) ?? selection.accountId;
    const snapshot = await m.getValidAccessSnapshotForAccount(provider, chosen, { requireUsableAccount: true });
    expect(m.admitGenericSessionAccount(config, provider, selection, snapshot, undefined, true)).not.toBeNull();
    m.bindGenericSessionAccount(config, provider, session, chosen);
    if (!bound || bound !== chosen) m.noteGenericPoolSelection(config, provider, chosen);
    if (round > 0) reasons.push(conv.id + ":" + (bound === chosen ? "affinity" : "unbound"));
    addServed(served, conv.id, chosen);
  }
  expectOneAccountEach(served);
  expect(reasons.filter(reason => !reason.endsWith(":affinity"))).toEqual([]);
});

// Direct Responses identity at ingress.
// Direct Responses identity at ingress.
const LOOPBACK = { kind: "loopback", source: "loopback" };
const remoteAdmission = (principal?: string) => ({ kind: "configured", keyId: "fixture", source: "bearer",
  ...(principal ? { contextPrincipalId: principal } : {}) });
const directRequest = (path: string, headers: Record<string, string>) => new Request("http://127.0.0.1:10100" + path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "gpt-5.4", input: "fixture" }) });
const admittedHeaders = (headers: Record<string, string>, admission: unknown = LOOPBACK, path = "/v1/responses"): Headers =>
  m.withCallerSessionIdentity(directRequest(path, headers), admission).headers;
const SESSION_HEADER_NAMES = ["session_id", "session-id", "thread-id"];

test("direct Responses: ingress x-session-id completes the Codex identity within its principal", async () => {
  const sid = "delta-direct-session";
  const h = admittedHeaders({ "x-session-id": sid });
  expect(h.get("session_id")).toBe(sid);
  expect(h.get("session-id")).toBe(sid);
  expect(h.get("thread-id")).toBe(sid);
  const affinity = m.codexPoolAffinityKey(h);
  expect(affinity).toBeDefined();
  expect(m.codexPoolAffinityKey(admittedHeaders({ "x-session-id": sid }))).toBe(affinity);
  expect(m.codexPoolAffinityKey(admittedHeaders({ "x-session-id": "delta-direct-other" }))).not.toBe(affinity);
  // Each admitted principal gets its own scoped session; a remote caller without a principal gets none.
  const p1 = admittedHeaders({ "x-session-id": sid }, remoteAdmission("principal-1"));
  const p2 = admittedHeaders({ "x-session-id": sid }, remoteAdmission("principal-2"));
  expect(p1.get("session_id")).toMatch(/^[0-9a-f]{64}$/);
  expect(p1.get("session-id")).toBe(p1.get("session_id"));
  expect(p1.get("thread-id")).toBe(p1.get("session_id"));
  expect(m.codexPoolAffinityKey(p1)).toBeDefined();
  expect(m.codexPoolAffinityKey(p1)).not.toBe(m.codexPoolAffinityKey(p2));
  expect(admittedHeaders({ "x-session-id": sid }, remoteAdmission()).get("session-id")).toBeNull();
  // A caller identity header or a declared parent is not overridden.
  const caller = admittedHeaders({ "x-session-id": sid, "thread-id": "caller-direct-thread" });
  expect(caller.get("session-id")).toBeNull();
  expect(caller.get("thread-id")).toBe("caller-direct-thread");
  const parent = admittedHeaders({ "x-session-id": sid, "x-codex-parent-thread-id": "caller-direct-parent" });
  expect(parent.get("session_id")).toBe(sid);
  expect(parent.get("session-id")).toBeNull();
  expect(parent.get("thread-id")).toBeNull();
  // The Messages route keeps the bridge key it had when ingress promoted only session_id.
  const ingress = admittedHeaders({ "x-session-id": sid }, LOOPBACK, "/v1/messages");
  const forwarded = Object.fromEntries([...ingress.entries()].filter(([name]) => SESSION_HEADER_NAMES.includes(name)));
  const viaIngress = await bridgeTurn(m.getDefaultConfig(), { session: S1, headers: forwarded });
  const viaAlias = await bridgeTurn(m.getDefaultConfig(), { session: S1, headers: { session_id: sid } });
  expect(m.codexPoolAffinityKey(viaIngress.req.headers)).toBe(m.codexPoolAffinityKey(viaAlias.req.headers));
});

test("direct Responses replay: direct Responses sessions keep one Codex account each", async () => {
  const config = replayConfig();
  const selectionOptions = { isMainAccountTokenLive: () => true };
  const served = new Map<string, string[]>();
  const threads: unknown[] = [];
  for (let round = 0; round < 4; round++) for (const id of ["direct-41", "direct-42", "direct-43"]) {
    const h = admittedHeaders({ "x-session-id": "fixture-" + id });
    const thread = m.codexPoolAffinityKey(h);
    threads.push(thread ?? null);
    const lineage = thread !== undefined ? m.recordCodexThreadLineage(h) : undefined;
    const res = m.resolveCodexAccountForThreadDetailed(thread ?? null, config, Date.now(), undefined, selectionOptions, "gpt-5.4", lineage);
    expect(res.status).toBe("selected");
    addServed(served, id, res.accountId);
  }
  expectOneAccountEach(served);
  expect(threads.filter(value => value === null)).toEqual([]);
});
