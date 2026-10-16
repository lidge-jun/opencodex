import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { clearQoderBinaryCache } from "../../src/adapters/qoder/profiles";
import type { IncomingMeta } from "../../src/adapters/base";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

function completedChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = Readable.from([
    JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] }) + "\n",
    JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n",
  ].map(frame => new TextEncoder().encode(frame)));
  child.stderr = Readable.from([]);
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.exitCode = 0;
  child.kill = () => true;
  return child;
}

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
