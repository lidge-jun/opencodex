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
