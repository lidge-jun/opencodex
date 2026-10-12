import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withObserveStream } from "../../src/cli/observe-stream";
import { handleLogFilterCommand } from "../../src/cli/log-view-filter";
import { handleCompanionUsageCommand } from "../../src/cli/companion-usage";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let prior: string | undefined;
let err: ReturnType<typeof spyOn<typeof console, "error">>;
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-observe-snapshot-"));
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "admin-api-token"), "synthetic-admin");
  err = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  err.mockRestore();
  if (prior === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prior;
  removeTreeWithRetry(home);
});

test("snapshot wrapper preserves callback partial result and signal precedence", async () => {
  expect(await withObserveStream({}, async () => 1, { kind: "snapshot" })).toBe(1);
  const signal = new AbortController();
  expect(await withObserveStream({ signal: signal.signal }, async () => {
    signal.abort();
    return 1;
  }, { kind: "snapshot" })).toBe(130);
  expect(err).not.toHaveBeenCalled();
});

for (const command of ["logs", "companion"] as const) {
  for (const target of ["stopped", "client"] as const) {
    test(`${command} snapshot explains ${target} recovery without transport`, async () => {
      let calls = 0;
      const deps = {
        findLiveProxy: async () => target === "stopped" ? null : { pid: 1, port: 12345, role: "client" as const, source: "runtime" as const },
        fetchImpl: (async () => { calls++; throw new Error("unexpected fetch"); }) as typeof fetch,
      };
      const exit = command === "logs" ? await handleLogFilterCommand([], deps, () => "") : await handleCompanionUsageCommand([], deps);
      expect(exit).toBe(1);
      expect(calls).toBe(0);
      expect(String(err.mock.calls)).toContain(target === "stopped" ? "ocx start" : "serving hub");
      expect(String(err.mock.calls)).not.toContain("timed out");
    });
  }
}

test("snapshot runtime drift refuses replacement data and uses snapshot recovery", async () => {
  let discoveries = 0, calls = 0;
  const code = await withObserveStream({
    findLiveProxy: async () => ({ pid: ++discoveries, port: 12345, hostname: "127.0.0.1", source: "runtime" }),
    fetchImpl: (async () => { calls++; return Response.json({}); }) as typeof fetch,
  }, async stream => {
    await stream.get("/api/companion/settings", new URLSearchParams());
    await stream.get("/api/usage", new URLSearchParams({ range: "today" }));
  }, { kind: "snapshot" });
  expect(code).toBe(1);
  expect(calls).toBe(1);
  expect(String(err.mock.calls)).toContain("Retry the command");
  expect(String(err.mock.calls)).not.toContain("follow");
});

for (const limitOption of [undefined, "--scan-limit"] as const) {
  test(`snapshot oversized recovery names only its supported option: ${limitOption}`, async () => {
    let cancelled = false;
    const code = await withObserveStream({ baseUrl: "http://fixture.test",
      fetchImpl: (async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
      }))) as typeof fetch,
    }, async stream => { await stream.get("/api/usage", new URLSearchParams()); }, { kind: "snapshot", limitOption });
    expect(code).toBe(1);
    expect(cancelled).toBe(true);
    const message = String(err.mock.calls);
    expect(message).not.toContain("follow");
    expect(message).not.toContain("--limit");
    expect(message.includes("--scan-limit")).toBe(limitOption !== undefined);
  });
}

test("fixed snapshot GET refuses a real redirect without contacting its destination", async () => {
  let hits = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return Response.json({}); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${destination.port}/private`) });
  try {
    expect(await withObserveStream({ baseUrl: `http://127.0.0.1:${source.port}` }, async stream => {
      await stream.get("/api/companion/settings", new URLSearchParams());
    }, { kind: "snapshot" })).toBe(1);
    expect(hits).toBe(0);
    expect(String(err.mock.calls)).toContain("retry the command");
  } finally {
    await source.stop(true);
    await destination.stop(true);
  }
});
