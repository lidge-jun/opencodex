import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { GO_SIDECAR_BIN_ENV, resetGoSidecarForTests } from "../src/server/go-sidecar";
import { GO_WS_BRIDGE_ENV } from "../src/server/go-sidecar-ws-bridge";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const go = Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
const binary = go ? (() => { const path = join(mkdtempSync(join(tmpdir(), "ocx-ws-go-")), "ocx-sidecar"); const built = Bun.spawnSync(["go", "build", "-o", path, "./cmd/ocx-sidecar"], { cwd: join(root, "go"), env: { ...process.env, CGO_ENABLED: "0" }, stderr: "pipe" }); if (!built.success) throw new Error(new TextDecoder().decode(built.stderr)); return path; })() : null;

async function frames(server: { url: URL }): Promise<string[]> { const url = new URL("/v1/responses", server.url); url.protocol = "ws:"; return await new Promise((resolveFrames, reject) => { const ws = new WebSocket(url, { headers: { "x-opencodex-api-key": "secret" } } as unknown as string[]); const out: string[] = []; const timer = setTimeout(() => reject(new Error("WS parity timeout")), 10_000); ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "response.create", model: "fixture", input: "hello" })), { once: true }); ws.addEventListener("message", event => { out.push(String(event.data)); if (String(event.data).includes("response.completed") || String(event.data).includes("type\":\"error")) { clearTimeout(timer); ws.close(); resolveFrames(out); } }); ws.addEventListener("error", () => reject(new Error("WS parity socket error")), { once: true }); }); }

describe.skipIf(!go || !binary)("Go WebSocket bridge differential (ticket #28)", () => {
  const previous = { home: process.env.OPENCODEX_HOME, token: process.env.OPENCODEX_API_AUTH_TOKEN, bin: process.env[GO_SIDECAR_BIN_ENV], gate: process.env[GO_WS_BRIDGE_ENV] };
  afterEach(() => { resetGoSidecarForTests(); for (const [key, value] of Object.entries({ OPENCODEX_HOME: previous.home, OPENCODEX_API_AUTH_TOKEN: previous.token, [GO_SIDECAR_BIN_ENV]: previous.bin, [GO_WS_BRIDGE_ENV]: previous.gate })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  test("Go-produced SSE text frames equal the Bun oracle byte-for-byte", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("data: {\"type\":\"response.created\",\"sequence_number\":0}\n\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n", { headers: { "content-type": "text/event-stream" } }) });
    const home = mkdtempSync(join(tmpdir(), "ocx-ws-parity-")); process.env.OPENCODEX_HOME = home; process.env.OPENCODEX_API_AUTH_TOKEN = "secret";
    saveConfig({ port: 0, hostname: "127.0.0.1", websockets: true, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", allowPrivateNetwork: true, apiKey: "x", models: ["fixture"] } } } as never);
    const oracle = startServer(0); const expected = await frames(oracle); await oracle.stop(true);
    process.env[GO_SIDECAR_BIN_ENV] = binary!; process.env[GO_WS_BRIDGE_ENV] = "1";
    const sidecar = startServer(0); const actual = await frames(sidecar); await sidecar.stop(true); upstream.stop(true);
    expect(actual).toEqual(expected);
  });

  test("Go bridge forwards the first upstream event before its terminal arrives", async () => {
    let releaseTerminal!: () => void;
    const terminalReleased = new Promise<void>(resolve => { releaseTerminal = resolve; });
    const encoder = new TextEncoder();
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("data: {\"type\":\"response.created\"}\n\n"));
          await terminalReleased;
          controller.enqueue(encoder.encode("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    });
    const home = mkdtempSync(join(tmpdir(), "ocx-ws-live-"));
    process.env.OPENCODEX_HOME = home;
    process.env.OPENCODEX_API_AUTH_TOKEN = "secret";
    process.env[GO_SIDECAR_BIN_ENV] = binary!;
    process.env[GO_WS_BRIDGE_ENV] = "1";
    saveConfig({ port: 0, hostname: "127.0.0.1", websockets: true, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", allowPrivateNetwork: true, apiKey: "x", models: ["fixture"] } } } as never);
    const server = startServer(0);
    const url = new URL("/v1/responses", server.url);
    url.protocol = "ws:";
    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { "x-opencodex-api-key": "secret" } } as unknown as string[]);
      const timer = setTimeout(() => reject(new Error("first Go bridge frame was withheld until terminal")), 3_000);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "response.create", model: "fixture", input: "hello" })), { once: true });
      ws.addEventListener("message", event => {
        const text = String(event.data);
        if (!text.includes("response.created")) return;
        clearTimeout(timer);
        ws.close();
        resolve(text);
      });
      ws.addEventListener("error", () => reject(new Error("live Go bridge socket error")), { once: true });
    });
    expect(first).toContain("response.created");
    releaseTerminal();
    await server.stop(true);
    upstream.stop(true);
  });
});
