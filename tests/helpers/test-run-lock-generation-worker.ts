import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
// Every stage goes to stderr, which the fixture prints with the exit code, so a
// timed-out barrier shows where this child was and which owner it saw.
const startedAt = Date.now();
const trace = (event: string, detail: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ lockWorker: { role, pid: process.pid, event, ms: Date.now() - startedAt, ...detail } }));

// Fixture-only seam: refuse renames of the canonical lock path for a window
// starting at the first attempt, like a Windows handle held inside the directory.
const refusalFile = join(root, `${role}.refuse-rename-ms`);
if (existsSync(refusalFile)) {
  const windowMs = Number(readFileSync(refusalFile, "utf8"));
  const original = fs.renameSync;
  let firstAt: number | undefined, refused = 0;
  spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (from === path && (firstAt ??= Date.now()) + windowMs > Date.now()) {
      refused++;
      trace("rename-refused", { refused });
      throw Object.assign(new Error("EPERM: fixture-refused rename of the lock directory"), { code: "EPERM" });
    }
    if (from === path && refused > 0 && !existsSync(join(root, `${role}.renamed-after-refusal`))) {
      put("renamed-after-refusal", { refused });
    }
    return original(from, to);
  });
}
const waitSync = (suffix: string) => {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(join(root, `${role}.${suffix}`))) { checkDeadline(); Atomics.wait(pause, 0, 0, 10); }
};
const wait = async (suffix: string) => {
  while (!existsSync(join(root, `${role}.${suffix}`))) { checkDeadline(); await Bun.sleep(10); }
};

if (role === "gate") {
  trace("gate-enter");
  const result = withTestRunLockGate(path, () => { put("blocked"); waitSync("resume"); });
  if (!result) throw new Error("Fixture gate unexpectedly busy.");
} else {
  let blocked = false;
  trace("acquire-start", { runId });
  const lock = await acquireTestRunLock({
    runId, lockPath: path, env: {}, pollMs: 10, maxWaitMs: 25_000,
    onWait(owner) {
      trace("waiting", { ownerRunId: owner?.runId ?? null });
      if (!existsSync(join(root, `${role}.waited`))) put("waited");
    },
    processStartBatch(pids) {
      if ((role === "A" || role === "member") && !blocked) {
        blocked = true;
        put("blocked");
        trace("blocked-in-gate");
        waitSync("resume");
        trace("resumed");
      }
      return new Map(pids.map(pid => [pid, "win32:1600000000001"]));
    },
  });
  trace("acquire-returned", { acquired: lock.acquired, ownerRunId: lock.owner?.runId ?? null });
  // Only "member" joins an existing run; any other role returning without a
  // generation of its own is a fixture failure, never a silent exit 0.
  if (lock.acquired !== (role !== "member")) {
    throw new Error(`Lock worker ${role} returned acquired=${lock.acquired} for owner run ${lock.owner?.runId ?? "none"}.`);
  }
  put("acquired", { acquired: lock.acquired, owner: lock.owner });
  await wait("release");
  lock.release();
  trace("released");
}
put("terminal", { pid: process.pid });
