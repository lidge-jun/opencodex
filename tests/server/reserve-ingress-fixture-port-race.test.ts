import { afterEach, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:net";
import * as ports from "../../src/server/ports";
import { reserveIngressFixture } from "../helpers/reserve-ingress-fixture";

// The fixture probes its two ports before startServer binds them; on a shared runner another process
// can take a probed port in between (EADDRINUSE, dev batch 43369456647). These cases hand the fixture
// a port this test already holds, so the collision is deterministic.
const holders: Server[] = [];
afterEach(async () => {
  await Promise.all(holders.splice(0).map(holder => new Promise<void>(done => holder.close(() => done()))));
});

async function hold(host: string): Promise<number> {
  const holder = createServer();
  await new Promise<void>(done => holder.listen(0, host, done));
  holders.push(holder);
  return (holder.address() as { port: number }).port;
}

/** Answer the first `times` probes for `host` with a port that is already bound. */
function collideOn(host: string, port: number, times: number) {
  const real = ports.findAvailablePort;
  let handedOut = 0, probes = 0;
  const spy = spyOn(ports, "findAvailablePort").mockImplementation(async (preferred, probeHost, options) => {
    if (probeHost !== host) return real(preferred, probeHost, options);
    probes++;
    if (handedOut < times) { handedOut++; return port; }
    return real(preferred, probeHost, options);
  });
  return { spy, handedOut: () => handedOut, probes: () => probes };
}

test("a public port taken between probe and bind is probed again and the fixture starts", async () => {
  const collision = collideOn("0.0.0.0", await hold("0.0.0.0"), 1);
  try {
    const fixture = await reserveIngressFixture();
    await fixture.close();
    expect(collision.handedOut()).toBe(1);
    expect(collision.probes()).toBe(2);
  } finally { collision.spy.mockRestore(); }
}, 60_000);

test("a loopback-listener port taken between probe and bind is probed again after the public listener rolled back", async () => {
  const collision = collideOn("127.0.0.1", await hold("127.0.0.1"), 1);
  try {
    const fixture = await reserveIngressFixture();
    await fixture.close();
    expect(collision.handedOut()).toBe(1);
    expect(collision.probes()).toBe(2);
  } finally { collision.spy.mockRestore(); }
}, 60_000);

test("a collision on every attempt fails after three starts with the bind error", async () => {
  const collision = collideOn("0.0.0.0", await hold("0.0.0.0"), Number.POSITIVE_INFINITY);
  try {
    const error = await reserveIngressFixture().then(fixture => fixture.close().then(() => null), cause => cause);
    expect(ports.isAddrInUse(error)).toBe(true);
    expect(collision.probes()).toBe(3);
  } finally { collision.spy.mockRestore(); }
}, 60_000);
