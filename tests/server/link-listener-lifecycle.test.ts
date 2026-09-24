import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import { emptyLinkStore, type LinkStore } from "../../src/link/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_ID = "link-key";
let tempHome = "";
const servers: Array<Server<unknown>> = [];

function store(listenerPort: number | null = null): LinkStore {
  return {
    version: 1,
    listenerPort,
    links: [{
      id: "lnk_0123456789abcdef",
      alias: "lifecycle-test",
      direction: "client-initiated",
      hostKeyFingerprint: "SHA256:abcdefghijklmnop",
      tunnelPort: 2222,
      apiKeyId: LINK_ID,
      createdAt: "2026-09-25T00:00:00.000Z",
    }],
  };
}

function context() {
  return { maxRequestBodySize: 1024 * 1024, dispatch: async () => new Response("link-handler") };
}

function wrappedServer(actual: Server<unknown>, stop: () => Promise<void>): Server<unknown> {
  const wrapper = Object.create(actual) as Server<unknown> & { port: number; stop: () => Promise<void> };
  Object.defineProperty(wrapper, "port", { value: actual.port, enumerable: true });
  wrapper.stop = stop;
  return wrapper;
}

function makeLifecycle(current: { value: LinkStore }, overrides: Parameters<typeof createLinkListenerLifecycle>[0] = {}) {
  return createLinkListenerLifecycle({
    storePath: join(tempHome, "links.json"),
    readStore: () => current.value,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(server => server.stop(true)));
  if (tempHome) removeTreeWithRetry(tempHome);
  tempHome = "";
});

describe("hub-link listener lifecycle", () => {
  test("degrades a bind collision while an independent public listener stays healthy", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-link-bind-"));
    const publicServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("public-ok") });
    servers.push(publicServer);
    const warnings: string[] = [];
    const lifecycle = makeLifecycle({ value: store(45678) }, {
      warn: message => warnings.push(message),
      serve: () => {
        const error = new Error("address already in use") as Error & { code: string };
        error.code = "EADDRINUSE";
        throw error;
      },
    });
    lifecycle.start(context());
    await lifecycle.ensureStarted();
    expect(warnings.join("\n")).toMatch(/bind failed/);
    expect(await (await fetch(publicServer.url)).text()).toBe("public-ok");
    expect(lifecycle.linkAdmissionKeyIds()).toEqual(new Set([LINK_ID]));
  });

  test("closes the real link socket when listenerPort persistence fails", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-link-write-"));
    const publicServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("public-ok") });
    servers.push(publicServer);
    let stopCalled: (() => void) | undefined;
    const stopped = new Promise<void>(resolve => { stopCalled = resolve; });
    let bound: Server<unknown> | undefined;
    const lifecycle = makeLifecycle({ value: store() }, {
      writeStore: () => { throw new Error("persist failed"); },
      serve: options => {
        const actual = Bun.serve(options);
        servers.push(actual);
        bound = wrappedServer(actual, async () => { stopCalled?.(); await actual.stop(true); });
        return bound;
      },
    });
    lifecycle.start(context());
    await lifecycle.ensureStarted();
    await stopped;
    expect(bound).toBeDefined();
    expect(lifecycle.ownsListener(bound!)).toBe(false);
    expect(await (await fetch(publicServer.url)).text()).toBe("public-ok");
  });

  test("shares the same in-flight ensureStarted promise", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-link-flight-"));
    const current = { value: store() };
    let bindCount = 0;
    const lifecycle = makeLifecycle(current, {
      writeStore: (_path, next) => { current.value = next; },
      serve: options => {
        bindCount += 1;
        const actual = Bun.serve(options);
        servers.push(actual);
        return actual;
      },
    });
    lifecycle.start(context());
    const first = lifecycle.ensureStarted();
    const second = lifecycle.ensureStarted();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(bindCount).toBe(1);
  });

  test("does not rebind until a close has completed", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-link-close-order-"));
    const current = { value: store() };
    let bindCount = 0;
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>(resolve => {
      const release = () => resolve();
      releaseStop = release;
    });
    const lifecycle = makeLifecycle(current, {
      writeStore: (_path, next) => { current.value = next; },
      serve: options => {
        bindCount += 1;
        const actual = Bun.serve(options);
        servers.push(actual);
        return wrappedServer(actual, async () => { await stopEntered; await actual.stop(true); });
      },
    });
    lifecycle.start(context());
    const close = lifecycle.close();
    const ensure = lifecycle.ensureStarted();
    expect(bindCount).toBe(1);
    releaseStop();
    await close;
    await ensure;
    expect(bindCount).toBe(2);
    await lifecycle.close();
  });

  test("connection is refused after closing the last-link listener", async () => {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-link-last-close-"));
    const current = { value: store() };
    const lifecycle = makeLifecycle(current, {
      writeStore: (_path, next) => { current.value = next; },
      serve: options => {
        const actual = Bun.serve(options);
        servers.push(actual);
        return actual;
      },
    });
    lifecycle.start(context());
    await lifecycle.ensureStarted();
    const listener = servers[0];
    const port = listener?.port;
    expect(port).toBeGreaterThan(0);
    current.value = emptyLinkStore();
    await lifecycle.close();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});
