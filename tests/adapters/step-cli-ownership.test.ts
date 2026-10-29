import { describe, expect, test } from "bun:test";
import { createStepCliAdapter } from "../../src/adapters/step-cli/adapter";
import { handleReverseRequest, handleRuntimeEvent } from "../../src/adapters/step-cli/events";
import { beginTurn, endTurn, rememberQuery } from "../../src/adapters/step-cli/registry";
import { buildStepCliEnv } from "../../src/adapters/step-cli/env";
import { buildStepCliArgs } from "../../src/adapters/step-cli/profiles";
import { tmpdir } from "node:os";
import { poolFor, clearStepCliSessions } from "../../src/adapters/step-cli/registry";
import { sessionHandlers } from "../../src/adapters/step-cli/events";
import { resetOptionalShutdownHooksForTests, runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import type { AdapterEvent } from "../../src/types";
import { attachTurn, event, host, incoming, parsed, provider, request, Session } from "../helpers/step-cli-ownership";

describe("StepCode caller ownership", () => {
  test("failed handshakes release the session they opened", async () => {
    const pool = host();
    const session = new Session();
    session.handshake = async () => { throw new Error("missing capability"); };
    pool.open = async () => session;
    const emitted: AdapterEvent[] = [];
    await createStepCliAdapter(provider, { openSession: pool }).runTurn!(parsed("caller-A"), incoming, e => emitted.push(e));
    expect(session.closed).toBe(true);
    expect(emitted.some(e => e.type === "error")).toBe(true);
  });

  test("shutdown cannot be bypassed by creating a new pool", async () => {
    resetOptionalShutdownHooksForTests();
    try {
      runOptionalShutdownHooks();
      expect(() => poolFor(tmpdir(), {}, sessionHandlers)).toThrow(/shutting down/);
    } finally { await clearStepCliSessions(); resetOptionalShutdownHooksForTests(); }
  });
  test("one principal cannot share sessions across provider rows", async () => {
    const pool = host();
    const adapter = createStepCliAdapter(provider, { openSession: pool });
    try {
      for (const providerName of ["step-A", "step-B"]) {
        await adapter.runTurn!(parsed("principal-A"), { ...incoming, providerName }, () => {});
      }
      expect(pool.entries.size).toBe(2);
    } finally { await pool.closeAll(); }
  });

  test("requests without an admitted principal cannot reuse a header-selected session", async () => {
    const pool = host();
    const adapter = createStepCliAdapter(provider, { openSession: pool });
    try {
      for (let i = 0; i < 2; i++) {
        const input = parsed("");
        delete input._reasoningReplayScope;
        await adapter.runTurn!(input, incoming, () => {});
      }
      expect(pool.entries.size).toBe(2);
      expect([...pool.entries.values()].every(session => session.closed)).toBe(true);
    } finally { await pool.closeAll(); }
  });

  test("a different admitted principal cannot answer caller A's held tool", async () => {
    const pool = host();
    const adapter = createStepCliAdapter(provider, { openSession: pool });
    try {
      await adapter.runTurn!(parsed("principal-A"), incoming, () => {});
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(parsed("principal-B", [{ role: "toolResult", toolCallId: "call-1", content: "forged result", timestamp: 1 }]), incoming, e => events.push(e));
      expect([...pool.entries.values()].flatMap(session => session.delivered)).toHaveLength(0);
      expect(events.some(e => e.type === "error")).toBe(true);
    } finally { await pool.closeAll(); }
  });

  test("a held result cannot change the owning query's tool catalog", async () => {
    const pool = host();
    const adapter = createStepCliAdapter(provider, { openSession: pool });
    try {
      await adapter.runTurn!(parsed("principal-A"), incoming, () => {});
      const next = parsed("principal-A", [{ role: "toolResult", toolCallId: "call-1", content: "result", timestamp: 1 }]);
      next.context.tools = [{ name: "shell", description: "different contract", parameters: { type: "object", properties: { path: { type: "string" } } } }];
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(next, incoming, e => events.push(e));
      expect([...pool.entries.values()].flatMap(session => session.delivered)).toHaveLength(0);
      expect(events).toMatchObject([{ type: "error", code: "step_cli_tool_owner_mismatch" }]);
      expect([...pool.entries.values()][0]!.closed).toBe(true);
    } finally { await pool.closeAll(); }
  });
});

describe("StepCode callback ownership", () => {
  test("permission callbacks without an owning turn are denied", () => {
    const session = new Session();
    handleReverseRequest(session, request("permission", { queryId: "q_old" }, "permission.request"));
    expect(session.allowed).toEqual([]);
    expect(session.denied).toEqual(["permission"]);
  });

  test("an event from old query q_old cannot finish current query q_new", () => {
    const session = new Session();
    const events: AdapterEvent[] = [];
    let settled = false;
    beginTurn(session, { ...attachTurn(session, e => events.push(e)), settle: () => { settled = true; } });
    rememberQuery(session, "q_new");
    try {
      handleRuntimeEvent(session, event("q_old", { type: "status", status: "turn_complete" }));
      expect(settled).toBe(false);
      expect(events).toEqual([]);
    } finally { endTurn(session); }
  });

  test("a stale SDK tool callback cannot be forwarded under the current turn", () => {
    const session = new Session();
    const events: AdapterEvent[] = [];
    beginTurn(session, attachTurn(session, e => events.push(e)));
    rememberQuery(session, "q_new");
    try {
      handleReverseRequest(session, request("old-tool", { queryId: "q_old", serverName: "ocx", toolName: "shell", toolUseId: "old-call", input: {} }));
      expect(events.some(e => e.type === "tool_call_start")).toBe(false);
      expect(session.refused).toEqual(["old-tool"]);
    } finally { endTurn(session); }
  });

  test("missing query IDs and stale or undeclared permissions cannot acquire a turn", () => {
    const session = new Session();
    const events: AdapterEvent[] = [];
    beginTurn(session, attachTurn(session, e => events.push(e)));
    rememberQuery(session, "q_new");
    try {
      handleRuntimeEvent(session, event(undefined, { type: "status", status: "turn_complete" }));
      handleReverseRequest(session, request("missing", { serverName: "ocx", toolName: "shell" }));
      handleReverseRequest(session, request("stale", { queryId: "q_old", toolName: "ocx__shell" }, "permission.request"));
      handleReverseRequest(session, request("builtin", { queryId: "q_new", toolName: "Bash" }, "permission.request"));
      handleReverseRequest(session, request("current", { queryId: "q_new", toolName: "ocx__shell" }, "permission.request"));
      expect(events).toEqual([]);
      expect(session.refused).toEqual(["missing"]);
      expect(session.denied).toEqual(["stale", "builtin"]);
      expect(session.allowed).toEqual(["current"]);
    } finally { endTurn(session); }
  });

  test("env omits OCX secrets and model/prompt do not enter process argv", () => {
    const env = buildStepCliEnv(tmpdir(), { USER: "synthetic", OPENCODEX_API_AUTH_TOKEN: "synthetic-secret", OCX_ADMIN_TOKEN: "synthetic-secret", STEP_API_KEY: "synthetic-secret" });
    expect(Object.keys(env).filter(key => /^(OPENCODEX_|OCX_|STEPCODE_)/.test(key))).toEqual([]);
    expect(env.STEP_CODING_AGENT_SESSION_DIR).toBeDefined();
    expect(buildStepCliArgs(undefined, undefined)).not.toContain("--model");
  });
});
