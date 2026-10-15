import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  clearResponseStateForTests,
  flushResponseState,
  rememberResponseState,
  responseStatePersistPendingForTests,
  runPendingResponseStatePersistForTests,
  setResponseStatePersistAttemptHookForTests,
} from "../../src/responses/state";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
beforeEach(() => {
  home = createTempHome("ocx-state-flush-race-");
  clearResponseStateForTests();
});
afterEach(async () => {
  setResponseStatePersistAttemptHookForTests(null);
  await flushResponseState();
  clearResponseStateForTests();
  home.remove();
});

function remember(id: string): void {
  rememberResponseState(
    { model: "test/model", input: id, store: false },
    { id, output: [{ type: "message", role: "assistant", content: id }], status: "completed" },
    undefined,
    { force: true },
  );
}

test("shutdown consumes a background writer's follow-up before returning", async () => {
  remember("resp_before_background");
  setResponseStatePersistAttemptHookForTests(() => {
    setResponseStatePersistAttemptHookForTests(null);
    remember("resp_during_background");
  });
  const background = runPendingResponseStatePersistForTests();
  await flushResponseState();
  await background;

  expect(responseStatePersistPendingForTests()).toBe(false);
  const snapshot = JSON.parse(readFileSync(home.path("responses-state.json"), "utf8"));
  expect(snapshot.states.map(([id]: [string, unknown]) => id)).toContain("resp_during_background");
});

test("a stable shutdown rewrite consumes the timer armed by its own mutation", async () => {
  remember("resp_before_flush");
  setResponseStatePersistAttemptHookForTests(() => {
    setResponseStatePersistAttemptHookForTests(null);
    remember("resp_during_flush");
  });
  await flushResponseState();

  expect(responseStatePersistPendingForTests()).toBe(false);
  const snapshot = JSON.parse(readFileSync(home.path("responses-state.json"), "utf8"));
  expect(snapshot.states.map(([id]: [string, unknown]) => id)).toContain("resp_during_flush");
});

test("concurrent shutdown flushes both settle behind the background timer decision", async () => {
  remember("resp_concurrent_seed");
  setResponseStatePersistAttemptHookForTests(() => {
    setResponseStatePersistAttemptHookForTests(null);
    remember("resp_concurrent_mutation");
  });
  const background = runPendingResponseStatePersistForTests();
  await Promise.all([flushResponseState(), flushResponseState()]);
  await background;

  expect(responseStatePersistPendingForTests()).toBe(false);
  const snapshot = JSON.parse(readFileSync(home.path("responses-state.json"), "utf8"));
  expect(snapshot.states.map(([id]: [string, unknown]) => id)).toContain("resp_concurrent_mutation");
});

test("a mutation after the stable revision check retains its own pending pass", async () => {
  remember("resp_before_stable_check");
  setResponseStatePersistAttemptHookForTests(() => {
    setResponseStatePersistAttemptHookForTests(null);
    queueMicrotask(() => remember("resp_after_stable_check"));
  });
  await runPendingResponseStatePersistForTests();

  expect(responseStatePersistPendingForTests()).toBe(true);
  await flushResponseState();
  const snapshot = JSON.parse(readFileSync(home.path("responses-state.json"), "utf8"));
  expect(snapshot.states.map(([id]: [string, unknown]) => id)).toContain("resp_after_stable_check");
  expect(responseStatePersistPendingForTests()).toBe(false);
});
