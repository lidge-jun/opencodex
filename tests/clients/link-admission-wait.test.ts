import { expect, test } from "bun:test";
import { AdmissionWaitError, awaitFirstAdmission, type OnAuthenticatedCatalog } from "../../src/link/admission-wait";

function fakeClock() {
  let callback: (() => void) | undefined;
  let cleared = 0;
  return {
    clock: {
      setTimeout: (next: () => void) => { callback = next; return "timer"; },
      clearTimeout: () => { cleared += 1; },
    },
    fire() { callback?.(); },
    get cleared() { return cleared; },
  };
}

test("resolves on the first catalog admission for the requested key", async () => {
  let notify: ((keyId: string) => void) | undefined;
  let unsubscribed = 0;
  const subscribe: OnAuthenticatedCatalog = listener => {
    notify = listener;
    return () => { unsubscribed += 1; };
  };
  const clock = fakeClock();
  const wait = awaitFirstAdmission("key-a", 15_000, subscribe, clock.clock);
  notify!("key-b");
  let settled = false;
  void wait.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  notify!("key-a");
  await wait;
  expect(unsubscribed).toBe(1);
  expect(clock.cleared).toBe(1);
});

test("times out when no matching catalog admission arrives", async () => {
  const clock = fakeClock();
  const wait = awaitFirstAdmission("key-a", 15_000, () => () => {}, clock.clock);
  clock.fire();
  await expect(wait).rejects.toBeInstanceOf(AdmissionWaitError);
  expect(clock.cleared).toBe(1);
});

test("the subscription is limited to the catalog admission callback contract", async () => {
  let notify: ((keyId: string) => void) | undefined;
  const clock = fakeClock();
  const wait = awaitFirstAdmission("key-a", 15_000, listener => {
    notify = listener;
    return () => {};
  }, clock.clock);
  notify!("key-b");
  clock.fire();
  await expect(wait).rejects.toBeInstanceOf(AdmissionWaitError);
});
