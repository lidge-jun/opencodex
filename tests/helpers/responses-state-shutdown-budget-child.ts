import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  pendingResponseSpillMetricsForTests,
  rememberResponseState,
  responseStateMetrics,
  setResponseSpillShutdownBudgetForTests,
  setResponseSpillShutdownTerminalizationPassLimitForTests,
  setResponseStateByteCapForTests,
} from "../../src/responses/state";
import {
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../../src/lib/windows-secret-acl";

type Scenario = "exhaustion" | "guard";

function fixedResponse(id: string, output: unknown[]): { id: string; output: unknown[]; status: string } {
  return { id, output, status: "completed" };
}

function rememberLarge(id: string, text: string): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    fixedResponse(id, [{ type: "message", role: "assistant", content: text }]),
    undefined,
    { force: true },
  );
}

function errorMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  const nested = error instanceof AggregateError
    ? error.errors.flatMap(errorMessages)
    : [];
  return [error.message, ...nested];
}

async function runScenario(scenario: Scenario): Promise<Record<string, unknown>> {
  const home = mkdtempSync(join(tmpdir(), "ocx-shutdown-budget-child-"));
  const priorHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  clearResponseStateMemoryForTests();
  try {
    setPlatformForTests("win32");
    setResponseSpillShutdownBudgetForTests({ totalMs: 60, fallbackReserveMs: 40 });
    setResponseSpillShutdownTerminalizationPassLimitForTests(scenario === "guard" ? 0 : null);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let announced = false;
    setAsyncIcaclsRunnerForTests(async () => {
      if (!announced) {
        announced = true;
        entered();
        await gate;
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    setIcaclsRunnerForTests((_args, timeoutMs) => {
      Bun.sleepSync(timeoutMs + 50);
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_budget_exhausted_first", "a".repeat(2 * 1024 * 1024 + 4_096));
    await started;
    rememberLarge("resp_budget_exhausted_final", "b".repeat(2 * 1024 * 1024 + 4_096));
    setResponseStateByteCapForTests(1_000_000_000);
    rememberResponseState(
      { model: "test/model", input: "budget-safe-input", store: false },
      fixedResponse("resp_budget_unrelated", [{ type: "message", role: "assistant", content: "budget-safe-output" }]),
      undefined,
      { force: true },
    );

    let reported: unknown;
    try {
      const flushing = flushResponseState();
      setResponseStateByteCapForTests(scenario === "guard" ? 1 : 1_024);
      await flushing;
    } catch (error) {
      reported = error;
    } finally {
      release();
    }
    const pending = pendingResponseSpillMetricsForTests();
    const metrics = responseStateMetrics();
    const messages = errorMessages(reported);

    clearResponseStateMemoryForTests();
    setResponseStateByteCapForTests(1_024);
    const replay = JSON.stringify(expandPreviousResponseInput({
      previous_response_id: "resp_budget_unrelated",
      input: "next",
    }));
    return {
      settled: true,
      reported: reported instanceof Error,
      pending,
      metrics,
      replayedUnrelated: replay.includes("budget-safe-input") && replay.includes("budget-safe-output"),
      guardReported: messages.some(message => message.includes("terminalization pass limit")),
    };
  } finally {
    setAsyncIcaclsRunnerForTests(null);
    setIcaclsRunnerForTests(null);
    setPlatformForTests(null);
    resetHardenedStateForTests();
    setResponseSpillShutdownBudgetForTests(null);
    setResponseSpillShutdownTerminalizationPassLimitForTests(null);
    setResponseStateByteCapForTests(null);
    clearResponseStateForTests();
    rmSync(home, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
  }
}

const scenario = process.argv[2];
if (scenario !== "exhaustion" && scenario !== "guard") {
  throw new Error(`Unknown shutdown budget scenario: ${scenario ?? "<missing>"}`);
}

console.log(JSON.stringify(await runScenario(scenario)));
