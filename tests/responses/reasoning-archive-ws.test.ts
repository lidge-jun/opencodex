import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainCompactionResponseState, installCompactionRoutingAclFixture,
  removeCompactionFixture } from "../helpers/compaction-routing-fixtures";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";

// The WebSocket transport has its own catch for errors thrown before a response exists. A local
// archive refusal must reach the client with the same sanitized 503 body and stable code as HTTP
// (reasoning-archive-http.test.ts), never as a raw 502 proxy_error carrying the archive path.
installCompactionRoutingAclFixture();
const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let codex: IsolatedCodexHome;
let releaseSpendHome: () => void;
let proxy: ReturnType<typeof startServer> | undefined;
let socket: WebSocket | undefined;
let sends = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-archive-ws-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-archive-ws-codex-");
  releaseSpendHome = acquireOwnedSpendHome();
  sends = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, init);
    sends++;
    throw new Error("unexpected upstream send");
  }) as typeof fetch;
});

afterEach(async () => {
  try {
    socket?.close();
    await proxy?.stop(true);
    await drainCompactionResponseState();
  } finally {
    socket = undefined;
    proxy = undefined;
    globalThis.fetch = originalFetch;
    releaseSpendHome();
    codex.restore();
    await removeCompactionFixture(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  }
});

async function until(condition: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await Bun.sleep(2);
  }
}

describe("reasoning archive WebSocket refusal", () => {
  test.each(["quota", "busy", "io"] as const)("%s is a safe 503 frame with a stable code and sends nothing", async kind => {
    const dir = join(home, "reasoning-archive");
    mkdirSync(dir);
    writeFileSync(join(dir, "prior.md"), "preserved old archive");
    let lock: Database | undefined;
    if (kind === "quota") {
      for (let i = 1; i < 256; i++) writeFileSync(join(dir, `prior-${i}.md`), "");
    } else if (kind === "busy") {
      lock = new Database(`${dir}.lock`, { create: true });
      lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    } else {
      mkdirSync(join(dir, "foreign-directory"));
    }
    const before = readdirSync(dir).sort();
    const provider = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key",
      apiKey: "test-key", upstreamWebsocket: false };
    saveConfig({
      port: 0, hostname: "127.0.0.1", codexAutoStart: false, websockets: true, defaultProvider: "gw",
      providers: { gw: { ...provider }, backup: { ...provider } },
      reasoningRetention: { enabled: true, maxTokens: 1 },
      compactionRecovery: { enabled: true, model: "backup/other" },
    } as unknown as OcxConfig);
    try {
      proxy = startServer(0);
      const url = new URL("/v1/responses", proxy.url);
      url.protocol = "ws:";
      const frames: Record<string, any>[] = [];
      const raw: string[] = [];
      socket = new WebSocket(url);
      socket.addEventListener("message", event => { raw.push(String(event.data)); frames.push(JSON.parse(String(event.data))); });
      await until(() => socket!.readyState === WebSocket.OPEN, "socket handshake");
      socket.send(JSON.stringify({ type: "response.create", model: "gw/some-model", input: [
        { type: "message", role: "user", content: "continue" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "private retained reasoning" }],
          encrypted_content: "private-provider-signature" },
        { type: "compaction_trigger" },
      ] }));
      await until(() => frames.some(frame => frame.type === "error"), "error frame");
      const frame = frames.find(item => item.type === "error")!;
      const code = kind === "quota" ? "reasoning_archive_quota_exceeded"
        : kind === "busy" ? "reasoning_archive_busy" : "reasoning_archive_unavailable";
      expect(frame.status).toBe(503);
      expect(frame.error).toMatchObject({ type: "server_error", code });
      const text = raw.join("\n");
      for (const secret of [home, dir, "prior.md", "foreign-directory", "private retained reasoning", "private-provider-signature", "test-key"])
        expect(text).not.toContain(secret);
      expect(sends).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(readFileSync(join(dir, "prior.md"), "utf8")).toBe("preserved old archive");
    } finally { lock?.close(); }
  });
});
