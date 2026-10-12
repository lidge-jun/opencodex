import { afterEach, expect, spyOn, test } from "bun:test";
import { handleAgentCommand, AGENT_USAGE } from "../../src/cli/agent";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";

const spies: Array<ReturnType<typeof spyOn<typeof console, "log">>> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function runtime() {
  const log = spyOn(console, "log").mockImplementation(() => {});
  spies.push(log, spyOn(console, "error").mockImplementation(() => {}));
  const calls: Array<{ path: string; body?: unknown }> = [];
  const deps: RuntimeApiDeps = { baseUrl: "http://localhost", fetchImpl: (async (input, init) => {
    calls.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ force: "combo/tev-auto" });
  }) as typeof fetch };
  return { calls, deps, log };
}

test("force CLI sets and clears through the management API", async () => {
  const r = runtime();
  expect(await handleAgentCommand(["subagents", "force", "combo/tev-auto"], r.deps)).toBe(0);
  expect(r.calls[0]?.body).toEqual({ force: "combo/tev-auto" });
  expect(await handleAgentCommand(["subagents", "force", "-", "--json"], r.deps)).toBe(0);
  expect(r.calls[1]?.body).toEqual({ force: null });
  expect(AGENT_USAGE).toContain("subagents force <model|->");
});

test("force CLI refuses bad arity without making requests", async () => {
  const r = runtime();
  for (const args of [[], ["one", "two"]]) expect(await handleAgentCommand(["subagents", "force", ...args], r.deps)).toBe(2);
  expect(r.calls).toHaveLength(0);
});

test("agent and subagent status report configured force", async () => {
  const r = runtime();
  expect(await handleAgentCommand(["status"], r.deps)).toBe(0);
  expect(r.log.mock.calls.flat().join("\n")).toContain("subagents.force: combo/tev-auto");
  expect(await handleAgentCommand(["subagents", "status"], r.deps)).toBe(0);
  expect(r.log.mock.calls.flat().join("\n")).toContain("force: combo/tev-auto");
});
