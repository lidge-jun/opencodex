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
  setAsyncIcaclsRunnerForTests,
  setPlatformForTests,
} from "../../src/lib/windows-secret-acl";
import { setAsyncWindowsPrincipalRunnerForTests } from "../../src/lib/windows-user-principal";
import { removeTreeAfterBackgroundWork } from "./remove-tree";

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

let release!: () => void;
let runnerCalls = 0;
const held = new Promise<{ success: boolean; exitCode: number; timedOut: boolean; stdout: string }>(resolve => {
  release = () => resolve({ success: false, exitCode: 1, timedOut: false, stdout: "" });
});
if (mode === "principal") {
  setAsyncWindowsPrincipalRunnerForTests(() => { runnerCalls++; return held; });
  setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
} else {
  // This case owns the stalled icacls boundary; identity startup must not consume its budget first.
  setAsyncWindowsPrincipalRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false,
    stdout: "S-1-5-21-111-222-333-1001\nFIXTURE\\user" }));
  setAsyncIcaclsRunnerForTests(() => { runnerCalls++; return held; });
}

try {
  rememberLarge(`resp_never_settling_${mode}_first`);
  rememberLarge(`resp_never_settling_${mode}_second`);
  await awaitResponseSpillPublicationTailForTests();
  if (runnerCalls === 0) throw new Error(`The ${mode} stall was not reached.`);
  console.log(JSON.stringify({
    settled: true,
    pending: pendingResponseSpillMetricsForTests(),
    metrics: responseStateMetrics(),
  }));
} finally {
  // Keep the runner unresolved until queue settlement is proved; then release owned work before removal.
  release();
  await removeTreeAfterBackgroundWork(home);
}
