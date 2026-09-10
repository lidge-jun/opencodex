import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAstraEffortState } from "../../src/adapters/astra-effort-state";
import { CONFIG_UNINSTALL_MANIFEST, removeOwnedConfigState } from "../../src/lib/config-ownership";
import { applyAstraEffortCache } from "../../src/adapters/astra-effort-cache";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import { prepareCodexWsRequest, CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { recordAdapterReasoning, applyResponseLogMetadata, type RequestLogContext } from "../../src/server/request-log";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

let directory: string;
let oldHome: string | undefined;
let oldFlag: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "astra-effort-"));
  oldHome = process.env["OPENCODEX_HOME"];
  oldFlag = process.env["OCX_ASTRA_EFFORT_CACHE"];
  process.env["OPENCODEX_HOME"] = directory;
  delete process.env["OCX_ASTRA_EFFORT_CACHE"];
});
afterEach(() => {
  if (oldHome === undefined) delete process.env["OPENCODEX_HOME"]; else process.env["OPENCODEX_HOME"] = oldHome;
  if (oldFlag === undefined) delete process.env["OCX_ASTRA_EFFORT_CACHE"]; else process.env["OCX_ASTRA_EFFORT_CACHE"] = oldFlag;
  rmSync(directory, { recursive: true, force: true });
});
const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] });
const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const first = [user("Synthetic first turn")];
const second = [...first, assistant("OK"), user("Synthetic second turn")];
const third = [...second, assistant("OK"), user("Synthetic third turn")];
function body(input: unknown[], effort = "medium", extra = {}) {
  return { model: "gpt-6-astra", instructions: "Synthetic instructions", input, reasoning: { effort }, store: false, stream: true, ...extra };
}
function run(input: unknown[], effort = "medium", thread = "thread-a", extra = {}, account = "test-account") {
  const raw = body(input, effort, extra);
  return applyAstraEffortCache(raw, raw, new Headers({ "thread-id": thread, "session-id": "shared-cache-key" }),
    new Headers({ "chatgpt-account-id": account }), join(directory, "state"));
}
function statePath() { return join(directory, "state", "state.sqlite"); }
function readState() {
  const db = new Database(statePath());
  try { return (db.query("SELECT state FROM sessions LIMIT 1").get() as { state: string }).state; } finally { db.close(); }
}
function writeState(state: string) {
  const db = new Database(statePath());
  try { db.query("UPDATE sessions SET state = ?").run(state); } finally { db.close(); }
}

describe("Astra effort history", () => {
  test("pins baseline, appends at the user boundary, and replays immutable updates", () => {
    expect(run(first).status).toBe("baseline_reset");
    const low = run(second, "low");
    expect(low.body).toEqual(body([...first, assistant("OK"), update("low"), user("Synthetic second turn")]));
    expect(low).toMatchObject({ baseline: "medium", effective: "low", status: "updated" });
    const replay = run(third, "low");
    expect((replay.body as any).input).toEqual([...(low.body as any).input, assistant("OK"), user("Synthetic third turn")]);
    expect(second).toHaveLength(3);
  });
  test("switches back using a second ordered update", () => {
    run(first); run(second, "low");
    expect((run(third, "medium").body as any).input).toEqual([...first, assistant("OK"), update("low"), user("Synthetic second turn"), assistant("OK"), update("medium"), user("Synthetic third turn")]);
  });
  test("same effort never adds an update", () => {
    run(first);
    expect(run(second).body).toEqual(body(second));
  });
  test("identical retries neither duplicate updates nor add state", () => {
    run(first); const low = run(second, "low");
    const before = readState();
    expect(run(second, "low")).toEqual(low.status === "updated" ? { ...low, status: "replay" } : low);
    expect(readState()).toBe(before);
  });
  test("restart/resume reads disk state without process memory", () => {
    run(first); run(second, "low");
    const loaded = JSON.parse(readState());
    expect(loaded.snapshots[1].updates).toEqual([{ position: 2, effort: "low" }]);
    expect((run(third, "high").body as any).reasoning.effort).toBe("medium");
  });
  test("missing history establishes a new baseline without guessing", () => {
    expect(run(second, "low")).toMatchObject({ body: body(second, "low"), status: "baseline_reset", baseline: "low" });
    expect((run(third, "high").body as any).reasoning.effort).toBe("low");
  });
  test("forks and accounts do not borrow a sibling baseline", () => {
    run(first); run(second, "low");
    expect(run(third, "high", "thread-b").status).toBe("baseline_reset");
    expect(run(third, "high", "thread-a", {}, "other-account").status).toBe("baseline_reset");
  });
  test("interleaved branches replay only their matching prefix", () => {
    run(first);
    run(second, "low");
    const sibling = [...first, assistant("Other answer"), user("Sibling")];
    const siblingLow = run(sibling, "high");
    expect((siblingLow.body as any).input).toEqual([...first, assistant("Other answer"), update("high"), user("Sibling")]);
    expect((run(third, "low").body as any).input.filter((i: any) => i.type === "configuration_update")).toEqual([update("low")]);
  });
  test("conflicting same-input retries use the requested effort and reset history", () => {
    run(first); run(second, "low");
    expect(run(second, "high")).toMatchObject({ body: body(second, "high"), status: "conflicting_retry" });
    expect(run(third, "high").status).toBe("baseline_reset");
  });
  test("effort changes during tool continuation fall back without retaining old effort", () => {
    run(first); run(second, "low");
    const continued = [...second, { type: "function_call", name: "test", call_id: "x", arguments: "{}" }, { type: "function_call_output", call_id: "x", output: "OK" }];
    expect(run(continued, "high")).toMatchObject({ body: body(continued, "high"), status: "missing_user_boundary" });
  });
  test("a newly observed historical user is not a current turn boundary", () => {
    run(first);
    const continued = [...second, assistant("Already answered"), { type: "function_call_output", call_id: "x", output: "OK" }];
    expect(run(continued, "high")).toMatchObject({ body: body(continued, "high"), status: "missing_user_boundary" });
  });
  test("an effort change belongs before the latest unseen user", () => {
    run(first);
    expect((run(third, "low").body as any).input).toEqual([...third.slice(0, -1), update("low"), third.at(-1)]);
  });
  test("changed prefix and changed tools reset the baseline", () => {
    run(first); run(second, "low");
    expect(run([user("Changed first"), ...third.slice(1)], "high").status).toBe("baseline_reset");
    expect(run(third, "high", "thread-a", { tools: [{ type: "function", name: "new_tool" }] }).status).toBe("baseline_reset");
  });
  test("state contains hashes and effort positions, never prompt or account data", () => {
    run(first); run(second, "low");
    const state = readState();
    for (const forbidden of ["Synthetic", "test-account", "thread-a", "shared-cache-key", "content", "authorization"]) expect(state).not.toContain(forbidden);
  });
  test("corrupt state fails transparently without overwriting it", () => {
    run(first); writeFileSync(statePath(), "invalid");
    expect(run(second, "low")).toMatchObject({ status: "unavailable_state", body: body(second, "low") });
    expect(readFileSync(statePath(), "utf8")).toBe("invalid");
  });
  test("invalid update positions fail state validation", () => {
    run(first); run(second, "low");
    const saved = JSON.parse(readState());
    saved.snapshots[1].updates[0].position = 99;
    writeState(JSON.stringify(saved));
    expect(run(third, "low").status).toBe("invalid_state");
  });
  test("stored updates must still point to user messages", () => {
    run(first); run(second, "low");
    const saved = JSON.parse(readState());
    saved.snapshots[1].updates[0].position = 1;
    writeState(JSON.stringify(saved));
    expect(run(third, "low")).toMatchObject({ status: "invalid_state", body: body(third, "low") });
  });
  test("a concurrent writer lock causes unchanged fallback", () => {
    run(first);
    const lock = new Database(statePath());
    lock.exec("BEGIN IMMEDIATE");
    try { expect(run(second, "low")).toMatchObject({ status: "unavailable_state", body: body(second, "low") }); }
    finally { lock.exec("ROLLBACK"); lock.close(); }
    expect(run(second, "low").status).toBe("updated");
  });
  test.each(["compaction", "context_compaction", "compaction_trigger"])("%s disables rewriting", type => {
    run(first); run(second, "low");
    const input = [...third, { type }];
    expect(run(input, "high")).toMatchObject({ status: "compaction", body: body(input, "high") });
  });
  test.each([
    [{ model: "gpt-5.6-luna" }, "unsupported_model"],
    [{ reasoning: { effort: "ultra" } }, "unsupported_effort"],
    [{ reasoning: { effort: "high", mode: "pro" } }, "unsupported_mode"],
    [{ truncation: "auto" }, "automatic_context_management"],
    [{ context_management: [{ type: "compaction", compact_threshold: 1000 }] }, "automatic_context_management"],
    [{ multi_agent: {} }, "multi_agent"],
  ])("unsupported settings retain the request: %j", (extra, status) => {
    expect(run(first, "medium", "thread-a", extra as Record<string, unknown>)).toMatchObject({ status, body: body(first, "medium", extra) });
  });
  test("explicit client updates pass through and report the last effective effort", () => {
    const input = [...first, update("low"), user("next")];
    expect(run(input)).toMatchObject({ body: body(input), status: "client_managed", baseline: "medium", effective: "low" });
  });
  test("parent and cache identity alone cannot identify a side chat", () => {
    const raw = body(first);
    expect(applyAstraEffortCache(raw, raw, new Headers({ "x-codex-parent-thread-id": "parent", "session-id": "shared" }), new Headers({ "chatgpt-account-id": "account" }), directory).status).toBe("missing_thread_identity");
  });
});

const provider = { adapter: "openai-responses" as const, authMode: "forward" as const, baseUrl: "https://chatgpt.com/backend-api/codex" };
function adapterRequest(input: unknown[], effort = "medium", extra = {}, destination = provider) {
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(destination));
  return adapter.buildRequest(parseRequest(body(input, effort, extra)), { headers: new Headers({ authorization: "Bearer synthetic", "chatgpt-account-id": "test-account", "thread-id": "thread-a" }) });
}
describe("Astra adapter integration", () => {
  test("default remains disabled and performs no state writes", () => {
    adapterRequest(first); const request = adapterRequest(second, "low");
    expect(JSON.parse(request.body).reasoning.effort).toBe("low");
    expect(readdirSync(directory)).toEqual([]);
  });
  test("parser, native adapter, websocket framing and logs preserve the update", () => {
    process.env["OCX_ASTRA_EFFORT_CACHE"] = "1";
    adapterRequest(first);
    const request = adapterRequest(second, "low");
    const output = JSON.parse(request.body);
    expect(output.reasoning.effort).toBe("medium");
    expect(output.input.filter((i: any) => i.type === "configuration_update")).toEqual([update("low")]);
    expect(parseRequest(output)._rawBody).toEqual(output);
    const ws = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, { headers: request.headers, body: request.body });
    expect(JSON.parse(ws!.frameText).input).toEqual(output.input);
    expect(request.reasoningLog).toEqual({ effectiveEffort: "low", wireField: "reasoning.effort", wireValue: "medium" });
    const log = { requestedEffort: "low" } as RequestLogContext;
    recordAdapterReasoning(log, request);
    applyResponseLogMetadata(log, { reasoning: { effort: "medium" } });
    expect(log).toMatchObject({ requestedEffort: "low", effectiveEffort: "low", reasoningWireValue: "medium" });
  });
  test("auto truncation is detected before native parameter stripping", () => {
    process.env["OCX_ASTRA_EFFORT_CACHE"] = "1";
    adapterRequest(first);
    const request = adapterRequest(second, "low", { truncation: "auto" });
    expect(JSON.parse(request.body).reasoning.effort).toBe("low");
    expect(JSON.parse(request.body).input.some((i: any) => i.type === "configuration_update")).toBe(false);
  });
  test("custom forward destinations never receive generated updates", () => {
    process.env["OCX_ASTRA_EFFORT_CACHE"] = "1";
    const destination = { ...provider, baseUrl: "https://gateway.example.test" };
    adapterRequest(first, "medium", {}, destination);
    expect(JSON.parse(adapterRequest(second, "low", {}, destination).body).reasoning.effort).toBe("low");
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("durable effort state lifecycle", () => {
  test("bounds task churn and registers one removable directory", () => {
    for (let i = 0; i < 150; i++) run(first, "medium", `task-${i}`);
    const db = new Database(statePath());
    try { expect((db.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count).toBe(128); }
    finally { db.close(); }
    const manifest = JSON.parse(readFileSync(join(directory, CONFIG_UNINSTALL_MANIFEST), "utf8"));
    expect(manifest.paths.filter((p: string) => p === "state" || p.startsWith("state/"))).toEqual(["state"]);
    expect(removeOwnedConfigState(directory).status).toBe("removed");
  });
  test("bounds total payload bytes and expires abandoned conversations", () => {
    const path = join(directory, "state");
    const payload = "x".repeat(1_500_000);
    for (let i = 0; i < 14; i++) withAstraEffortState(path, String(i), () => ({ value: true, state: payload }));
    const db = new Database(statePath());
    try {
      expect((db.query("SELECT SUM(length(state)) AS bytes FROM sessions").get() as { bytes: number }).bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      db.query("UPDATE sessions SET touched = 0").run();
    } finally { db.close(); }
    expect(statSync(statePath()).size).toBeLessThanOrEqual(32 * 1024 * 1024);
    withAstraEffortState(path, "fresh", () => ({ value: true, state: "fresh" }));
    const fresh = new Database(statePath());
    try { expect(fresh.query("SELECT scope FROM sessions").all()).toEqual([{ scope: "fresh" }]); }
    finally { fresh.close(); }
  });
  test("recovers after a different process dies while holding a transaction", async () => {
    run(first);
    const child = Bun.spawn([process.execPath, "-e", `import { Database } from "bun:sqlite";
      const db = new Database(process.argv[1]); db.exec("BEGIN IMMEDIATE; UPDATE sessions SET state = 'uncommitted'");
      console.log("held"); await new Promise(() => {});`, statePath()], { stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read(); reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("held");
      expect(run(second, "low").status).toBe("unavailable_state");
    } finally { child.kill("SIGKILL"); await child.exited; }
    expect(run(second, "low")).toMatchObject({ status: "updated", baseline: "medium", effective: "low" });
  });
  test("creates owner-only database and directory on POSIX", () => {
    run(first);
    if (process.platform !== "win32") {
      expect(statSync(statePath()).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, "state")).mode & 0o777).toBe(0o700);
    }
  });
});
