import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createCodeBuddyAdapter } from "../../src/adapters/codebuddy/adapter";
import { createClaudeCliAdapter } from "../../src/adapters/claude-cli/adapter";
import { createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { clearQoderBinaryCache } from "../../src/adapters/qoder/profiles";
import type { IncomingMeta } from "../../src/adapters/base";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";
import { saveConfig } from "../../src/config";

test.each([
  ["codebuddy", createCodeBuddyAdapter],
  ["claude-cli", createClaudeCliAdapter],
  ["qoder", createQoderAdapter],
] as const)("%s declares ownership of the shared CLI runner's physical sends", (adapter, create) => {
  expect(create({ adapter, baseUrl: "https://example.invalid" }).reportsPhysicalSends).toBe(true);
});

function completedChild(refused = false): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = Readable.from([
    JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
    JSON.stringify({ type: "result", subtype: refused ? "error_during_execution" : "success",
      is_error: refused, ...(refused ? { error_code: 105 } : {}) }) + "\n",
  ].map(frame => new TextEncoder().encode(frame)));
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.exitCode = 0;
  child.kill = () => true;
  return child;
}

test.each([false, true])("Qoder records only admitted spawns after a 401 (deny replacement=%s)", async denyReplacement => {
  const home = createTempHome("ocx-qoder-spawn-receipt-");
  const release = acquireOwnedSpendHome();
  const log: RequestLogContext = {};
  let spawns = 0;
  const receipts: unknown[] = [];
  let denied = 0;
  using adapter = spyOn(ADAPTER_REGISTRY.qoder, "create").mockImplementation(provider => {
    const qoder = createQoderAdapter(provider, {
      which: () => "/synthetic/qoder",
      spawn: () => {
        receipts.push(log.attempts?.map(attempt => [attempt.sendCount, [...attempt.recoveryKinds]]));
        return completedChild(++spawns === 1);
      },
    });
    const runTurn = qoder.runTurn!;
    qoder.runTurn = (parsed, incoming, emit) => {
      const budget = incoming.sendBudget;
      if (denyReplacement && spawns === 1 && budget) {
        incoming = {
          ...incoming,
          sendBudget: {
            ...budget,
            reserveDispatch() {
              denied++;
              return { allowed: false, reason: "total-exhausted" };
            },
          },
        };
      }
      return runTurn(parsed, incoming, emit);
    };
    return qoder;
  });
  try {
    const keyA = "synthetic-qoder-first";
    const keyB = "synthetic-qoder-second";
    const config = { port: 0, defaultProvider: "qoder", providers: { qoder: {
      adapter: "qoder", authMode: "key", baseUrl: "https://qoder.com", apiKey: keyA, models: ["Qwen3.8-Max"],
      apiKeyPool: [{ id: "a", key: keyA }, { id: "b", key: keyB }],
    } } } as OcxConfig;
    saveConfig(config);
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qoder/Qwen3.8-Max", input: "hello", stream: false }),
    }), config, log);
    const body = await response.text();
    expect(log.attempts?.[0]).toMatchObject({ status: 401, sendCount: 1, failureCause: "credential-rejected" });
    if (denyReplacement) {
      expect(denied).toBe(1);
      expect(spawns, body).toBe(1);
      expect(receipts).toEqual([[[1, []]]]);
      expect(log.attempts).toHaveLength(1);
      return;
    }
    expect(spawns, body).toBe(2);
    expect(receipts).toEqual([[[1, []]], [[1, []], [1, ["key-401"]]]]);
    expect(log.attempts?.[0]?.accountLogLabel).not.toBe(log.attempts?.[1]?.accountLogLabel);
  } finally {
    release();
    home.remove();
  }
});

for (const invalidation of ["selection", "abort", "valid"] as const) {
  test(`Qoder fences spawn after asynchronous tool setup (${invalidation})`, async () => {
    clearQoderBinaryCache();
    const abort = new AbortController();
    const events: AdapterEvent[] = [];
    const sendBudget = createRequestExecutionBudget();
    let current = true;
    let staged = 0;
    let guardCalls = 0;
    let spawns = 0;
    let physicalSends = 0;
    let bridgeDir: string | undefined;
    const adapter = createQoderAdapter({ adapter: "qoder", authMode: "key", baseUrl: "https://qoder.com", apiKey: "synthetic-pat" }, {
      which: () => "/synthetic/qoder",
      async writeToolBridgeFile(...args) {
        bridgeDir = dirname(String(args[0]));
        await writeFile(...args);
        if (++staged === 2) {
          current = invalidation !== "selection";
          if (invalidation === "abort") abort.abort();
        }
      },
      spawn: () => { spawns++; return completedChild(); },
    });
    const parsed = { modelId: "Qwen3.8-Max", stream: false, options: {},
      context: { tools: [{ name: "probe", parameters: { type: "object", properties: {} } }], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    } as OcxParsedRequest;
    const incoming: IncomingMeta = {
      headers: new Headers(), translatorBudget: createTestTranslatorBudget(), abortSignal: abort.signal, sendBudget,
      beforePhysicalSend() { guardCalls++; if (!current) throw new Error("selection invalidated during setup"); },
      onPhysicalSend() { physicalSends++; },
    };
    const pending = adapter.runTurn!(parsed, incoming, event => events.push(event));
    if (invalidation === "selection") await expect(pending).rejects.toThrow("selection invalidated during setup");
    else await pending;
    expect(staged).toBe(2);
    expect(adapter.reportsPhysicalSends).toBe(true);
    expect(spawns).toBe(invalidation === "valid" ? 1 : 0);
    expect(physicalSends).toBe(invalidation === "valid" ? 1 : 0);
    expect(sendBudget.remainingBaseSends(3)).toBe(invalidation === "valid" ? 2 : 3);
    expect(guardCalls).toBe(invalidation === "abort" ? 0 : 1);
    expect(bridgeDir).toBeDefined();
    expect(existsSync(bridgeDir!)).toBe(false);
    if (invalidation === "valid") expect(events.at(-1)).toMatchObject({ type: "done" });
    else expect(events.some(event => event.type === "done")).toBe(false);
  });
}
