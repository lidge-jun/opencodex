import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { clearQoderBinaryCache } from "../../src/adapters/qoder/profiles";
import { clearKeyCooldowns, forgetApiKeyRotationCursor } from "../../src/providers/key-failover";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { handleResponses } from "../../src/server/responses";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

for (const exhaust of [false, true]) {
  test(`runTurn rechecks every replacement pacing admission (exhaust=${exhaust})`, async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-runturn-readmission-"));
    process.env.OPENCODEX_HOME = home;
    resetProviderRequestPacingForTest();
    const releaseOwner = acquireOwnedSpendHome();
    const seen: string[] = [];
    const create = ADAPTER_REGISTRY["openai-chat"].create;
    // Keep the real handler, selection and pacing. Only replace the external turn executor.
    const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({
      ...create(...args),
      async runTurn(_parsed, _incoming, emit) {
        seen.push(args[0].apiKey!);
        emit({ type: "text_delta", text: "current turn" }); emit({ type: "done" });
      },
    }));
    const keys = ["first", "second", "third", "fourth", "fifth", "sixth"];
    const config = { port: 0, defaultProvider: "paced", providers: { paced: {
      adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key", apiKey: "synthetic-first",
      apiKeyPool: keys.map(id => ({ id, key: `synthetic-${id}` })),
      requestPacing: { enabled: true, keys: { maxConcurrentRequests: 1 } },
    } } } as OcxConfig;
    const slots = await Promise.all(keys.map(id => waitForProviderRequestSlot("paced", { ...config.providers.paced, apiKey: `synthetic-${id}` })));
    const abort = new AbortController();
    let pending: Promise<Response> | undefined;
    const waitForQueue = async (id: string) => {
      for (let i = 0; i < 200; i++) {
        if (providerRequestPacingStatus("paced", config.providers.paced).keys?.find(key => key.id === id)?.queued === 1) return;
        if (seen.length) throw new Error(`stale adapter invoked with ${seen[0]}`);
        await Bun.sleep(5);
      }
      throw new Error(`key ${id} never queued`);
    };
    try {
      pending = handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ model: "paced/test", input: "hello", stream: false }),
      }), config, { provider: "", model: "" }, { abortSignal: abort.signal });
      void pending.catch(() => {});
      await waitForQueue("first");
      const drifts = exhaust ? 5 : 4;
      for (let i = 0; i < drifts; i++) {
        config.providers.paced.apiKey = `synthetic-${keys[i + 1]}`;
        config.providers.paced.apiKeySelectionRevision = `revision-${i + 1}`;
        slots[i]!.release();
        if (i < drifts - 1 || !exhaust) await waitForQueue(keys[i + 1]!);
        expect(seen).toEqual([]);
        expect(providerRequestPacingStatus("paced", config.providers.paced).keys?.find(key => key.id === keys[i])?.inFlight).toBe(0);
      }
      if (!exhaust) slots[4]!.release();
      const response = await pending;
      const body = await response.text();
      expect(seen).toEqual(exhaust ? [] : ["synthetic-fifth"]);
      if (exhaust) {
        expect(JSON.parse(body).status).toBe("failed");
        expect(body).toContain("selection changed repeatedly");
      } else {
        expect(response.status).toBe(200);
        expect(body).toContain("current turn");
      }
      expect(providerRequestPacingStatus("paced", config.providers.paced).queued).toBe(0);
    } finally {
      abort.abort(); slots.forEach(slot => slot.release());
      await pending?.catch(() => undefined);
      override.mockRestore(); resetProviderRequestPacingForTest(); releaseOwner(); removeTreeWithRetry(home);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    }
  });
}

for (const change of ["selection", "opt-out", "abort"] as const) {
  test(`Responses carries Qoder's physical guard across async setup (${change})`, async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-qoder-readmission-"));
    process.env.OPENCODEX_HOME = home;
    resetProviderRequestPacingForTest(); clearQoderBinaryCache(); clearKeyCooldowns(); forgetApiKeyRotationCursor("paced");
    const releaseOwner = acquireOwnedSpendHome();
    const abort = new AbortController();
    const seen: string[] = [];
    let writes = 0;
    const config = { port: 0, defaultProvider: "paced", providers: { paced: {
      adapter: "qoder", baseUrl: "https://qoder.com", authMode: "key", apiKey: "synthetic-first",
      apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }],
      requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
    } } } as OcxConfig;
    const override = spyOn(ADAPTER_REGISTRY.qoder, "create").mockImplementation(provider => createQoderAdapter(provider, {
      which: () => "/synthetic/qoder",
      async writeToolBridgeFile(...args) {
        await writeFile(...args);
        if (++writes === 2) {
          if (change === "abort") abort.abort();
          else if (change === "opt-out") config.providers.paced.requestPacing!.enabled = false;
          else {
            config.providers.paced.apiKey = "synthetic-second";
            config.providers.paced.apiKeySelectionRevision = "after-setup";
          }
        }
      },
      spawn(_file, _args, options) {
        seen.push(options.env!.QODER_PERSONAL_ACCESS_TOKEN!);
        const child = new EventEmitter() as ChildProcess;
        child.stdout = Readable.from([
          { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
          { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "current Qoder turn" } } },
          { type: "result", subtype: "success", is_error: false },
        ].map(frame => new TextEncoder().encode(JSON.stringify(frame) + "\n")));
        child.stderr = Readable.from([]);
        child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        child.exitCode = 0;
        child.kill = () => true;
        return child;
      },
    }));
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ model: "paced/Qwen3.8-Max", input: "hello", stream: false,
          tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: {} } }],
        }),
      }), config, { provider: "", model: "" }, { abortSignal: abort.signal });
      const body = await response.text();
      expect(seen).toEqual(change === "abort" ? [] : [change === "selection" ? "synthetic-second" : "synthetic-first"]);
      expect(writes).toBe(change === "abort" ? 2 : 4);
      if (change !== "abort") {
        expect(response.status).toBe(200);
        expect(body).toContain("current Qoder turn");
      }
      expect(providerRequestPacingStatus("paced", config.providers.paced).queued).toBe(0);
      expect(providerRequestPacingStatus("paced", config.providers.paced).inFlight ?? 0).toBe(0);
    } finally {
      abort.abort(); override.mockRestore(); resetProviderRequestPacingForTest(); clearKeyCooldowns(); forgetApiKeyRotationCursor("paced");
      releaseOwner(); removeTreeWithRetry(home);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    }
  });
}
