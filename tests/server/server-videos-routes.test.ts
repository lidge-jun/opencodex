/**
 * Public /v1/videos through the real server (#9110): dispatcher wiring ahead of the /v1/* 404 guard,
 * config schema acceptance of `videoApi`, the persisted handle key, the real outbound policy against
 * a local fake upstream, and one usage.jsonl row per call. No paid API, no real credential.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { VIDEO_HANDLE_KEY_FILE } from "../../src/server/video-handle";
import { setVideoCreateBodyTimeoutForTests } from "../../src/server/videos";
import * as lifecycle from "../../src/server/lifecycle";
import { admitWorkflowTurn } from "../../src/lib/workflow-budget";
import { inboundBodyBudget } from "../../src/server/inbound-body-budget";
import { MAX_CONFIGURABLE_INBOUND_BODY_BYTES } from "../../src/server/request-decompress";
import type { OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SERVER_BUDGET_MS);

const KEY = "synthetic-videos-route-key";
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 1, 2, 3]);
const previousHome = process.env.OPENCODEX_HOME;
const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let home = "";
let upstream: ReturnType<typeof Bun.serve> | undefined;
type Seen = { method: string; path: string; authorization: string | null; body?: unknown };
let seen: Seen[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-videos-server-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  seen = [];
  upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const entry: Seen = { method: req.method, path, authorization: req.headers.get("authorization") };
      if (req.method === "POST") entry.body = await req.json();
      seen.push(entry);
      if (req.method === "POST" && path === "/v1/videos") return Response.json({ id: "video_srv_1", object: "video", status: "queued" });
      if (path === "/v1/videos/video_srv_1") return Response.json({ id: "video_srv_1", object: "video", status: "completed", progress: 100 });
      if (path === "/v1/videos/video_srv_1/content") return new Response(MP4, { headers: { "content-type": "video/mp4" } });
      return new Response("nope", { status: 404 });
    },
  });
});

afterEach(async () => {
  await upstream?.stop(true);
  upstream = undefined;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  if (home) removeTreeWithRetry(home);
});

function localVideoConfig() {
  const config = getDefaultConfig();
  config.providers.aistudio = {
    adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream!.port}/v1`, apiKey: KEY, authMode: "key",
    allowPrivateNetwork: true, noProxy: "127.0.0.1", videoApi: "openai",
  } as OcxProviderConfig;
  return config;
}

test("create, poll and content flow through the proxy to the row's own upstream and are each logged", async () => {
  saveConfig(localVideoConfig());
  const server = startServer(0);
  try {
    const created = await fetch(new URL("/v1/videos", server.url), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "aistudio/gemini-omni-1.1-flash", prompt: "a heron", seconds: "4" }),
    });
    expect(created.status).toBe(200);
    const job = await created.json() as { id: string; status: string };
    expect(job.id.startsWith("video_ocx_")).toBe(true);
    expect(existsSync(join(home, VIDEO_HANDLE_KEY_FILE))).toBe(true);

    const polled = await fetch(new URL("/v1/videos/" + job.id, server.url));
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({ id: job.id, status: "completed" });

    const content = await fetch(new URL("/v1/videos/" + job.id + "/content", server.url));
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(MP4);

    // Unserved shapes still reach the JSON /v1/* guard.
    const list = await fetch(new URL("/v1/videos", server.url));
    expect(list.status).toBe(404);
    expect(list.headers.get("content-type")).toContain("application/json");

    expect(seen).toEqual([
      { method: "POST", path: "/v1/videos", authorization: "Bearer " + KEY, body: { model: "gemini-omni-1.1-flash", prompt: "a heron", seconds: "4" } },
      { method: "GET", path: "/v1/videos/video_srv_1", authorization: "Bearer " + KEY },
      { method: "GET", path: "/v1/videos/video_srv_1/content", authorization: "Bearer " + KEY },
    ]);
    const rows = readFileSync(join(home, "usage.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { provider?: string; model?: string; status?: number });
    const videoRows = rows.filter(row => row.provider === "aistudio");
    expect(videoRows.map(row => [row.model, row.status])).toEqual([
      ["gemini-omni-1.1-flash", 200], ["gemini-omni-1.1-flash", 200], ["gemini-omni-1.1-flash", 200],
    ]);
  } finally {
    await server.stop(true);
  }
});

test("authenticated job reads require an active turn and remain available after the creation workflow fills", async () => {
  const config = localVideoConfig();
  const rootId = "video-test-workflow";
  const apiKey = "ocx_data_" + "a".repeat(40);
  config.apiKeys = [{ id: "video-owner", name: "video", key: apiKey, createdAt: "2026-01-01T00:00:00.000Z" }];
  config.workflowBudget = { maxConcurrentChildren: 2 };
  saveConfig(config);
  const headers = { authorization: "Bearer " + apiKey, "x-codex-parent-thread-id": rootId };
  const server = startServer(0);
  const createJob = () => fetch(new URL("/v1/videos", server.url), {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: "aistudio/m", prompt: "a heron" }),
  });
  try {
    const created = await createJob();
    expect(created.status).toBe(200);
    const { id } = await created.json() as { id: string };
    const pollUrl = new URL("/v1/videos/" + id, server.url);
    const contentUrl = new URL(pollUrl.pathname + "/content", server.url);
    const baseline = lifecycle.getActiveTurnCount();
    const admit = lifecycle.tryAdmitTurn;
    // Exercise a full gate with one real lease, independently of the production capacity.
    const singleSlot = spyOn(lifecycle, "tryAdmitTurn").mockImplementation((...args) =>
      lifecycle.getActiveTurnCount() === baseline ? admit(...args) : null);
    const held = lifecycle.tryAdmitTurn();
    try {
      expect(held).not.toBeNull();
      for (const url of [pollUrl, contentUrl]) {
        const busy = await fetch(url, { headers });
        expect(busy.status).toBe(503);
        expect(busy.headers.get("retry-after")).toBe("1");
        expect(await busy.json()).toMatchObject({ error: { code: "server_busy" } });
      }
      expect(seen.map(row => row.method)).toEqual(["POST"]);
    } finally {
      held?.release();
      singleSlot.mockRestore();
    }

    const workflow = [admitWorkflowTurn(rootId, "interactive"), admitWorkflowTurn(rootId, "interactive")];
    try {
      expect(workflow.every(turn => turn?.admitted)).toBe(true);
      const denied = await createJob();
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ error: { code: "rate_limit_exceeded", message: expect.stringContaining("no free concurrency slot") } });
      const poll = await fetch(pollUrl, { headers });
      expect(poll.status).toBe(200);
      expect(await poll.json()).toMatchObject({ id, status: "completed" });
      const content = await fetch(contentUrl, { headers });
      expect(content.status).toBe(200);
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(MP4);
      expect(seen.map(row => row.method)).toEqual(["POST", "GET", "GET"]);
    } finally {
      for (const turn of workflow) if (turn?.admitted) turn.lease.release();
    }
  } finally {
    await server.stop(true);
  }
});

test("a trickling create upload through the real server is refused at the deadline and releases its turn and body slots", async () => {
  const config = localVideoConfig();
  // A raised body limit puts the create under the shared inbound body budget, so a reservation is taken.
  config.maxInboundBodyBytes = MAX_CONFIGURABLE_INBOUND_BODY_BYTES;
  saveConfig(config);
  setVideoCreateBodyTimeoutForTests(1500);
  const server = startServer(0);
  let tick: ReturnType<typeof setInterval> | undefined;
  try {
    const baseline = lifecycle.getActiveTurnCount();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"model":"aistudio/m","prompt":"'));
        tick = setInterval(() => { try { controller.enqueue(encoder.encode("p")); } catch { clearInterval(tick); } }, 20);
      },
      cancel() { clearInterval(tick); },
    });
    const pending = fetch(new URL("/v1/videos", server.url), {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit);
    // While the upload trickles, the create holds one turn slot and one body reservation.
    let held = false;
    for (let i = 0; i < 100 && !held; i++) {
      held = lifecycle.getActiveTurnCount() === baseline + 1 && inboundBodyBudget.snapshot().activeLeases === 1;
      if (!held) await Bun.sleep(10);
    }
    expect(held).toBe(true);
    expect(inboundBodyBudget.snapshot().reservedBytes).toBeGreaterThan(0);
    const response = await pending;
    expect(response.status).toBe(408);
    await response.text();
    clearInterval(tick);
    // Settlement is asynchronous after the response; wait for the slots to come back, bounded.
    for (let i = 0; i < 100 && (lifecycle.getActiveTurnCount() !== baseline || inboundBodyBudget.snapshot().activeLeases !== 0); i++) await Bun.sleep(10);
    expect(lifecycle.getActiveTurnCount()).toBe(baseline);
    expect(inboundBodyBudget.snapshot()).toMatchObject({ activeLeases: 0, reservedBytes: 0 });
    expect(seen).toEqual([]);
  } finally {
    clearInterval(tick);
    setVideoCreateBodyTimeoutForTests(undefined);
    await server.stop(true);
  }
});
