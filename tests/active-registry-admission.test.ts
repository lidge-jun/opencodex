import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortAndReleaseAllTurns, activeRegistryMetrics, trackStreamLifetime, tryAdmitTurn, unregisterTurn } from "../src/server/lifecycle";
import {
  MAX_TRACKED_CODEX_WEBSOCKETS,
  getTrackedCodexWebSocketCountForAccount,
  tryReserveCodexWebSocket,
} from "../src/codex/websocket-registry";
import {
  MAX_ACTIVE_STORAGE_HOME_SLOTS,
  tryBeginStorageMutation,
} from "../src/storage/storage-mutation-coordinator";
import {
  tryReserveStorageWorker,
  withStorageWorkerSpawnGate,
} from "../src/storage/worker-lifecycle";
import {
  anthropicSessionAffinitySizeForTests,
  bindAnthropicSessionAffinity,
  clearAnthropicAccountPoolState,
} from "../src/oauth/anthropic-routing";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

describe("active registry admission", () => {
  test("active turn 257 returns structured server_busy before handler work", async () => {
    const leases = Array.from({ length: 256 }, () => tryAdmitTurn());
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-active-turn-"));
    process.env.OPENCODEX_HOME = home;
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
      },
    } as OcxConfig);
    const server = startServer(0);
    try {
      expect(leases.every(Boolean)).toBe(true);
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "server_busy" } });
    } finally {
      for (const lease of leases) lease?.release();
      await server.stop(true);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("websocket 129 rejects at the real upgrade boundary without entering account registry", async () => {
    const leases = Array.from({ length: MAX_TRACKED_CODEX_WEBSOCKETS }, () => tryReserveCodexWebSocket());
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-websocket-cap-"));
    process.env.OPENCODEX_HOME = home;
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      websockets: true,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "forward" },
      },
    } as OcxConfig);
    const server = startServer(0);
    try {
      expect(leases.every(Boolean)).toBe(true);
      const response = await fetch(new URL("/v1/responses", server.url), {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "server_busy" } });
      expect(getTrackedCodexWebSocketCountForAccount("not-admitted")).toBe(0);
    } finally {
      for (const lease of leases) lease?.release();
      await server.stop(true);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("non-SSE streamed response keeps its admitted turn until the body settles", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-non-sse-turn-"));
    process.env.OPENCODEX_HOME = home;
    let settle!: () => void;
    let settled = false;
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk"));
            settle = () => {
              if (settled) return;
              settled = true;
              controller.close();
            };
          },
        }), { headers: { "content-type": "application/octet-stream" } });
      },
    });
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "fixture",
      providers: {
        fixture: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true, apiKey: "test-key" },
      },
    } as OcxConfig);
    const server = startServer(0);
    const before = activeRegistryMetrics().activeTurns.active;
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/model", input: "hello", stream: true }),
      });
      expect(response.status).toBe(200);
      expect(activeRegistryMetrics().activeTurns.active).toBe(before + 1);
      settle();
      expect(await response.text()).toBe("chunk");
      expect(activeRegistryMetrics().activeTurns.active).toBe(before);
    } finally {
      settle?.();
      await server.stop(true);
      upstream.stop(true);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("storage home slot 33 returns storage_mutation_busy without dropping active slots", () => {
    const homes = Array.from({ length: MAX_ACTIVE_STORAGE_HOME_SLOTS }, (_, index) => `/tmp/ocx-slot-${index}`);
    const leases = homes.map(home => tryBeginStorageMutation("cleanup", home));
    expect(leases.every(result => result.acquired)).toBe(true);
    expect(tryBeginStorageMutation("cleanup", "/tmp/ocx-slot-overflow")).toEqual({
      acquired: false,
      error: "storage_mutation_busy",
    });
    for (const result of leases) if (result.acquired) result.lease.release();
  });

  test("active registry peak rejected and release-miss metrics are monotonic", () => {
    const before = activeRegistryMetrics().activeTurns;
    const controller = new AbortController();
    unregisterTurn(controller);
    const after = activeRegistryMetrics().activeTurns;
    expect(after.peak).toBeGreaterThanOrEqual(before.peak);
    expect(after.rejected).toBeGreaterThanOrEqual(before.rejected);
    expect(after.releaseMisses).toBeGreaterThan(before.releaseMisses);
  });

  test("one HTTP or WS turn through nested stream wrappers consumes one lease only", async () => {
    const before = activeRegistryMetrics().activeTurns.active;
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    const first = new AbortController();
    const second = new AbortController();
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const nested = trackStreamLifetime(trackStreamLifetime(source, first, undefined, lease!), second, undefined, lease!);
    expect(activeRegistryMetrics().activeTurns.active).toBe(before + 1);
    await new Response(nested).arrayBuffer();
    expect(activeRegistryMetrics().activeTurns.active).toBe(before);
  });

  test("forced shutdown abort releases every lease and later finalizers cause no miss or underflow", () => {
    const before = activeRegistryMetrics().activeTurns;
    const controllers = [new AbortController(), new AbortController()];
    const leases = controllers.map(controller => {
      const lease = tryAdmitTurn()!;
      lease.bindAbortController(controller);
      return lease;
    });
    abortAndReleaseAllTurns();
    for (const lease of leases) lease.release();
    for (const controller of controllers) unregisterTurn(controller);
    const after = activeRegistryMetrics().activeTurns;
    expect(controllers.every(controller => controller.signal.aborted)).toBe(true);
    expect(after.active).toBe(before.active);
    expect(after.releaseMisses).toBe(before.releaseMisses);
  });

  test("storage worker reservation 17 rejects before enqueue and the first 16 spawn serially and drain", async () => {
    let releaseFirst!: () => void;
    const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    const reservations = Array.from({ length: 16 }, () => tryReserveStorageWorker());
    expect(reservations.every(Boolean)).toBe(true);
    expect(tryReserveStorageWorker()).toBeNull();
    let running = 0;
    let peak = 0;
    const accepted = reservations.map((reservation, index) => withStorageWorkerSpawnGate(async () => {
      running += 1;
      peak = Math.max(peak, running);
      if (index === 0) await blocked;
      running -= 1;
      reservation?.release();
      return index;
    }));
    releaseFirst();
    expect(await Promise.all(accepted)).toEqual(Array.from({ length: 16 }, (_, index) => index));
    expect(peak).toBe(1);
  });

  test("affinity rejects an oversized key component without colliding or changing routing", () => {
    clearAnthropicAccountPoolState();
    bindAnthropicSessionAffinity("valid-session", "account-a");
    bindAnthropicSessionAffinity(`${"x".repeat(512)}-different`, "account-b");
    expect(anthropicSessionAffinitySizeForTests()).toBe(1);
    clearAnthropicAccountPoolState();
  });
});
