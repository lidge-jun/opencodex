import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import * as clientState from "../../src/client/state";
import * as journal from "../../src/codex/journal";
import type { OcxClientConnectionConfig } from "../../src/types";

let state: clientState.ClientConnectionState;
let events: string[];
let savedExitCode: typeof process.exitCode;
let stateSpy: ReturnType<typeof spyOn>;
let journalSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  events = [];
  state = { kind: "disconnected" };
  stateSpy = spyOn(clientState, "readClientConnectionState").mockImplementation(() => state);
  // Reconciliation is observed, never allowed to restore a real client config.
  journalSpy = spyOn(journal, "reconcileJournal").mockImplementation(() => {
    events.push("journal");
    return undefined as never;
  });
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("ensure dispatch must not probe a remote hub");
  });
});

afterEach(() => {
  stateSpy.mockRestore(); journalSpy.mockRestore(); errorSpy.mockRestore(); fetchSpy.mockRestore();
  // Bun needs an explicit zero to reset the failure status injected by the local-ensure case.
  process.exitCode = savedExitCode ?? 0;
});

async function ensure(failLocal = false): Promise<number> {
  const args = ["ensure"];
  const deps = { args, handleEnsure: async () => {
    events.push("local-ensure");
    if (failLocal) process.exitCode = 1;
    return !failLocal;
  } } as CliDispatchDeps;
  return dispatchCommand({ kind: "command", command: "ensure", args }, deps);
}

test("connected ensure succeeds after reconciliation without starting a local proxy", async () => {
  state = { kind: "connected", value: { apiKeyId: "fixture-client" } as OcxClientConnectionConfig };
  expect(await ensure()).toBe(0);
  expect(events).toEqual(["journal"]);
  expect(journalSpy).toHaveBeenCalledWith({ activeClientApiKeyId: "fixture-client" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test.each(["invalid", "mismatched"] as const)("%s ensure still refuses local startup", async kind => {
  state = { kind, reason: "fixture state refusal" };
  expect(await ensure()).toBe(1);
  expect(events).toEqual(["journal"]);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("disconnected ensure retains the local startup path", async () => {
  expect(await ensure()).toBe(0);
  expect(events).toEqual(["local-ensure"]);
});

test("a failed disconnected local ensure still reports failure", async () => {
  expect(await ensure(true)).toBe(1);
  expect(events).toEqual(["local-ensure"]);
});

test("connected ensure cannot bypass a failed journal reconciliation", async () => {
  state = { kind: "connected", value: { apiKeyId: "fixture-client" } as OcxClientConnectionConfig };
  journalSpy.mockImplementation(() => { throw new Error("fixture journal refusal"); });
  await expect(ensure()).rejects.toThrow("fixture journal refusal");
  expect(events).toEqual([]);
});
