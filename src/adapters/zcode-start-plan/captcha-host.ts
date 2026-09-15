/**
 * Worker-thread host for the captcha solver.
 *
 * The vendored solver (captcha-solver.ts) runs the remote Aliyun SDK inside a happy-dom
 * window with JavaScript evaluation enabled, and under Bun those guest scripts execute
 * against the host realm of whatever thread loads the module. Running it on the server
 * thread would therefore expose the proxy process (its globals, its env, its credentials)
 * to mutable CDN bytes, alias browser-like globals (document/window) process-wide, install
 * a process-wide uncaughtException handler, and let the solver's synchronous-XHR
 * Atomics.wait stall the server event loop.
 *
 * This host confines ALL of that to a dedicated worker thread:
 *   - the guest SDK, window aliases, and exception handlers live in the worker's realm;
 *   - the worker crashing or hanging terminates only the pending solve, never the server;
 *   - solves are serialized host-side, which also makes the solver's internal singletons
 *     (browser frame, cookie container, sync-fetch worker) safe by construction.
 *
 * The worker is spawned lazily on the first solve and kept for the process lifetime.
 */
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface SolveRequest {
  id: number;
  scene: string;
  region: string;
  prefix: string;
  timeoutMs: number;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (p: string) => void; reject: (e: Error) => void }>();

function solverModuleUrl(): string {
  return pathToFileURL(join(import.meta.dir, "captcha-solver.ts")).href;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const entry = solverModuleUrl();
  const source = `
    const { parentPort } = require("node:worker_threads");
    let chain = Promise.resolve();
    parentPort.on("message", (m) => {
      chain = chain.then(async () => {
        try {
          const mod = await import(${JSON.stringify(entry)});
          const param = await mod.solveTraceless({ scene: m.scene, region: m.region, prefix: m.prefix, timeoutMs: m.timeoutMs });
          parentPort.postMessage({ id: m.id, ok: true, param });
        } catch (err) {
          parentPort.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
        }
      });
    });
  `;
  const w = new Worker(source, { eval: true });
  w.unref();
  w.on("message", (msg: { id: number; ok: boolean; param?: string; error?: string }) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok && typeof msg.param === "string") entry.resolve(msg.param);
    else entry.reject(new Error(msg.error ?? "captcha worker solve failed"));
  });
  w.on("error", (err: unknown) => {
    // A crashed worker fails every pending solve and is discarded; the next solve respawns.
    const message = err instanceof Error ? err.message : String(err);
    for (const [, entry] of pending) entry.reject(new Error(`captcha worker crashed: ${message}`));
    pending.clear();
    worker = null;
  });
  w.on("exit", (code) => {
    if (worker === w) worker = null;
    if (code !== 0) {
      for (const [, entry] of pending) entry.reject(new Error(`captcha worker exited with code ${code}`));
      pending.clear();
    }
  });
  worker = w;
  return w;
}

/**
 * Mint one captcha verify param in the solver worker. Host-enforced deadline: a hung
 * worker (guest stall beyond the solve timeout) fails the pending solve instead of
 * blocking the caller forever.
 */
export function solveTraceless(opts: {
  scene: string;
  region: string;
  prefix: string;
  timeoutMs: number;
}): Promise<string> {
  const w = ensureWorker();
  const id = nextId++;
  const request: SolveRequest = { id, ...opts };
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("captcha worker solve timed out"));
    }, opts.timeoutMs + 15_000);
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
    pending.set(id, {
      resolve: (param) => {
        clearTimeout(timer);
        resolve(param);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    w.postMessage(request);
  });
}
