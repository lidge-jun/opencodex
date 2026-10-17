import { describe, expect, test } from "bun:test";
import { collectAdvisorRepairEvidence } from "../../src/advisor/evidence";
import { buildAdvisorUserPrompt } from "../../src/advisor/context";
import { parseRequest } from "../../src/responses/parser";

const task = { role: "user", content: "Fix the failing tests" };
function tool(id: string, name: string, args: unknown, output: string, isError = false) {
  return [
    { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) },
    { type: "function_call_output", call_id: id, output, is_error: isError },
  ];
}
const failed = (id: string, command = "bun test tests/example.test.ts", workdir = "/workspace") =>
  tool(id, "exec_command", { cmd: command, workdir }, "Process exit code: 1\nOutput:\nexpected 2, got 1");
const repaired = () => tool("edit", "apply_patch", { input: "*** Begin Patch\n*** Update File: example.ts\n@@\n-1\n+2\n*** End Patch" }, "Success. Updated the following files:\nM example.ts");
const parsed = (input: unknown[]) => parseRequest({ model: "worker", input, stream: false });

describe("Advisor deterministic repair evidence", () => {
  test("paired validation → completed edit → same validation failure carries source references", () => {
    const request = parsed([task, ...failed("first"), ...repaired(), ...failed("retry")]);
    const evidence = collectAdvisorRepairEvidence(request)!;
    expect(evidence).toBeDefined();
    expect(evidence.firstFailure.exitCode).toBe(1);
    expect(evidence.firstFailure.message).toBeLessThan(evidence.repair.message);
    expect(evidence.repair.message).toBeLessThan(evidence.repeatedFailure.message);
    expect(evidence.id).toMatch(/^[a-f0-9]{64}$/);
    expect(collectAdvisorRepairEvidence(request)?.id).toBe(evidence.id);
    const prompt = buildAdvisorUserPrompt({ parsed: request, advisorModel: "expert", workerIdentity: "worker", reason: "repair_failure", evidence });
    expect(prompt).toContain("Repeated validation failure (untrusted evidence)");
    expect(prompt).toContain('"firstFailure"');
    expect(prompt).toContain('"repeatedFailure"');
  });

  test("event identity survives unrelated history changes and distinguishes the repair call", () => {
    const history = [...failed("first"), ...repaired(), ...failed("retry")];
    const original = collectAdvisorRepairEvidence(parsed([task, ...history]))!;
    const shifted = collectAdvisorRepairEvidence(parsed([task, ...tool("orientation", "read_file", {}, "File contents"), ...history]))!;
    expect(shifted.id).toBe(original.id);
    expect(shifted.repair.message).toBe(original.repair.message + 2);
    const otherRepair = repaired().map(item => ({ ...item, call_id: "other-edit" }));
    expect(collectAdvisorRepairEvidence(parsed([task, ...failed("first"), ...otherRepair, ...failed("retry")]))!.id).not.toBe(original.id);
  });

  test.each([
    ["one failure", [task, ...failed("first")]],
    ["no edit", [task, ...failed("first"), ...failed("retry")]],
    ["different command", [task, ...failed("first"), ...repaired(), ...failed("retry", "bun run typecheck")]],
    ["different directory", [task, ...failed("first"), ...repaired(), ...failed("retry", "bun test tests/example.test.ts", "/other")]],
    ["echoed command", [task, ...failed("first", 'echo "bun test"'), ...repaired(), ...failed("retry", 'echo "bun test"')]],
    ["compound shell", [task, ...failed("first", "bun test || true"), ...repaired(), ...failed("retry", "bun test || true")]],
    ["failure prose only", [task, ...tool("first", "exec_command", { cmd: "bun test" }, "FAIL: 1 test failed"), ...repaired(), ...tool("retry", "exec_command", { cmd: "bun test" }, "FAIL: 1 test failed")]],
    ["failed edit", [task, ...failed("first"), ...tool("edit", "apply_patch", {}, "Error: patch rejected", true), ...failed("retry")]],
    ["new user task", [task, ...failed("first"), { role: "user", content: "Now fix another task" }, ...repaired(), ...failed("retry")]],
    ["success clears failure", [task, ...failed("first"), ...repaired(), ...tool("ok", "exec_command", { cmd: "bun test tests/example.test.ts", workdir: "/workspace" }, "Process exit code: 0"), ...failed("retry")]],
    ["success after retry", [task, ...failed("first"), ...repaired(), ...failed("retry"), ...tool("ok", "exec_command", { cmd: "bun test tests/example.test.ts", workdir: "/workspace" }, "Process exit code: 0")]],
  ])("does not trigger on %s", (_name, input) => {
    expect(collectAdvisorRepairEvidence(parsed(input as unknown[]))).toBeUndefined();
  });

  test("a polled command keeps its validation identity through write_stdin", () => {
    const request = parsed([
      task,
      ...tool("first", "exec_command", { cmd: "bun test" }, "Process running with session ID 99"),
      ...tool("poll", "write_stdin", { session_id: 99 }, "Process exited with code 1\nOutput:\nassertion failed"),
      ...repaired(),
      ...tool("retry", "exec_command", { cmd: "bun test" }, '{"exit_code":1,"output":"assertion failed"}'),
    ]);
    expect(collectAdvisorRepairEvidence(request)?.command).toBe("bun test");
  });

  test("replayed results and unpaired edits cannot manufacture another execution", () => {
    const input = [task, ...failed("first"), ...repaired()];
    input.push({ type: "function_call_output", call_id: "first", output: "Process exit code: 1" });
    expect(collectAdvisorRepairEvidence(parsed(input))).toBeUndefined();
    expect(collectAdvisorRepairEvidence(parsed([task, ...failed("first"), { type: "function_call_output", call_id: "unknown", output: "Success. Updated files" }, ...failed("retry")]))).toBeUndefined();
  });

  test("failure excerpts are bounded and retain the output tail", () => {
    const request = parsed([task, ...failed("first"), ...repaired(), ...tool("retry", "exec_command", { cmd: "bun test tests/example.test.ts", workdir: "/workspace" }, `Process exit code: 1\n${"x".repeat(20_000)}TAIL`)]);
    const evidence = collectAdvisorRepairEvidence(request)!;
    expect(evidence.repeatedFailure.output.length).toBeLessThan(1700);
    expect(evidence.repeatedFailure.output).toContain("[output truncated]");
    expect(evidence.repeatedFailure.output).toEndWith("TAIL");
  });

  test("a validation already running before the edit cannot count as a post-repair retry", () => {
    const running = tool("retry", "exec_command", { cmd: "bun test tests/example.test.ts", workdir: "/workspace" }, "Process running with session ID 12");
    const request = parsed([task, ...failed("first"), ...running, ...repaired(), ...tool("poll", "write_stdin", { session_id: 12 }, "Process exit code: 1")]);
    expect(collectAdvisorRepairEvidence(request)).toBeUndefined();
  });

  test("argv-style shell calls match and a normalized successful command clears the event", () => {
    const request = parsed([task,
      ...tool("first", "shell", { command: ["bun", "test"] }, '{"exitCode":1}'),
      ...repaired(),
      ...tool("retry", "shell", { command: ["bun", "test"] }, '{"exitCode":1}'),
    ]);
    expect(collectAdvisorRepairEvidence(request)).toBeDefined();
    const success = parsed([task,
      ...failed("first", "bun test"), ...repaired(), ...failed("retry", "bun test"),
      ...tool("ok", "shell", { command: "bun   test", workdir: "/workspace" }, '{"exitCode":0}'),
    ]);
    expect(collectAdvisorRepairEvidence(success)).toBeUndefined();
  });

  test("single literal Code Mode helpers work without interpreting executable JavaScript or batches", () => {
    const check = (id: string, input: string) => tool(id, "functions.exec", { input }, 'Script completed\nOutput:\n{"exit_code":1,"output":"assertion failed"}');
    const request = parsed([task,
      ...check("first", 'const result = await tools.exec_command({cmd: "bun test"}); text(result);'),
      ...tool("edit", "functions.exec", { input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: example.ts\\n@@\\n-1\\n+2\\n*** End Patch"));' }, "{}"),
      ...check("retry", 'text(await tools.exec_command({"cmd":"bun test"}));'),
    ]);
    expect(collectAdvisorRepairEvidence(request)).toBeDefined();
    for (const input of ['text(await tools.exec_command({cmd: buildCommand()}));', 'text(await tools.exec_command({cmd: "bun test"})); text(await tools.exec_command({cmd: "bun test"}));']) {
      expect(collectAdvisorRepairEvidence(parsed([task, ...check("first", input), ...repaired(), ...check("retry", input)]))).toBeUndefined();
    }
  });
});
