import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireTestRunLock } from "../../scripts/test-run-lock";
import { withTestRunLockGate } from "../../scripts/test-run-lock-gate";

const [root, role, runId = role] = process.argv.slice(2) as [string, string, string?];
if (!root || !role || !existsSync(join(root, "private-fixture"))) throw new Error("Private fixture capability missing.");
const path = join(root, "suite.lock");
const put = (suffix: string, value: unknown = true) =>
  writeFileSync(join(root, `${role}.${suffix}`), JSON.stringify(value), { flag: "wx" });
const deadline = Date.now() + 30_000;
const checkDeadline = () => { if (Date.now() >= deadline) throw new Error("Private lock fixture deadline exceeded."); };
const waitSync = (suffix: string) => {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(root, `${role}.${suffix}`))) { checkDeadline(); Atomics.wait(pause, 0, 0, 10); }
};
const wait = async (suffix: string) => {
  while (!existsSync(join(root, `${role}.${suffix}`))) { checkDeadline(); await Bun.sleep(10); }
};

if (role === "gate") {
  const result = withTestRunLockGate(path, () => { put("blocked"); waitSync("resume"); });
  if (!result) throw new Error("Fixture gate unexpectedly busy.");
} else {
  let blocked = false;
  const lock = await acquireTestRunLock({
    runId, lockPath: path, env: {}, pollMs: 10, maxWaitMs: 25_000,
    onWait() { if (!existsSync(join(root, `${role}.waited`))) put("waited"); },
    processStartBatch(pids) {
      if ((role === "A" || role === "member") && !blocked) {
        blocked = true;
        put("blocked");
        waitSync("resume");
      }
      return new Map(pids.map(pid => [pid, "win32:1600000000001"]));
    },
  });
  put("acquired", { acquired: lock.acquired, owner: lock.owner });
  await wait("release");
  lock.release();
}
put("terminal", { pid: process.pid });
