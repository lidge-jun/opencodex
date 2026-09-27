/**
 * Regression for standalone-binary worker spawning.
 *
 * `bun build --compile` cannot resolve nested worker entrypoints from
 * /$bunfs (oven-sh/bun#29124), so standalone builds pre-bundle each worker
 * source and `spawnWorker` starts it from a Blob URL instead. Source
 * checkouts keep the original `new Worker(url)` fallback. These cases pin
 * both branches so a refactor cannot silently revert to bare
 * `new Worker(new URL(...))` call sites, which die with
 * `ModuleNotFound resolving "/$bunfs/root/<worker>.ts" (entry point)` in
 * compiled binaries.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WORKER_BUNDLES } from "../../src/generated/worker-bundles.gen";
import { spawnWorker } from "../../src/lib/worker-embed";

function nextMessage(worker: Worker, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker message timeout")), timeoutMs);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`worker error: ${String(event.message ?? event)}`));
    };
  });
}

afterEach(() => {
  for (const key of Object.keys(WORKER_BUNDLES)) delete WORKER_BUNDLES[key];
});

describe("spawnWorker", () => {
  test("spawns from the embedded bundle via Blob URL when one is registered", async () => {
    // The devUrl must be ignored when a bundle is registered; "missing:" is
    // not a loadable URL, so reaching the message proves the Blob path ran.
    WORKER_BUNDLES["test-echo"] = `postMessage("embedded-ok");`;
    const worker = spawnWorker("missing://no-such-url", "test-echo");
    try {
      await expect(nextMessage(worker)).resolves.toBe("embedded-ok");
    } finally {
      worker.terminate();
    }
  });

  test("falls back to the dev URL when no bundle is registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-worker-embed-"));
    try {
      writeFileSync(join(dir, "dev-worker.js"), `postMessage("dev-ok");`);
      const worker = spawnWorker(pathToFileURL(join(dir, "dev-worker.js")).href, "not-registered");
      try {
        await expect(nextMessage(worker)).resolves.toBe("dev-ok");
      } finally {
        worker.terminate();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
