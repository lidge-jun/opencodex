import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { clearStepCliSessions, poolFor } from "../../src/adapters/step-cli/registry";

// Separate process: an intentionally quarantined registry must outlive the test's attempted clear.
const home = process.env.OPENCODEX_HOME!;
const child = Object.assign(new EventEmitter(), {
  stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  exitCode: null, signalCode: null, kill: () => { throw new Error("injected cleanup failure"); },
});
const deps = { which: () => process.execPath, spawn: () => child as unknown as ChildProcess };
const handlers = { onEvent: () => {} };
const pool = poolFor(home, deps, handlers);
const ref = { handle: "retained-after-clear", sessionId: "" };
const session = await pool.open(ref);
await session.close().catch(() => {});
let clearRejected = false, replacementRejected = false;
try { await clearStepCliSessions(); } catch { clearRejected = true; }
const next = poolFor(home, deps, handlers);
try { await next.open(ref); } catch { replacementRejected = true; }
console.log(JSON.stringify({ clearRejected, samePool: next === pool, replacementRejected }));
// No native child was started. Ensure the baseline's accidentally admitted fake is closed too.
await next.closeAll().catch(() => {});
