import { expect, test } from "bun:test";
import { storageWorkerOsJoinSettleMs } from "../src/storage/worker-lifecycle";

test("storage worker OS-join settle covers every Bun 1.3.14 isolate platform", () => {
  expect(storageWorkerOsJoinSettleMs("win32")).toBe(1_500);
  expect(storageWorkerOsJoinSettleMs("darwin")).toBe(250);
  expect(storageWorkerOsJoinSettleMs("linux")).toBe(250);
  expect(storageWorkerOsJoinSettleMs("freebsd")).toBe(0);
});
