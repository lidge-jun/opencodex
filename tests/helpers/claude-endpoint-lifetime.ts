import { afterEach, beforeEach, test as bunTest } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer as startRealServer } from "../../src/server";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { managementFetch } from "./management-auth";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./isolated-codex-home";
import { isolateClientLifecycleLock } from "./client-lifecycle-lock";
import { removeTreeWithRetry } from "./remove-tree";
import { INTERNAL_DEADLINE_MS, SERVER_BUDGET_MS } from "./test-budget";

/** Own actual handles and the test body, even when Bun times the body out. */
export function createEndpointCase(cleanup: () => Promise<void>, joinMs = INTERNAL_DEADLINE_MS) {
  const controller = new AbortController();
  const stops: Array<() => Promise<unknown>> = [];
  const releases: Array<() => void> = [];
  let body: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const assertActive = () => { if (controller.signal.aborted) throw new Error("endpoint case is closing"); };
  return {
    signal: controller.signal,
    assertClosed() { if (!closed) throw new Error("previous endpoint case teardown did not settle"); },
    run(fn: () => unknown): Promise<unknown> {
      assertActive();
      body = Promise.resolve().then(fn);
      void body.catch(() => {}); // Bun owns the body verdict; teardown still joins rejection.
      return body;
    },
    ownServer<T extends { stop(closeActiveConnections?: boolean): unknown }>(server: T): T {
      assertActive();
      const stop = server.stop.bind(server);
      let stopped: Promise<unknown> | undefined;
      const stopOnce = (force?: boolean) => stopped ??= Promise.resolve().then(() => stop(force));
      Object.defineProperty(server, "stop", { configurable: true, value: stopOnce });
      stops.push(() => stopOnce(true));
      return server;
    },
    ownCleanup(release: () => void): () => void {
      assertActive();
      let called = false, failed = false, failure: unknown;
      const once = () => {
        if (!called) { called = true; try { release(); } catch (error) { failed = true; failure = error; } }
        if (failed) throw failure;
      };
      releases.push(once);
      return once;
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        controller.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const drained = (async () => {
          const results = await Promise.allSettled(stops.map(stop => stop()));
          if (body) await body.catch(() => {});
          const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
          for (const release of releases) { try { release(); } catch (error) { errors.push(error); } }
          if (errors.length) throw new AggregateError(errors, "endpoint shutdown failed");
        })();
        try {
          await Promise.race([drained, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("endpoint case drain timed out")), joinMs);
          })]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
        await cleanup();
        closed = true;
      })();
    },
  };
}

export let testDir = "";
export let isolatedCodexHome: IsolatedCodexHome | null = null;
export const originalFetch = globalThis.fetch;
let currentCase: ReturnType<typeof createEndpointCase> | undefined;
const activeCase = () => {
  if (!currentCase || currentCase.signal.aborted) throw new Error("no active endpoint case");
  return currentCase;
};

export function installEndpointHooks(): void {
beforeEach(() => {
  currentCase?.assertClosed();
  const previousHome = process.env.OPENCODEX_HOME;
  const previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  const codexHome = installIsolatedCodexHome("ocx-claude-endpoint-");
  isolatedCodexHome = codexHome;
  const home = mkdtempSync(join(tmpdir(), "ocx-claude-endpoint-"));
  testDir = home;
  const lifecycleLock = isolateClientLifecycleLock(home);
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(home, "claude-desktop");
  globalThis.fetch = originalFetch;
  currentCase = createEndpointCase(async () => {
    await flushConfigDirHardeningAndReaps(home);
    lifecycleLock.restore();
    await flushConfigDirHardeningAndReaps(codexHome.path);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
    codexHome.restore();
    isolatedCodexHome = null;
    globalThis.fetch = originalFetch;
    removeTreeWithRetry(home);
  });
});
// Shutdown owns real listeners and their hardening children; body deadlines stay unchanged.
afterEach(() => currentCase?.close(), SERVER_BUDGET_MS);
}

export function test(name: string, fn: () => unknown, options?: number | { timeout?: number }): void {
  bunTest(name, () => activeCase().run(fn), options);
}
export const fetch: typeof managementFetch = (input, init) => {
  const owner = activeCase();
  const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return managementFetch(input, { ...init, signal: inherited
    ? AbortSignal.any([owner.signal, inherited]) : owner.signal });
};
export const startServer: typeof startRealServer = (...args) => activeCase().ownServer(startRealServer(...args));
export const serveUpstream = ((options: Parameters<typeof Bun.serve>[0]) => activeCase().ownServer(Bun.serve(options))) as typeof Bun.serve;
export const ownCleanup = (release: () => void) => activeCase().ownCleanup(release);
export const caseSignal = () => activeCase().signal;
