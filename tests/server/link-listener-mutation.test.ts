import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";
import type { LinkStore } from "../../src/link/store";

const link = { id: "lnk_0123456789abcdef", alias: "fixture-link", direction: "client-initiated" as const,
  hostKeyFingerprint: null, tunnelPort: 2222, apiKeyId: "fixture-key", createdAt: "2026-10-01T00:00:00Z" };
const lifecycles: ReturnType<typeof createLinkListenerLifecycle>[] = [];
afterEach(async () => { await Promise.all(lifecycles.splice(0).map(lifecycle => lifecycle.close())); });

test("listener persistence preserves a link appended during bind", async () => {
  let current: LinkStore = { version: 1, listenerPort: null, links: [link] };
  const lifecycle = createLinkListenerLifecycle({
    storePath: "fixture-links.json", readStore: () => current, writeStore: (_path, next) => { current = next; }, warn: () => {},
    serve: () => {
      current = { ...current, links: [...current.links, { ...link, id: "lnk_fedcba9876543210", alias: "concurrent-link" }] };
      return { port: 12345, stop: async () => {} } as unknown as Server<unknown>;
    },
  });
  lifecycles.push(lifecycle);
  lifecycle.start({ maxRequestBodySize: 1024, dispatch: async () => new Response("fixture") });
  await lifecycle.ensureStarted();
  expect(current.links.map(row => row.alias)).toEqual(["fixture-link", "concurrent-link"]);
  expect(current.listenerPort).toBe(12345);
  expect(lifecycle.status().state).toBe("listening");
});

for (const listenerPort of [null, 12345]) test(`listener abandons a ${listenerPort ?? "new"}-port bind when the last link disappears`, async () => {
  let current: LinkStore = { version: 1, listenerPort: null, links: [link] };
  current.listenerPort = listenerPort;
  let writes = 0;
  let closed = 0;
  const lifecycle = createLinkListenerLifecycle({
    storePath: "fixture-links.json", readStore: () => current, writeStore: (_path, next) => { writes++; current = next; }, warn: () => {},
    serve: () => {
      current = { ...current, links: [] };
      return { port: 12345, stop: async () => { closed++; } } as unknown as Server<unknown>;
    },
  });
  lifecycles.push(lifecycle);
  lifecycle.start({ maxRequestBodySize: 1024, dispatch: async () => new Response("fixture") });
  await lifecycle.ensureStarted();
  expect(lifecycle.status()).toEqual({ state: "off", port: null, reason: null });
  expect(current).toEqual({ version: 1, listenerPort, links: [] });
  expect(writes).toBe(0);
  expect(closed).toBe(1);
});
