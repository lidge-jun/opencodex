import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import * as serverModule from "../../src/server";
import * as ports from "../../src/server/ports";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { reserveIngressFixture } from "../helpers/reserve-ingress-fixture";

// The fixture probes its two ports before startServer binds them; on a shared runner another process
// can take a probed port in between (EADDRINUSE, dev batch 43369456647). These cases hand the fixture
// a port this test already holds, so the collision is deterministic, and control the failed start's
// rollback to show the fixture neither retries nor deletes its home before that rollback settles.
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

test("the next attempt waits until the failed start's rollback has settled", async () => {
  const collision = collideOn("127.0.0.1", await hold("127.0.0.1"), 1);
  const real = serverModule.waitForFailedStartRollback;
  let probesWhenSettled = -1;
  // A slow rollback: if the fixture probed again before it settled, the count here would be 2.
  const rollback = spyOn(serverModule, "waitForFailedStartRollback").mockImplementation(async error => {
    await real(error);
    await new Promise(resolve => setTimeout(resolve, 50));
    probesWhenSettled = collision.probes();
  });
  try {
    const fixture = await reserveIngressFixture();
    await fixture.close();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(probesWhenSettled).toBe(1);
    expect(collision.probes()).toBe(2);
  } finally { rollback.mockRestore(); collision.spy.mockRestore(); }
}, 60_000);

test("a rollback that does not settle reports both errors and keeps the home", async () => {
  const collision = collideOn("127.0.0.1", await hold("127.0.0.1"), 1);
  const real = serverModule.waitForFailedStartRollback;
  const stuck = new Error("rollback did not settle (test)");
  // The real rollback runs first, so the listeners are gone and this test may clean up after itself.
  const rollback = spyOn(serverModule, "waitForFailedStartRollback").mockImplementation(async error => {
    await real(error);
    throw stuck;
  });
  let home: string | undefined;
  try {
    const error = await reserveIngressFixture().then(fixture => fixture.close().then(() => null), cause => cause);
    expect(error).toBeInstanceOf(AggregateError);
    const [startError, rollbackError] = (error as AggregateError).errors;
    expect(startError).toBeInstanceOf(ports.AuxiliaryListenerBindError);
    expect(rollbackError).toBe(stuck);
    expect(collision.probes()).toBe(1);
    home = /home kept at (.+)$/.exec((error as Error).message)?.[1];
    expect(home !== undefined && existsSync(home)).toBe(true);
  } finally {
    rollback.mockRestore(); collision.spy.mockRestore();
    if (home) removeTreeWithRetry(home);
  }
}, 60_000);
