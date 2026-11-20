import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { antigravityRefusal, runAntigravitySession } from "../../src/cli/antigravity";
import { reviewPermission } from "../../src/cli/antigravity-review";

const fakeAgy = String.raw`
const { createInterface } = require("node:readline");
const write = (packet) => console.log(JSON.stringify({ jsonrpc: "2.0", ...packet }));
const writeBatch = (...packets) => process.stdout.write(packets.map(packet =>
  JSON.stringify({ jsonrpc: "2.0", ...packet })).join("\n") + "\n");
const reply = (id, result) => write({ id, result });
const bad = (id) => write({ id, error: { code: -32602 } });
const sessionId = "fixture";
let model = "claude-opus-example";
let mode = "auto";
let promptId;
const work = process.argv.includes("work");
let permissionAnswers = 0;
const configOptions = () => [
  { id: "model", category: "model", type: "select", currentValue: model, options: [
    { value: "claude-opus-example" }, { value: "gpt-oss-example" }, { value: "gemini-example" },
  ] },
  { id: "mode", type: "select", currentValue: mode, options: [{ value: "plan" }, { value: "default" }] },
];
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params, result } = JSON.parse(line);
  if (method === "initialize") reply(id, { protocolVersion: 1 });
  else if (method === "session/new") {
    if (!Array.isArray(params.mcpServers) || params.mcpServers.length || params.cwd !== process.cwd()) return bad(id);
    reply(id, { sessionId, configOptions: configOptions() });
  } else if (method === "session/set_config_option") {
    if (process.argv.includes("pending-snapshot")) {
      write({ method: "session/update", params: { sessionId, update: {
        sessionUpdate: "config_option_update", configOptions: configOptions(),
      } } });
    }
    if (params.configId === "model" && process.argv.includes("pending-mode-drift")) {
      mode = "auto";
      write({ method: "session/update", params: { sessionId, update: {
        sessionUpdate: "config_option_update", configOptions: configOptions(),
      } } });
      mode = "default";
    }
    if (params.configId === "model" && params.value === "gemini-example") model = params.value;
    else if (params.configId === "mode" && params.value === (work ? "default" : "plan")) mode = params.value;
    else return bad(id);
    if (params.configId === "model" && process.argv.includes("setup-drift")) {
      writeBatch(
        { id, result: { configOptions: configOptions() } },
        { method: "session/update", params: { sessionId, update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ id: "model", type: "select", currentValue: "claude-opus-example" }],
        } } },
      );
    } else reply(id, { configOptions: configOptions() });
  } else if (method === "session/prompt") {
    process.stderr.write("PROMPT_SENT");
    if (model !== "gemini-example" || mode !== (work ? "default" : "plan") || params.prompt[0].text !== "hello") return bad(id);
    promptId = id;
    if (work) {
      const update = { sessionUpdate: "tool_call", toolCallId: "read", kind: "read", title: "Read proof.txt",
        status: "pending", rawInput: { path: "proof.txt" } };
      write({ method: "session/update", params: { sessionId, update } });
      const options = [{ kind: "allow_always", optionId: "always" }, { kind: "allow_once", optionId: "once" }, { kind: "reject_once", optionId: "deny" }];
      write({ id: "foreign", method: "session/request_permission", params: { sessionId: "other", toolCall: update, options } });
      write({ id: "read-decision", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "read" }, options } });
      return;
    }
    write({ id: "permission", method: "session/request_permission", params: { sessionId, options: [
      { kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" },
    ] } });
  } else if (id === "foreign") {
    if (result.outcome.optionId !== "deny") return bad(promptId);
  } else if (id === "read-decision") {
    if (++permissionAnswers !== 1) return bad(promptId);
    const choice = result.outcome.optionId;
    if (!["once", "deny"].includes(choice)) return bad(promptId);
    const fs = require("node:fs");
    let answer = "denied";
    if (choice === "once") {
      fs.appendFileSync("reads", "read\n");
      try { answer = fs.readFileSync("proof.txt", "utf8"); } catch { answer = "file missing"; }
    }
    write({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call_update", toolCallId: "read", status: choice === "once" && answer !== "file missing" ? "completed" : "failed" } } });
    write({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
    reply(promptId, { stopReason: "end_turn" });
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
  test("a remembered-only or ambiguous permission is never selectable, and cancellation wins over a late yes", async () => {
    const call = { title: "Read proof.txt", toolCallId: "read", locations: [{ path: "proof.txt" }] };
    const deny = { kind: "reject_once", optionId: "no" };
    const once = { kind: "allow_once", optionId: "yes" };
    for (const options of [
      [{ kind: "allow_always", optionId: "always" }, deny],
      [once, { kind: "allow_always", optionId: "yes" }, deny],
    ]) {
      const note: string[] = [];
      const answer = await reviewPermission({ toolCall: call, options },
        async () => { throw new Error("unexpected prompt"); }, new AbortController().signal, text => note.push(text));
      expect(answer).toBe("no");
      expect(note.join("")).toContain("permission declined");
    }
    const turn = new AbortController();
    const answer = await reviewPermission({ toolCall: call, options: [once, deny] }, async () => {
      turn.abort();
      return "yes";
    }, turn.signal, () => {});
    expect(answer).toBe("no");
  });

  test("refuses forwarded prompts, pipes, SSH, services and agent environments", () => {
    expect(antigravityRefusal(["--prompt", "hello"], true, {})).toContain("Usage:");
    expect(antigravityRefusal(["native", "hello"], true, {})).toContain("Usage:");
    expect(antigravityRefusal(["work", "hello"], true, {})).toContain("Usage:");
    for (const env of [{ CODEX_THREAD_ID: "agent" }, { CI: "1" }, { OCX_SERVICE: "1" }, { SSH_CONNECTION: "remote" }]) {
      expect(antigravityRefusal([], true, env)).toContain("local interactive");
      expect(antigravityRefusal(["native"], true, env)).toContain("local interactive");
      expect(antigravityRefusal(["work"], true, env)).toContain("local interactive");
    }
    expect(antigravityRefusal([], false, {})).toContain("local interactive");
    expect(antigravityRefusal(["native"], false, {})).toContain("local interactive");
    expect(antigravityRefusal(["work"], false, {})).toContain("local interactive");
    expect(antigravityRefusal([], true, {})).toBeUndefined();
    expect(antigravityRefusal(["native"], true, {})).toBeUndefined();
    expect(antigravityRefusal(["work"], true, {})).toBeUndefined();
  });

  test("distinguishes a marked local TTY from a pipe or SSH without printing environment values", () => {
    const message = antigravityRefusal(["work"], true, {
      TERM_PROGRAM: "Apple_Terminal", CODEX_THREAD_ID: "private-thread-fixture", OCX_SERVICE: "private-service-fixture",
    });
    expect(message).toContain("CODEX_THREAD_ID, OCX_SERVICE");
    expect(message).toContain("fresh terminal application");
    expect(message).not.toContain("private-");
    expect(antigravityRefusal(["work"], false, {})).toContain("stdin and stdout");
    expect(antigravityRefusal(["work"], true, { SSH_TTY: "/dev/pts/0" })).toContain("SSH session");
    expect(antigravityRefusal(["work"], true, { TERM_PROGRAM: "Apple_Terminal" })).toBeUndefined();
  });

  test.each([
    { decision: "y", fileExists: true, status: "completed" },
    { decision: "y", fileExists: false, status: "failed" },
    { decision: "", fileExists: true, status: "failed" },
  ])("work shows the result of a project file request ($decision, file exists: $fileExists)", async ({ decision, fileExists, status }) => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-acp-work-"));
    const proof = randomUUID();
    if (fileExists) writeFileSync(join(directory, "proof.txt"), proof);
    writeFileSync(join(directory, "reads"), "");
    const child = spawn(process.execPath, ["-e", fakeAgy, "--", "work"], { cwd: directory, windowsHide: true });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error("Mock ACP timed out")), 4_000);
    const prompts = ["", "hello", "/exit"];
    const decisions: string[] = [];
    const output: string[] = [];
    try {
      // Use the child's real cwd (macOS resolves /var to /private/var).
      await runAntigravitySession(child, realpathSync(directory), async text => {
        if (text.includes("Allow this action once?")) {
          decisions.push(text);
          return decision;
        }
        return prompts.shift() ?? "/exit";
      }, text => output.push(text), stop, "default");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toContain('"path": "proof.txt"');
      const log = output.join("");
      expect(log).toContain("[tool pending]");
      expect(log).toContain("[tool " + status + "]");
      expect(log).toContain(decision ? (fileExists ? proof : "file missing") : "denied");
      expect(log).toContain("tool calls reported: 1");
      expect(readFileSync(join(directory, "reads"), "utf8")).toBe(decision ? "read\n" : "");
    } finally {
      clearTimeout(timer);
      removeTreeWithRetry(directory);
    }
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

  test.each(["pending-snapshot", "pending-mode-drift"])("checks only acknowledged selections during setup (%s)", async scenario => {
    const child = spawn(process.execPath, ["-e", fakeAgy, "--", "work", scenario], { windowsHide: true });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error("Mock ACP timed out")), 4_000);
    const questions: string[] = [];
    try {
      const session = runAntigravitySession(child, process.cwd(), async prompt => {
        questions.push(prompt);
        return prompt === "You> " ? "/exit" : "";
      }, () => {}, stop, "default");
      if (scenario === "pending-mode-drift") {
        await expect(session).rejects.toThrow("Antigravity changed the session model or mode.");
        expect(questions).not.toContain("You> ");
      } else {
        await session;
        expect(questions).toContain("You> ");
      }
    } finally { clearTimeout(timer); }
  });

  test("rejects a setup-time model update before sending the first prompt", async () => {
    const child = spawn(process.execPath, ["-e", fakeAgy, "--", "setup-drift"], { windowsHide: true });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error("Mock ACP timed out")), 4_000);
    const errors: string[] = [];
    child.stderr.on("data", chunk => errors.push(String(chunk)));
    const answers = ["", "hello"];
    try {
      await expect(runAntigravitySession(child, process.cwd(),
        async () => answers.shift() ?? "/exit", () => {}, stop,
      )).rejects.toThrow("Antigravity changed the session model or mode.");
      expect(errors.join("")).toBe("");
    } finally {
      clearTimeout(timer);
    }
  });
});
