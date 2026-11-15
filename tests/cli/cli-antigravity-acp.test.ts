import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { antigravityRefusal, runAntigravitySession } from "../../src/cli/antigravity";

const fakeAgy = String.raw`
const { createInterface } = require("node:readline");
const write = (packet) => console.log(JSON.stringify({ jsonrpc: "2.0", ...packet }));
const reply = (id, result) => write({ id, result });
const bad = (id) => write({ id, error: { code: -32602 } });
const sessionId = "fixture";
let model = "claude-opus-example";
let mode = "auto";
let promptId;
const configOptions = () => [
  { id: "model", category: "model", type: "select", currentValue: model, options: [
    { value: "claude-opus-example" }, { value: "gpt-oss-example" }, { value: "gemini-example" },
  ] },
  { id: "mode", type: "select", currentValue: mode, options: [{ value: "plan" }] },
];
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params, result } = JSON.parse(line);
  if (method === "initialize") reply(id, { protocolVersion: 1 });
  else if (method === "session/new") {
    if (!Array.isArray(params.mcpServers) || params.mcpServers.length) return bad(id);
    reply(id, { sessionId, configOptions: configOptions() });
  } else if (method === "session/set_config_option") {
    if (params.configId === "model" && params.value === "gemini-example") model = params.value;
    else if (params.configId === "mode" && params.value === "plan") mode = params.value;
    else return bad(id);
    reply(id, { configOptions: configOptions() });
  } else if (method === "session/prompt") {
    if (model !== "gemini-example" || mode !== "plan" || params.prompt[0].text !== "hello") return bad(id);
    promptId = id;
    write({ id: "permission", method: "session/request_permission", params: { sessionId, options: [
      { kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" },
    ] } });
} else if (id === "permission") {
    if (result.outcome.optionId !== "no") return bad(promptId);
    const update = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    write({ method: "session/update", params: { sessionId: "other", update: update("wrong session") } });
    write({ method: "session/update", params: { sessionId, update: update("\u001b[31mhello back\u001b[0m") } });
    if (process.argv.includes("model-drift")) {
      write({ method: "session/update", params: { sessionId, update: {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "model", type: "select", currentValue: "claude-opus-example" }],
      } } });
    }
    reply(promptId, { stopReason: "end_turn" });
  } else bad(id);
});
`;

describe("Antigravity ACP command", () => {
  test("refuses forwarded prompts, pipes, SSH, services and agent environments", () => {
    expect(antigravityRefusal(["--prompt", "hello"], true, {})).toContain("Usage:");
    expect(antigravityRefusal(["native", "hello"], true, {})).toContain("Usage:");
    for (const env of [{ CODEX_THREAD_ID: "agent" }, { CI: "1" }, { OCX_SERVICE: "1" }, { SSH_CONNECTION: "remote" }]) {
      expect(antigravityRefusal([], true, env)).toContain("local interactive");
      expect(antigravityRefusal(["native"], true, env)).toContain("local interactive");
    }
    expect(antigravityRefusal([], false, {})).toContain("local interactive");
    expect(antigravityRefusal(["native"], false, {})).toContain("local interactive");
    expect(antigravityRefusal([], true, {})).toBeUndefined();
    expect(antigravityRefusal(["native"], true, {})).toBeUndefined();
  });

  test("shifts a non-Gemini default to Gemini, enforces plan, and refuses permission requests", async () => {
    const child = spawn(process.execPath, ["-e", fakeAgy], { windowsHide: true });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error("Mock ACP timed out")), 4_000);
    const answers = ["", "/model gpt-oss-example", "hello", "/exit"];
    const output: string[] = [];
    try {
      await runAntigravitySession(child, process.cwd(),
        async () => answers.shift() ?? "/exit", text => output.push(text), stop);
    } finally {
      clearTimeout(timer);
    }
    expect(output.join("")).toContain("1. gemini-example");
    expect(output.join("")).toContain("hello back");
    expect(output.join("")).toContain("ocx antigravity native");
    expect(output.join("")).not.toMatch(/claude-opus-example|gpt-oss-example|wrong session|\u001b/);
    expect(answers).toEqual([]);
  });

  test("stops if the selected model changes even when the update omits category", async () => {
    const child = spawn(process.execPath, ["-e", fakeAgy, "--", "model-drift"], { windowsHide: true });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error("Mock ACP timed out")), 4_000);
    const answers = ["", "hello", "/exit"];
    try {
      await expect(runAntigravitySession(child, process.cwd(),
        async () => answers.shift() ?? "/exit", () => {}, stop,
      )).rejects.toThrow("Antigravity changed the session model or mode.");
      expect(answers).toEqual(["/exit"]);
    } finally {
      clearTimeout(timer);
    }
  });
});
