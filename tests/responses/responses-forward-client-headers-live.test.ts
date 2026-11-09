import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import * as proxyEnv from "../../src/lib/proxy-env";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { startServer } from "../../src/server";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const metadata = {
  "user-agent": "T3 Code/0.166.0 (Mac OS; arm64) unknown (T3 Code; fixture)",
  originator: "T3 Code",
  "x-codex-app-version": "fixture-version",
  "x-codex-window-id": "caller-window-fixture",
  "x-codex-installation-id": "caller-installation-fixture",
};
const callerHeaders = { ...metadata, authorization: "Bearer local-admission-fixture",
  cookie: "session=caller-cookie-fixture", "chatgpt-account-id": "caller-account-fixture",
  "x-api-key": "caller-key-fixture", "x-oai-attestation": "caller-attestation-fixture" };
let previousHome: string | undefined;
let home: string;
let codex: IsolatedCodexHome;
let proxy: ReturnType<typeof startServer> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let socket: WebSocket | undefined;
let configuredFetch: ReturnType<typeof spyOn> | undefined;
let received: Headers[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-client-metadata-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-client-metadata-codex-");
  received = [];
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/v1/responses");
    received.push(new Headers(req.headers));
    await req.text();
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
      id: "resp-metadata-fixture", object: "response", status: "completed", model: "m",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== upstream!.url.origin) throw new Error("Unexpected non-fixture transport");
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
  codex.restore();
  removeTreeWithRetry(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  socket = undefined; proxy = undefined; upstream = undefined;
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Client metadata fixture did not finish");
    await Bun.sleep(2);
  }
}

for (const authMode of ["key", "forward"] as const) {
  for (const transport of ["http", "websocket"] as const) {
    test(`${transport} retains metadata after auth materialization on custom ${authMode} routes`, async () => {
      const provider: OcxProviderConfig = { adapter: "openai-responses", authMode,
        baseUrl: new URL("/v1", upstream!.url).href, allowPrivateNetwork: true, liveModels: false, models: ["m"],
        ...(authMode === "key" ? { apiKey: "provider-key-fixture" } : {}),
      };
      const cases: Array<{ name: string; provider: OcxProviderConfig; expected: Record<string, string> }> = [
        { name: "enabled", provider: { ...provider, forwardClientHeaders: Object.keys(metadata) }, expected: metadata },
        { name: "disabled", provider, expected: { "user-agent": metadata["user-agent"] } },
        ...["x-codex-window-id", "x-codex-installation-id"].map((name, index) => ({
          name: `single-${index}`, provider: { ...provider, forwardClientHeaders: [name] },
          expected: { "user-agent": metadata["user-agent"], [name]: metadata[name as keyof typeof metadata] },
        })),
        { name: "configured", provider: { ...provider, forwardClientHeaders: Object.keys(metadata),
          headers: { "User-Agent": "provider-agent-fixture", "X-Codex-App-Version": "provider-version-fixture" } },
          expected: { ...metadata, "user-agent": "provider-agent-fixture", "x-codex-app-version": "provider-version-fixture" } },
      ];
      saveConfig({ port: 0, hostname: "127.0.0.1", codexAutoStart: false, websockets: true,
        clientIntegrations: { codex: false },
        apiKeys: [{ id: "metadata-fixture", name: "metadata fixture", key: "local-admission-fixture", createdAt: "2026-11-08T00:00:00.000Z" }],
        defaultProvider: "enabled", providers: Object.fromEntries(cases.map(row => [row.name, row.provider])),
      } as OcxConfig);
      proxy = startServer(0);
      const frames: Array<{ type: string; error?: unknown }> = [];
      if (transport === "websocket") {
        const url = new URL("/v1/responses", proxy.url); url.protocol = "ws:";
        socket = new WebSocket(url, { headers: callerHeaders });
        socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
        await until(() => socket!.readyState === WebSocket.OPEN);
      }
      for (const [index, row] of cases.entries()) {
        const body = { model: `${row.name}/m`, input: "Neutral metadata fixture", stream: true };
        if (transport === "websocket") {
          frames.length = 0;
          socket!.send(JSON.stringify({ type: "response.create", ...body }));
          await until(() => frames.some(frame => ["response.completed", "response.failed", "error"].includes(frame.type))
            && getActiveTurnCount() === 0);
          expect(frames.filter(frame => frame.type === "error" || frame.type === "response.failed")).toEqual([]);
          expect(frames.some(frame => frame.type === "response.completed")).toBe(true);
        } else {
          const response = await originalFetch(new URL("/v1/responses", proxy.url), { method: "POST", proxy: false,
            headers: { ...callerHeaders, "content-type": "application/json" }, body: JSON.stringify(body) });
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("response.completed");
        }
        expect(received).toHaveLength(index + 1);
        const headers = received[index]!;
        const observed = Object.fromEntries(Object.keys(metadata).filter(name => headers.has(name))
          .map(name => [name, headers.get(name)]));
        expect(observed).toEqual(row.expected);
        expect(headers.get("authorization")).toBe(authMode === "key" ? "Bearer provider-key-fixture" : null);
        for (const name of ["cookie", "chatgpt-account-id", "x-api-key", "x-oai-attestation", "x-openai-agent-assertion"]) {
          expect(headers.has(name)).toBe(false);
        }
      }
    });
  }
}
