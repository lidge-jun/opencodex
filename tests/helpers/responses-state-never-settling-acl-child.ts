import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateMemoryForTests,
  awaitResponseSpillPublicationTailForTests,
  pendingResponseSpillMetricsForTests,
  rememberResponseState,
  responseStateMetrics,
  setResponseSpillAsyncAclAttemptBudgetForTests,
  setResponseStateByteCapForTests,
} from "../../src/responses/state";
import {
  setAsyncIcaclsBeltSchedulerForTests,
  setAsyncIcaclsRunnerForTests,
  setPlatformForTests,
} from "../../src/lib/windows-secret-acl";
import { setAsyncWindowsPrincipalRunnerForTests } from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "./remove-tree";

type Mode = "principal" | "icacls";

function rememberLarge(id: string): void {
  const text = id.repeat(1_000);
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    { id, output: [{ type: "message", role: "assistant", content: text }], status: "completed" },
    undefined,
    { force: true },
  );
}

const mode = process.argv[2];
if (mode !== "principal" && mode !== "icacls") {
  throw new Error(`Unknown never-settling ACL mode: ${mode ?? "<missing>"}`);
}

const home = mkdtempSync(join(tmpdir(), "ocx-never-settling-acl-child-"));
process.env.OPENCODEX_HOME = home;
clearResponseStateMemoryForTests();
setPlatformForTests("win32");
setResponseSpillAsyncAclAttemptBudgetForTests(100);
setResponseStateByteCapForTests(1_024);

if (mode === "principal") {
  setAsyncWindowsPrincipalRunnerForTests(() => new Promise(() => {}));
  setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
} else {
  setAsyncIcaclsRunnerForTests(() => new Promise(() => {}));
  // The product belt waits out SUBPROCESS_KILL_GRACE_MS plus its margin before releasing a caller
  // whose killed child has not reaped, so an in-process runner that never settles would spend
  // 2 x 2350 ms reaching the queue's unavoidable retry and tombstone -- longer than this fixture's
  // watchdog. There is no child here to reap, so fire the same belt on a short real timer: the
  // bounded attempt/retry/tombstone path stays under test, and the real belt duration stays
  // covered by tests/lib/stall-subprocess-exit.test.ts.
  setAsyncIcaclsBeltSchedulerForTests(callback => {
    const timer = setTimeout(callback, 50);
    return () => clearTimeout(timer);
  });
}

rememberLarge(`resp_never_settling_${mode}_first`);
rememberLarge(`resp_never_settling_${mode}_second`);
await awaitResponseSpillPublicationTailForTests();

console.log(JSON.stringify({
  settled: true,
  pending: pendingResponseSpillMetricsForTests(),
  metrics: responseStateMetrics(),
}));
removeTreeWithRetry(home);
