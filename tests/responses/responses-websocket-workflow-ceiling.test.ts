import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { startServer } from "../../src/server";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import { resetWorkflowBudgetsForTest, workflowBudgetSnapshot } from "../../src/lib/workflow-budget";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import * as proxyEnv from "../../src/lib/proxy-env";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { chatStream } from "../helpers/combo-failover-upstream";
import { sendResponseToWebSocket, type WsData } from "../../src/server/ws-bridge";
import type { ServerWebSocket } from "bun";

const originalFetch = globalThis.fetch;
let previousHome: string | undefined;
let home: string;
let codex: IsolatedCodexHome;
let proxy: ReturnType<typeof startServer> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let socket: WebSocket | undefined;
let configuredFetch: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-ws-workflow-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-ws-workflow-codex-");
  resetWorkflowBudgetsForTest();
  configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!upstream || url.origin !== upstream.url.origin) throw new Error("Unexpected non-fixture transport");
    return originalFetch(input, { ...init, proxy: false });
  });
});

afterEach(async () => {
  socket?.close();
  await proxy?.stop(true);
  await upstream?.stop(true);
  await flushNativeMainStartupReleases();
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(home);
  await flushWindowsSecretAclReapsBeforeRemoval(codex.path);
  configuredFetch?.mockRestore();
  resetWorkflowBudgetsForTest();
  codex.restore();
  removeTreeWithRetry(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  socket = undefined; proxy = undefined; upstream = undefined;
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("WebSocket fixture did not finish");
    await Bun.sleep(2);
  }
}

for (const enforced of [false, true]) {
  describe(`WebSocket frame fixture (spend=${enforced})`, () => {
    let sends = 0;
    const root = "websocket-only-workflow";
    // Windows startup/ACL preparation has its own budget; the request test stays at 5s.
    beforeEach(() => {
      sends = 0;
      upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { sends++; return chatStream("synthetic answer"); } });
      saveConfig({
        port: 0, hostname: "127.0.0.1", codexAutoStart: false, websockets: true,
        clientIntegrations: { codex: false },
        defaultProvider: "fixture", workflowBudget: { maxPhysicalSends: 1 },
        ...(enforced ? { spend: { pool: { maxTokens: 100_000 } } } : {}),
        providers: { fixture: { adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
          apiKey: "synthetic-ws-key", allowPrivateNetwork: true, liveModels: false, models: ["m"] } },
      } as OcxConfig);
      proxy = startServer(0);
    }, 10_000);

    test(`WebSocket frames admit an unseen root and share its physical ceiling (spend=${enforced})`, async () => {
      const url = new URL("/v1/responses", proxy!.url); url.protocol = "ws:";
      const frames: Array<{ type: string; status?: number; headers?: Record<string, string>; error?: { message?: string } }> = [];
      socket = new WebSocket(url, { headers: { "x-codex-parent-thread-id": root, "thread-id": root } });
      socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
      await until(() => socket!.readyState === WebSocket.OPEN);
      expect(workflowBudgetSnapshot(root)).toBeUndefined();
      const request = JSON.stringify({ type: "response.create", model: "fixture/m", input: "synthetic workflow task", max_output_tokens: 1 });
      socket.send(request);
      await until(() => frames.some(frame => frame.type === "response.completed") && getActiveTurnCount() === 0);
      expect(sends).toBe(1);
      expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 1, active: 0 });
      frames.length = 0;
      socket.send(request);
      await until(() => frames.some(frame => frame.type === "error") && getActiveTurnCount() === 0);
      const refusal = frames.find(frame => frame.type === "error")!;
      expect(refusal.status).toBe(429);
      expect(refusal.headers?.["x-opencodex-local-refusal"]).toBe("workflow_sends_exhausted");
      expect(sends).toBe(1);
      expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 1, active: 0 });
    });
  });

  describe(`WebSocket retry fixture (spend=${enforced})`, () => {
    let sends = 0;
    const root = "websocket-retry-root";
    beforeEach(() => {
      sends = 0;
      upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        sends++;
        return Response.json({ error: { message: "synthetic temporary error" } }, { status: 503, headers: { "retry-after": "0" } });
      } });
      saveConfig({ port: 0, hostname: "127.0.0.1", codexAutoStart: false, websockets: true,
        clientIntegrations: { codex: false },
        defaultProvider: "fixture", workflowBudget: { maxPhysicalSends: 1 },
        ...(enforced ? { spend: { pool: { maxTokens: 100_000 } } } : {}),
        providers: { fixture: { adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href,
          apiKey: "synthetic-ws-key", allowPrivateNetwork: true, liveModels: false, models: ["m"],
          transientRetryOn5xx: { attempts: 2 } } },
      } as OcxConfig);
      proxy = startServer(0);
    }, 10_000);

    test(`WebSocket retry refusal retains its local header (spend=${enforced})`, async () => {
      const url = new URL("/v1/responses", proxy!.url); url.protocol = "ws:";
      const frames: Array<{ type: string; status?: number; headers?: Record<string, string> }> = [];
      socket = new WebSocket(url, { headers: { "x-codex-parent-thread-id": root, "thread-id": root } });
      socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
      await until(() => socket!.readyState === WebSocket.OPEN);
      socket.send(JSON.stringify({ type: "response.create", model: "fixture/m", input: "synthetic retry task", max_output_tokens: 1 }));
      await until(() => frames.some(frame => frame.type === "error") && getActiveTurnCount() === 0);
      const refusal = frames.find(frame => frame.type === "error")!;
      expect(refusal.status).toBe(429);
      expect(refusal.headers?.["x-opencodex-local-refusal"]).toBe("workflow_sends_exhausted");
      expect(sends).toBe(1);
      expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 1, active: 0 });
    });
  });
}

test("an upstream error header cannot claim a local WebSocket workflow refusal", async () => {
  const frames: Array<{ status: number; headers: Record<string, string> }> = [];
  const client = { readyState: 1, send(payload: string) { frames.push(JSON.parse(payload)); return 1; } } as unknown as ServerWebSocket<WsData>;
  const response = Response.json({ error: { type: "rate_limit_error", message: "synthetic upstream quota" } }, {
    status: 429, headers: { "x-opencodex-local-refusal": "workflow_sends_exhausted" },
  });
  await sendResponseToWebSocket(client, response, () => true);
  expect(frames[0]?.status).toBe(429);
  expect(frames[0]?.headers["x-opencodex-local-refusal"]).toBeUndefined();
});
