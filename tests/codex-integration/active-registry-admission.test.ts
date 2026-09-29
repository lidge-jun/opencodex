import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ACTIVE_TURNS, abortAndReleaseAllTurns, activeRegistryMetrics, trackStreamLifetime, tryAdmitTurn, unregisterTurn } from "../../src/server/lifecycle";
import { workflowBudgetSnapshot } from "../../src/lib/workflow-budget";
import {
  MAX_TRACKED_CODEX_WEBSOCKETS,
  getTrackedCodexWebSocketCountForAccount,
  tryReserveCodexWebSocket,
} from "../../src/codex/websocket-registry";
import {
  MAX_ACTIVE_STORAGE_HOME_SLOTS,
  tryBeginStorageMutation,
} from "../../src/storage/storage-mutation-coordinator";
import {
  tryReserveStorageWorker,
  withStorageWorkerSpawnGate,
} from "../../src/storage/worker-lifecycle";
import {
  anthropicSessionAffinitySizeForTests,
  bindAnthropicSessionAffinity,
  clearAnthropicAccountPoolState,
} from "../../src/oauth/anthropic-routing";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { currentServerFixtureConfig, settleServerAuthFixture, startManagementServerFixture, type ManagementServerFixture } from "../helpers/server-auth-fixture";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

describe("active registry admission", () => {
  describe("real HTTP boundaries", () => {
    let root: string;
    let home: string;
    let codexHome: string;
    let previousHome: string | undefined;
    let previousCodexHome: string | undefined;
    let fixture: ManagementServerFixture | undefined;
    let upstream: ReturnType<typeof Bun.serve> | undefined;
    let settle: (() => void) | undefined;
    const phase = (name: string) => {
      if (process.env.CI) process.stderr.write(`[active-registry-http] phase=${name}\n`);
    };

    async function closeFixture() {
      phase("cleanup:start");
      settle?.();
      // Cancel and join the test body before restoring its homes. A Bun test timeout
      // does not itself cancel fetch or wait for the body's finally to release leases.
      await Promise.all([fixture?.close(), upstream?.stop(true)]);
      await settleServerAuthFixture(home, codexHome);
      fixture = undefined;
      upstream = undefined;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      removeTreeWithRetry(root);
      phase("cleanup:end");
    }

    beforeEach(async () => {
      phase("setup:start");
      previousHome = process.env.OPENCODEX_HOME;
      previousCodexHome = process.env.CODEX_HOME;
      root = mkdtempSync(join(tmpdir(), "ocx-active-registry-"));
      home = join(root, "ocx");
      codexHome = join(root, "codex");
      mkdirSync(codexHome);
      process.env.CODEX_HOME = codexHome;
      settle = undefined;
      try {
        upstream = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch() {
            let settled = false;
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("chunk"));
                settle = () => {
                  if (settled) return;
                  settled = true;
                  controller.close();
                };
              },
              cancel() { settled = true; },
            }), { headers: { "content-type": "application/octet-stream" } });
          },
        });
        phase("setup:upstream-bound");
        fixture = await startManagementServerFixture(home, currentServerFixtureConfig({
          port: 0, hostname: "127.0.0.1", websockets: true, defaultProvider: "fixture",
          providers: {
            fixture: { adapter: "openai-responses", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true, apiKey: "test-key" },
          },
        } as OcxConfig));
        phase("setup:proxy-bound");
      } catch (error) {
        await closeFixture();
        throw error;
      }
    }, SERVER_BUDGET_MS);

    afterEach(async () => {
      if (fixture || upstream) await closeFixture();
    }, SERVER_BUDGET_MS);

    test("active turn 257 returns structured server_busy before handler work", async () => {
      await fixture!.run(async () => {
        const leases = Array.from({ length: 256 }, () => tryAdmitTurn());
        try {
          expect(leases.every(Boolean)).toBe(true);
          const response = await fetch(new URL("/v1/responses", fixture!.server.url), {
            signal: fixture!.signal,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "not-json",
          });
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: { code: "server_busy" } });
        } finally {
          for (const lease of leases) lease?.release();
        }
      });
    });

    test("websocket 129 rejects at the real upgrade boundary without entering account registry", async () => {
      await fixture!.run(async () => {
        const leases = Array.from({ length: MAX_TRACKED_CODEX_WEBSOCKETS }, () => tryReserveCodexWebSocket());
        try {
          expect(leases.every(Boolean)).toBe(true);
          const response = await fetch(new URL("/v1/responses", fixture!.server.url), {
            signal: fixture!.signal,
            headers: { connection: "Upgrade", upgrade: "websocket" },
          });
          expect(response.status).toBe(503);
          expect(await response.json()).toMatchObject({ error: { code: "server_busy" } });
          expect(getTrackedCodexWebSocketCountForAccount("not-admitted")).toBe(0);
        } finally {
          for (const lease of leases) lease?.release();
        }
      });
    });

    test("non-SSE streamed response keeps its admitted turn until the body settles", async () => {
      await fixture!.run(async () => {
        const before = activeRegistryMetrics().activeTurns.active;
        try {
          const response = await fetch(new URL("/v1/responses", fixture!.server.url), {
            signal: fixture!.signal,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-codex-parent-thread-id": "stream-root",
              "thread-id": "stream-child",
            },
            body: JSON.stringify({ model: "fixture/model", input: "hello", stream: true }),
          });
          phase("request:headers");
          expect(response.status).toBe(200);
          expect(activeRegistryMetrics().activeTurns.active).toBe(before + 1);
          expect(workflowBudgetSnapshot("stream-root")?.active).toBe(1);
          settle!();
          expect(await response.text()).toBe("chunk");
          phase("request:body-settled");
          expect(activeRegistryMetrics().activeTurns.active).toBe(before);
          expect(workflowBudgetSnapshot("stream-root")?.active).toBe(0);
        } finally {
          settle?.();
        }
      });
    });

    test("fixture teardown cancels and joins an unfinished admitted response", async () => {
      const before = activeRegistryMetrics().activeTurns.active;
      let receivedHeaders!: () => void;
      const headers = new Promise<void>(resolve => { receivedHeaders = resolve; });
      const running = fixture!.run(async () => {
        const response = await fetch(new URL("/v1/responses", fixture!.server.url), {
          signal: fixture!.signal,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fixture/model", input: "hello", stream: true }),
        });
        expect(response.status).toBe(200);
        receivedHeaders();
        await response.text();
      });
      await Promise.race([headers, running.then(() => { throw new Error("response ended before headers"); })]);
      expect(activeRegistryMetrics().activeTurns.active).toBe(before + 1);
      await fixture!.close();
      await running;
      expect(activeRegistryMetrics().activeTurns.active).toBe(before);
    });
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

  test("a transferred turn retains attached admission until its stream settles", async () => {
    const lease = tryAdmitTurn()!;
    let attachedReleases = 0;
    lease.attach({ release() { attachedReleases += 1; } });
    const source = new ReadableStream<Uint8Array>({ pull() {} });
    const tracked = trackStreamLifetime(source, new AbortController(), undefined, lease);

    expect(lease.isTransferred()).toBe(true);
    expect(attachedReleases).toBe(0);
    await tracked.cancel();
    expect(attachedReleases).toBe(1);
    lease.release();
    expect(attachedReleases).toBe(1);
  });

  test("the 256-turn gate bounds concurrency, not sequential continuation count", () => {
    const before = activeRegistryMetrics().activeTurns.active;
    for (let index = 0; index <= MAX_ACTIVE_TURNS; index += 1) {
      const lease = tryAdmitTurn("one-logical-session");
      expect(lease).not.toBeNull();
      lease!.release();
    }
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
