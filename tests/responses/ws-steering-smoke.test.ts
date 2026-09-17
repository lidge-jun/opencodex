import { expect, test } from "bun:test";
import { SteeringProbe } from "../../scripts/steering-probe";
import { probeTargets, runSteeringProbe, steeringProbeSelfTest } from "../../scripts/steering-smoke";
import { nativeResponseControlMode, nativeSteeringUnavailableReason } from "../../src/server/responses/native-response-control";
import { createSteeringSettingsNormalizer } from "../../src/server/responses/native-steering-policy";
import { validSteeringSettings } from "../../src/server/responses/native-steering-settings";
import { injectionConfig } from "../helpers/native-injection-fixture";

const args = ["--direct", "wss://api.openai.com/v1/responses", "--proxy", "ws://127.0.0.1:1455/v1/responses", "--model", "fixture-model"];
const created = (id: string, parent?: string) => ({ type: "response.created", response: { id, ...(parent ? { previous_response_id: parent } : {}) } });
const accepted = { type: "response.steer.accepted", steer: { id: "s", previous_response_id: "r" } };
const ended = { type: "response.completed", response: { id: "r", output: [] } };
const pending = { type: "response.steer.pending", steer: accepted.steer, reason: "waiting_for_required_input", required_input: [{ type: "function_call_output", call_id: "c" }] };
const finish = { type: "response.completed", response: { id: "n", output: [{ content: [{ type: "output_text", text: "STEERING_PROBE_OK" }] }] } };
function fixture(mode: "automatic" | "required-input" = "automatic") {
  const sent: any[] = []; const probe = new SteeringProbe(mode, frame => sent.push(frame)); probe.request("fixture-model");
  const emit = (frame: unknown) => probe.receive(JSON.stringify(frame)); emit(created("r"));
  if (mode === "required-input") emit({ type: "response.output_item.done", item: { type: "function_call", name: "steering_probe", call_id: "c" } });
  return { probe, emit, sent };
}

test("offline positive control confirms acceptance, successor and marker separately", () => {
  expect(steeringProbeSelfTest()).toMatchObject({ outcome: "passed", accepted: true, successorCreated: true, markerObserved: true, sentControls: 1 });
});
test("acceptance without a created and completed successor never passes", () => {
  const f = fixture(); f.emit(accepted);
  expect(f.probe.report).toBeUndefined(); expect(f.probe.finish("unknown", "connection_closed").outcome).toBe("unknown");
  expect(f.sent).toHaveLength(1);
});
test("required-input probe sends full settings and saved synthetic result once", () => {
  const f = fixture("required-input"); f.emit(accepted); f.emit(ended); f.emit(pending);
  expect(f.sent).toHaveLength(2); expect(f.sent[1]).toMatchObject({ model: "fixture-model", store: false, tool_choice: "auto", reasoning: { effort: "medium" }, text: { verbosity: "low" } });
  expect(f.sent[1].input).toEqual([{ type: "function_call_output", call_id: "c", output: "synthetic saved result; no action was executed" }]);
  f.emit(created("n", "r")); f.emit(finish);
  expect(f.probe.report).toMatchObject({ outcome: "passed", explicitContinuation: true });
});
test("probe cannot invent approval or execute a foreign tool", () => {
  const f = fixture("required-input"); f.emit(accepted); f.emit(ended);
  f.emit({ ...pending, required_input: [{ type: "mcp_approval_response", approval_request_id: "approval" }] });
  expect(f.probe.report?.outcome).toBe("not_exercised"); expect(f.sent).toHaveLength(1);
});
test("diagnostic report never leaks provider errors, response IDs or bodies", () => {
  const f = fixture(); f.emit({ type: "error", error: { code: "private-secret-code", message: "secret-token-and-body" } });
  const report = JSON.stringify(f.probe.report);
  expect(report).not.toContain("private-secret"); expect(report).not.toContain("secret-token");
  expect(f.probe.report?.code).toBe("upstream_rejection");
});
test("wrong-response marker cannot turn a probe green", () => {
  const f = fixture(); f.emit(accepted); f.emit(ended); f.emit(created("n", "r"));
  f.emit({ type: "response.output_text.delta", response_id: "foreign", delta: "STEERING_PROBE_OK" });
  expect(f.probe.report?.outcome).toBe("failed");
});
test("missing and reused response identity cannot be mistaken for a successor", () => {
  const a = fixture(); a.emit({ type: "response.completed", response: {} }); expect(a.probe.report?.outcome).toBe("failed");
  const b = fixture(); b.emit(accepted); b.emit(ended); b.emit(created("r", "r")); expect(b.probe.report?.outcome).toBe("failed");
});
test("multiple pending notifications cannot produce duplicate continuations", () => {
  const f = fixture("required-input"); f.emit(accepted); f.emit(ended); f.emit(pending); f.emit(pending);
  expect(f.sent).toHaveLength(2); expect(f.probe.report?.code).toBe("duplicate_pending");
});
test("probe budgets cap data and prevent parsing arbitrary large output", () => {
  const f = fixture(); f.probe.receive("x".repeat(2 * 1024 * 1024));
  expect(f.probe.report?.code).toBe("probe_budget_exceeded"); expect(f.sent).toHaveLength(1);
});
test("plan-only mode does not read any token", () => {
  const env = new Proxy({}, { get() { throw new Error("credential lookup was attempted"); } });
  const plan = probeTargets(args, env); expect(plan.live).toBe(false); expect(plan.direct.headers.Authorization).toBeUndefined();
});
for (const partial of [["--live"], ["--allow-model-requests"]]) test(`live consent pair required (${partial[0]})`, () => {
  expect(() => probeTargets([...args, ...partial], {})).toThrow("both");
});
for (const url of ["wss://untrusted.example/v1/responses", "https://127.0.0.1/responses", "ws://user:secret@localhost/responses", "ws://localhost/responses?key=secret", "ws://localhost/private", "ws://localhost/responses#secret"]) {
  test(`nonlocal or credential-bearing proxy refused ${url.split(":")[0]} ${url.length}`, () => {
    expect(() => probeTargets(["--direct", args[1], "--proxy", url, "--model", "fixture"], {})).toThrow();
  });
}
test("direct API and proxy use independent explicitly supplied headers", () => {
  const plan = probeTargets([...args, "--live", "--allow-model-requests"], { STEERING_DIRECT_TOKEN: "fixture-direct", STEERING_PROXY_TOKEN: "fixture-proxy", STEERING_DIRECT_ACCOUNT_ID: "must-not-go-to-api" });
  expect(plan.direct.headers.Authorization).toBe("Bearer fixture-direct"); expect(plan.proxy.headers.Authorization).toBe("Bearer fixture-proxy");
  expect(plan.direct.headers["chatgpt-account-id"]).toBeUndefined(); expect(plan.proxy.headers["chatgpt-account-id"]).toBeUndefined();
});
test("executable self-test and plan mode succeed without credentials or sockets", async () => {
  for (const parameters of [["--self-test"], args]) {
    const child = Bun.spawn([process.execPath, "scripts/steering-smoke.ts", ...parameters], { stdout: "pipe", stderr: "pipe", env: { ...process.env, STEERING_DIRECT_TOKEN: "", STEERING_PROXY_TOKEN: "" } });
    const output = await new Response(child.stdout).text(); const err = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0); expect(err).toBe(""); expect(JSON.parse(output).mode).toBe(parameters.length === 1 ? "offline-fixture" : "plan-only");
  }
});
for (const scenario of ["automatic", "required-input"] as const) test(`actual bounded WebSocket probe works on isolated loopback (${scenario})`, async () => {
  let roots = 0; let steers = 0; let continuations = 0; let authorization = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { authorization = req.headers.get("authorization") ?? ""; if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, raw) {
      const frame = JSON.parse(String(raw)); const emit = (event: unknown) => ws.send(JSON.stringify(event));
      if (frame.type === "response.steer") {
        steers++; emit(accepted); emit(ended);
        if (scenario === "required-input") emit(pending); else { emit(created("n", "r")); emit(finish); }
      } else if (!frame.previous_response_id) {
        roots++; emit(created("r"));
        if (scenario === "required-input") emit({ type: "response.output_item.done", item: { type: "function_call", name: "steering_probe", call_id: "c" } });
      } else { continuations++; emit(created("n", "r")); emit(finish); }
    } },
  });
  try {
    const report = await runSteeringProbe({ url: `ws://127.0.0.1:${server.port}/responses`, model: "fixture", headers: { Authorization: "Bearer fixture-loopback" } }, scenario);
    expect(report.outcome).toBe("passed"); expect(roots).toBe(1); expect(steers).toBe(1); expect(continuations).toBe(scenario === "automatic" ? 0 : 1); expect(authorization).toBe("Bearer fixture-loopback");
  } finally { await server.stop(true); }
});
for (const [frame, text] of [[{}, "disabled"], [{ multi_agent: { enabled: true } }, "multi-agent"], [{ conversation: "fixture" }, "conversation"], [{ context_management: [{ type: "compaction" }] }, "compaction"]] as const) {
  test(`explicit unavailable reason (${text}) does not promise steering`, () => {
    expect(nativeSteeringUnavailableReason(frame, text !== "disabled")?.toLowerCase()).toContain(text);
    expect(nativeResponseControlMode(frame, { codexNativeSteering: text !== "disabled" })).toBeUndefined();
  });
}
test("nullable conversation and non-compaction context keep supported steering selectable", () => {
  expect(nativeResponseControlMode({ conversation: null, context_management: [] }, { codexNativeSteering: true })).toBe("steering");
});
test("no-effort-control policy strips only effort from mutable reasoning", () => {
  const cfg = injectionConfig(true); const provider = { ...cfg.providers.api, noReasoningModels: ["fixture"] };
  const normalize = createSteeringSettingsNormalizer({ modelId: "fixture", options: {}, context: {}, _rawBody: {} } as any, { providerName: "api", provider, modelId: "fixture" }, cfg, new Headers());
  expect(normalize({ reasoning: { effort: "high", summary: "detailed" } }).reasoning).toEqual({ summary: "detailed" });
});
test("structured schemas are bounded, preserve field names, and allow explicit summary none", () => {
  expect(validSteeringSettings({ reasoning: { summary: "none" }, text: { format: { type: "json_schema", name: "fixture", strict: true, schema: { type: "object", properties: { model: { type: "string" } } } } } })).toBe(true);
  let schema: any = {}; for (let i = 0; i < 70; i++) schema = { nested: schema };
  expect(validSteeringSettings({ text: { format: { type: "json_schema", name: "fixture", schema } } })).toBe(false);
});
