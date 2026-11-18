/**
 * Anthropic pool attempts carry an opaque `accountTag` (#8383): the `p<hex6>` label that
 * `formatAnthropicProviderForLog` already folds into the logged provider, as its own field on each
 * attempt and on the row. `accountLogLabel` and the per-account summaries stay exactly as before.
 * Every credential is synthetic and any real network call fails the case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum, formatAnthropicProviderForLog } from "../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import { clearResponseStateForTests } from "../../src/responses/state";
import {
  addFinalRequestLog, getRequestLogEntries, requestLogEntryFromPersistedUsage,
  type RequestLogContext, type RequestLogEntry,
} from "../../src/server/request-log";
import { normalizeUsageEntryForTest, readUsageEntries, type PersistedUsageEntry } from "../../src/usage/log";
import { summarizeUsage } from "../../src/usage/summary";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;
let originalFetch: typeof globalThis.fetch;
let unexpectedFetches = 0;
let releaseSpendHome: (() => void) | undefined;
let sent: string[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-account-tag-"));
  process.env.OPENCODEX_HOME = home;
  sent = [];
  originalFetch = globalThis.fetch;
  unexpectedFetches = 0;
  globalThis.fetch = (async () => {
    unexpectedFetches += 1;
    throw new Error("unexpected global fetch in the Anthropic account tag test");
  }) as unknown as typeof fetch;
  clearAnthropicAccountPoolState();
  clearUpstreamHostHealth();
  forgetAnthropicFailoverQuorum();
  clearResponseStateForTests();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  try {
    expect(unexpectedFetches).toBe(0);
  } finally {
    clearAnthropicAccountPoolState();
    clearUpstreamHostHealth();
    forgetAnthropicFailoverQuorum();
    clearResponseStateForTests();
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
  }
});

function credential(index: number) {
  return {
    access: `synthetic-anthropic-access-${index}`,
    refresh: `synthetic-anthropic-refresh-${index}`,
    expires: Date.now() + 3_600_000,
    accountId: `synthetic-account-${index}`,
    email: `synthetic-${index}@example.test`,
    source: "oauth" as const,
  };
}

async function seed(count: number): Promise<string[]> {
  for (let index = 0; index < count; index++) await saveCredential("anthropic", credential(index));
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  forgetAnthropicFailoverQuorum();
  return ids;
}

const tagOf = (accountId: string) => formatAnthropicProviderForLog("anthropic", accountId).slice("anthropic-".length);

const MESSAGE = {
  id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "fixture answer" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 9, output_tokens: 4 },
};

function limited(): Response {
  return Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture quota" } }, {
    status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" },
  });
}

/** One pooled Anthropic OAuth provider whose transport answers each send through `reply`. */
function poolConfig(reply: (send: number) => Response, native: boolean, pooled = true): OcxConfig {
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", models: ["claude-sonnet-4-5"],
    fetch: (async (_input, init) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return reply(sent.length);
    }) as typeof fetch,
  };
  const config = {
    port: 0, defaultProvider: "anthropic", anthropicAccountPool: { enabled: pooled }, providers: { anthropic: provider },
    ...(native ? { protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } } } : {}),
  } as OcxConfig;
  saveConfig(config);
  return config;
}

async function sendNative(config: OcxConfig): Promise<RequestLogEntry> {
  const requestId = `account-tag-native-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", max_tokens: 64, stream: false,
      messages: [{ role: "user", content: "fixture question" }] }),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  expect(response.status).toBe(200);
  await response.text();
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.protocolTrace?.mode).toBe("native");
  return rows[0]!;
}

async function sendTranslated(config: OcxConfig): Promise<RequestLogEntry> {
  const requestId = `account-tag-translated-${crypto.randomUUID()}`;
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const start = Date.now();
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", input: "Answer briefly", stream: false }),
  }), config, logCtx);
  expect(response.status).toBe(200);
  await response.text();
  const rows: RequestLogEntry[] = [];
  addFinalRequestLog(requestId, start, logCtx, response.status, undefined, row => rows.push(row));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function expectNoIdentityLeak(row: unknown, ids: readonly string[]): void {
  const serialized = JSON.stringify(row);
  for (const id of ids) expect(serialized).not.toContain(id);
  expect(serialized).not.toContain("synthetic-account-");
  expect(serialized).not.toContain("synthetic-anthropic-");
  expect(serialized).not.toContain("@example.test");
}

describe("Anthropic pool attempts carry the served account's tag", () => {
  for (const [path, native] of [["native Messages", true], ["translated Responses", false]] as const) {
    test(`${path}: a single attempt carries the account tag on the attempt and the row`, async () => {
      const ids = await seed(1);
      const row = await (native ? sendNative : sendTranslated)(poolConfig(() => Response.json(MESSAGE), native));
      expect(row.attempts).toHaveLength(1);
      expect(row.attempts![0]!.accountTag).toBe(tagOf(ids[0]!));
      expect(row.accountTag).toBe(tagOf(ids[0]!));
      // The provider label still carries the same p-label: the tag adds no new identifier.
      expect(row.provider).toBe(`anthropic-${tagOf(ids[0]!)}`);
      expect(row.accountLogLabel).toBeUndefined();
      expect(row.attempts![0]!.accountLogLabel).toBeUndefined();
      expectNoIdentityLeak(row, ids);
    });

    test(`${path}: a failover attempt carries the second account's tag`, async () => {
      const ids = await seed(2);
      const row = await (native ? sendNative : sendTranslated)(poolConfig(send => send === 1 ? limited() : Response.json(MESSAGE), native));
      expect(sent).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
      expect(row.attempts?.map(attempt => attempt.status)).toEqual([429, 200]);
      expect(row.attempts?.map(attempt => attempt.accountTag)).toEqual([tagOf(ids[0]!), tagOf(ids[1]!)]);
      expect(tagOf(ids[0]!)).not.toBe(tagOf(ids[1]!));
      expect(row.attempts?.map(attempt => attempt.provider)).toEqual(ids.map(id => `anthropic-${tagOf(id)}`));
      expect(row.accountTag).toBe(tagOf(ids[1]!));
      expect(row.attempts?.map(attempt => attempt.accountLogLabel)).toEqual([undefined, undefined]);
      expectNoIdentityLeak(row, ids);
      if (native) {
        // The native row is persisted by the default writer; the tag survives usage.jsonl and hydration.
        const persisted = readUsageEntries().filter(entry => entry.requestId === row.requestId);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]!.accountTag).toBe(tagOf(ids[1]!));
        expect(persisted[0]!.attempts?.map(attempt => attempt.accountTag)).toEqual([tagOf(ids[0]!), tagOf(ids[1]!)]);
        expectNoIdentityLeak(persisted[0], ids);
        const hydrated = requestLogEntryFromPersistedUsage(persisted[0]!);
        expect(hydrated.accountTag).toBe(tagOf(ids[1]!));
        expect(hydrated.attempts?.map(attempt => attempt.accountTag)).toEqual([tagOf(ids[0]!), tagOf(ids[1]!)]);
      }
    });
  }
});

test("translated Responses with the pool off logs no p-label, so it carries no tag", async () => {
  const ids = await seed(1);
  const row = await sendTranslated(poolConfig(() => Response.json(MESSAGE), false, false));
  // Nothing is minted: without the account-qualified provider there is no label to reuse.
  expect(row.provider).toBe("anthropic");
  expect(row.attempts?.map(attempt => attempt.provider)).toEqual(["anthropic"]);
  expect(Object.hasOwn(row, "accountTag")).toBe(false);
  expect(Object.hasOwn(row.attempts![0]!, "accountTag")).toBe(false);
  expectNoIdentityLeak(row, ids);
});

describe("persisted account tags", () => {
  const attempt = (accountTag: unknown) => ({
    ordinal: 1, provider: "anthropic-p2e22d0", model: "claude-sonnet-4-5", adapter: "anthropic", status: 200,
    durationMs: 1, sendCount: 1, recoveryKinds: [], usageStatus: "reported" as const,
    usage: { inputTokens: 9, outputTokens: 4 }, accountTag,
  });
  const entry = (accountTag: unknown): PersistedUsageEntry => ({
    requestId: "persisted-tag", timestamp: 1_000, provider: "anthropic-p2e22d0", model: "claude-sonnet-4-5",
    status: 200, durationMs: 1, usageStatus: "reported", usage: { inputTokens: 9, outputTokens: 4 },
    accountTag, attempts: [attempt(accountTag)],
  } as unknown as PersistedUsageEntry);

  test("a well-formed p-label survives normalization and hydration", () => {
    const normalized = normalizeUsageEntryForTest(entry("p2e22d0"));
    expect(normalized.accountTag).toBe("p2e22d0");
    expect(normalized.attempts?.[0]?.accountTag).toBe("p2e22d0");
    const hydrated = requestLogEntryFromPersistedUsage(entry("p2e22d0"));
    expect(hydrated.accountTag).toBe("p2e22d0");
    expect(hydrated.attempts?.[0]?.accountTag).toBe("p2e22d0");
  });

  test.each([
    "main", "o2e22d0", "P2E22D0", "p2e22d", "p2e22d0f", " p2e22d0", "k" + "0".repeat(32),
    "someone@example.test", "synthetic-account-0", 42, null, { tag: "p2e22d0" },
  ])("a malformed persisted tag %p is dropped", value => {
    const normalized = normalizeUsageEntryForTest(entry(value));
    expect(Object.hasOwn(normalized, "accountTag")).toBe(false);
    expect(Object.hasOwn(normalized.attempts![0]!, "accountTag")).toBe(false);
    const hydrated = requestLogEntryFromPersistedUsage(entry(value));
    expect(Object.hasOwn(hydrated, "accountTag")).toBe(false);
    expect(Object.hasOwn(hydrated.attempts![0]!, "accountTag")).toBe(false);
  });

  test("per-account usage summaries ignore the tag", () => {
    const strip = (value: PersistedUsageEntry): PersistedUsageEntry => {
      const { accountTag: _row, ...rest } = value as PersistedUsageEntry & { accountTag?: unknown };
      return { ...rest, attempts: rest.attempts?.map(({ accountTag: _attempt, ...attemptRest }) => attemptRest) } as PersistedUsageEntry;
    };
    const tagged = [normalizeUsageEntryForTest(entry("p2e22d0"))];
    expect(tagged[0]!.accountTag).toBe("p2e22d0");
    for (const surface of ["all", "codex"] as const) {
      expect(summarizeUsage(tagged, "all", 2_000, surface)).toEqual(summarizeUsage(tagged.map(strip), "all", 2_000, surface));
    }
  });
});

