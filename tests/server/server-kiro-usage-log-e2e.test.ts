import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME } from "../../src/adapters/kiro-constants";
import { saveConfig } from "../../src/config";
import { encodeMessage } from "../../src/lib/eventstream-decoder";
import { saveCredential } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries, type RequestLogEntry } from "../../src/server/request-log";
import { readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// What Kiro itself reports for one turn, and what the usage ledger must record for it whichever
// client wire asked: reported counts, credits, no estimate. The prompt below is long enough that
// the adapter's own input estimate is far above these counts, so a row that fell back to the
// estimate cannot pass for a reported one.
const CREDITS = 0.04582331509121062;
const TOKENS = { uncachedInputTokens: 1000, cacheReadInputTokens: 400, cacheWriteInputTokens: 100, outputTokens: 50, totalTokens: 1550 };
const REPORTED = {
  inputTokens: 1500,
  outputTokens: 50,
  cachedInputTokens: 400,
  cacheReadInputTokens: 400,
  cacheCreationInputTokens: 100,
  providerCredits: CREDITS,
};
const LONG_PROMPT = "Summarise the repository layout. ".repeat(3000);

const enc = new TextEncoder();
const CHAT_ENDPOINT = "https://runtime.us-east-1.kiro.dev/";
const originalFetch = globalThis.fetch;

let testDir = "";
let previousOpenCodexHome: string | undefined;
let previousRegion: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousRegion = process.env.KIRO_REGION;
  isolatedCodexHome = installIsolatedCodexHome("ocx-kiro-usage-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-kiro-usage-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.KIRO_REGION = "us-east-1";
  clearRequestLogsForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousRegion === undefined) delete process.env.KIRO_REGION;
  else process.env.KIRO_REGION = previousRegion;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  removeTreeWithRetry(testDir);
});

function eventFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return encodeMessage({ ":message-type": "event", ":event-type": eventType }, enc.encode(JSON.stringify(payload)));
}

function kiroTurn(withTokenUsage: boolean): Uint8Array[] {
  return [
    eventFrame("assistantResponseEvent", { content: "The layout is flat." }),
    ...kiroMeters(withTokenUsage),
  ];
}

function kiroMeters(withTokenUsage: boolean): Uint8Array[] {
  return [
    eventFrame("meteringEvent", { unit: "credit", unitPlural: "credits", usage: CREDITS }),
    ...(withTokenUsage ? [eventFrame("metadataEvent", { tokenUsage: TOKENS })] : []),
  ];
}

/** With tools declared, Kiro answers in two legs: progress prose, then the private completion call. */
function kiroTwoLegTurn(secondLegTokenUsage: boolean): Uint8Array[][] {
  const input = JSON.stringify({ answer: "The layout is flat." });
  const toolUse = (extra: Record<string, unknown>) =>
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "completion-1", ...extra });
  return [
    [eventFrame("assistantResponseEvent", { content: "Checking the layout." }), ...kiroMeters(true)],
    [toolUse({}), toolUse({ input }), toolUse({ stop: true }), ...kiroMeters(secondLegTokenUsage)],
  ];
}

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]);
      else controller.close();
    },
  });
}

type Route = "direct" | "combo";

async function startKiro(route: Route, turns: Uint8Array[][]): Promise<ReturnType<typeof startServer>> {
  await saveCredential("kiro", {
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "kiro-usage-account",
    source: "oauth",
  });
  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kiro",
    providers: { kiro: { adapter: "kiro", baseUrl: CHAT_ENDPOINT.slice(0, -1), authMode: "oauth", models: ["claude-sonnet-4.5"] } },
    ...(route === "combo"
      ? { combos: { claude: { strategy: "failover", targets: [{ provider: "kiro", model: "claude-sonnet-4.5" }] } } }
      : {}),
  } as unknown as OcxConfig);
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CHAT_ENDPOINT) {
      return new Response(streamOf(turns.shift() ?? []), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return startServer(0);
}

const MODEL: Record<Route, string> = { direct: "kiro/claude-sonnet-4.5", combo: "combo/claude" };

interface Entry {
  label: string;
  path: string;
  body: (model: string) => Record<string, unknown>;
}

const ENTRIES: Entry[] = [
  {
    label: "/v1/responses stream",
    path: "/v1/responses",
    body: model => ({ model, input: LONG_PROMPT, stream: true }),
  },
  {
    label: "/v1/messages stream",
    path: "/v1/messages",
    body: model => ({ model, max_tokens: 256, stream: true, messages: [{ role: "user", content: LONG_PROMPT }] }),
  },
  {
    label: "/v1/messages non-stream",
    path: "/v1/messages",
    body: model => ({ model, max_tokens: 256, stream: false, messages: [{ role: "user", content: LONG_PROMPT }] }),
  },
  {
    label: "/v1/chat/completions non-stream",
    path: "/v1/chat/completions",
    body: model => ({ model, stream: false, messages: [{ role: "user", content: LONG_PROMPT }] }),
  },
];

async function ask(proxy: ReturnType<typeof startServer>, entry: Entry, route: Route): Promise<string> {
  const response = await originalFetch(new URL(entry.path, proxy.url), {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(entry.body(MODEL[route])),
  });
  expect(response.status).toBe(200);
  return response.text();
}

async function finalRow(): Promise<{ memory: RequestLogEntry; persisted: ReturnType<typeof readUsageEntries>[number] }> {
  for (let attempt = 0; attempt < 100 && getRequestLogEntries().length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const memory = getRequestLogEntries().at(-1);
  if (!memory) throw new Error("no request log row was written");
  resetUsageReadCacheForTests();
  const persisted = readUsageEntries().find(row => row.requestId === memory.requestId);
  if (!persisted) throw new Error("the row never reached usage.jsonl");
  return { memory, persisted };
}

describe("Kiro usage reaches the ledger as Kiro reported it, on every inbound wire", () => {
  for (const route of ["direct", "combo"] as const) {
    for (const entry of ENTRIES) {
      test(`${entry.label} via ${route} records reported counts and credits`, async () => {
        const proxy = await startKiro(route, [kiroTurn(true)]);
        try {
          await ask(proxy, entry, route);
          const { memory, persisted } = await finalRow();
          for (const row of [memory, persisted]) {
            expect(row.usageStatus).toBe("reported");
            expect(row.usage).toMatchObject(REPORTED);
            expect(row.usage?.estimated).toBeUndefined();
            expect(row.totalTokens).toBe(1550);
          }
        } finally {
          await proxy.stop(true);
        }
      });

      test(`${entry.label} via ${route} stays estimated when Kiro sent no token usage`, async () => {
        const proxy = await startKiro(route, [kiroTurn(false)]);
        try {
          await ask(proxy, entry, route);
          const { memory, persisted } = await finalRow();
          for (const row of [memory, persisted]) {
            expect(row.usageStatus).toBe("estimated");
            expect(row.usage?.estimated).toBe(true);
            // The credits are metered separately from tokens and survive the missing token frame.
            expect(row.usage?.providerCredits).toBe(CREDITS);
            // The local estimate is a floor here, so it is the count that was written down.
            expect(row.usage?.inputTokens).toBeGreaterThan(REPORTED.inputTokens);
          }
        } finally {
          await proxy.stop(true);
        }
      });
    }
  }

  test("the Claude wire still carries Kiro's output and cache counts", async () => {
    const proxy = await startKiro("combo", [kiroTurn(true)]);
    try {
      const messages = ENTRIES.find(entry => entry.label === "/v1/messages non-stream")!;
      const message = JSON.parse(await ask(proxy, messages, "combo")) as { usage: Record<string, number> };
      expect(message.usage).toMatchObject({
        output_tokens: 50,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 100,
      });
    } finally {
      await proxy.stop(true);
    }
  });

  // Claude Code always declares tools, so its text answers take the two-leg path.
  for (const route of ["direct", "combo"] as const) {
    test(`a two-leg /v1/messages turn via ${route} sums both legs and stays reported`, async () => {
      const proxy = await startKiro(route, kiroTwoLegTurn(true));
      try {
        const tools = [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }];
        await ask(proxy, { label: "", path: "/v1/messages", body: model => ({
          model, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: LONG_PROMPT }],
        }) }, route);
        const { memory, persisted } = await finalRow();
        for (const row of [memory, persisted]) {
          expect(row.usageStatus).toBe("reported");
          expect(row.usage).toMatchObject({
            inputTokens: 2 * REPORTED.inputTokens,
            outputTokens: 2 * REPORTED.outputTokens,
            cacheReadInputTokens: 2 * REPORTED.cacheReadInputTokens,
            cacheCreationInputTokens: 2 * REPORTED.cacheCreationInputTokens,
            providerCredits: 2 * CREDITS,
          });
          expect(row.usage?.estimated).toBeUndefined();
        }
      } finally {
        await proxy.stop(true);
      }
    });

    test(`a two-leg turn via ${route} is estimated when one leg lacks token usage`, async () => {
      const proxy = await startKiro(route, kiroTwoLegTurn(false));
      try {
        const tools = [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }];
        await ask(proxy, { label: "", path: "/v1/messages", body: model => ({
          model, max_tokens: 256, stream: true, tools, messages: [{ role: "user", content: LONG_PROMPT }],
        }) }, route);
        const { memory, persisted } = await finalRow();
        for (const row of [memory, persisted]) {
          expect(row.usageStatus).toBe("estimated");
          expect(row.usage?.estimated).toBe(true);
          expect(row.usage?.providerCredits).toBe(2 * CREDITS);
        }
      } finally {
        await proxy.stop(true);
      }
    });
  }
});
