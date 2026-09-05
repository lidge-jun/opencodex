import { describe, expect, test } from "bun:test";
import { compileCodeModeHelperInput } from "../../src/responses/code-mode-helper-compat";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

describe("code-mode helper compatibility", () => {
  test("exec_command arguments remain data when generated JavaScript runs", async () => {
    const command = "printf '%s' \"$HOME\"; }); throw new Error('escaped') //";
    const source = compileCodeModeHelperInput(
      JSON.stringify({ cmd: command, workdir: "/tmp", yield_time_ms: 1_000 }),
      "exec_command",
    );
    let received: unknown;
    let output: unknown;
    const run = new AsyncFunction("tools", "text", source);

    await run({
      exec_command: async (args: unknown) => {
        received = args;
        return { exit_code: 0, output: "ok" };
      },
    }, (value: unknown) => { output = value; });

    expect(received).toEqual({ cmd: command, workdir: "/tmp", yield_time_ms: 1_000 });
    expect(output).toEqual({ exit_code: 0, output: "ok" });
  });

  test("shell_command maps command to the nested exec cmd field", async () => {
    const source = compileCodeModeHelperInput(
      JSON.stringify({ command: "pwd", workdir: "/tmp" }),
      "shell_command",
    );
    let received: unknown;
    const run = new AsyncFunction("tools", "text", source);
    await run({
      exec_command: async (args: unknown) => {
        received = args;
        return "ok";
      },
    }, () => {});
    expect(received).toEqual({ workdir: "/tmp", cmd: "pwd" });
  });

  test("write_stdin arguments remain data and target the nested helper", async () => {
    const args = {
      session_id: 17,
      chars: "`); throw new Error('escaped') //",
      yield_time_ms: 1_000,
    };
    const source = compileCodeModeHelperInput(JSON.stringify(args), "write_stdin");
    let received: unknown;
    let output: unknown;
    const run = new AsyncFunction("tools", "text", source);

    await run({
      write_stdin: async (value: unknown) => {
        received = value;
        return { output: "more" };
      },
    }, (value: unknown) => { output = value; });

    expect(received).toEqual(args);
    expect(output).toEqual({ output: "more" });
  });

  test("apply_patch text remains one string argument", async () => {
    const patch = "*** Begin Patch\n*** Add File: note.txt\n+`); throw new Error('escaped')\n*** End Patch";
    const source = compileCodeModeHelperInput(patch, "apply_patch");
    let received: unknown;
    const run = new AsyncFunction("tools", "text", source);
    await run({
      apply_patch: async (input: unknown) => {
        received = input;
        return "done";
      },
    }, () => {});
    expect(received).toBe(patch);
  });

  test("apply_patch normalizes decorated outer delimiters before execution", async () => {
    const decorated = "*** Begin Patch ***\n*** Add File: note.txt\n+hello\n*** End Patch ***";
    const canonical = "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch";
    let received: unknown;
    const run = new AsyncFunction(
      "tools",
      "text",
      compileCodeModeHelperInput(JSON.stringify({ input: decorated }), "apply_patch"),
    );

    await run({
      apply_patch: async (input: unknown) => {
        received = input;
        return "done";
      },
    }, () => {});

    expect(received).toBe(canonical);
  });

  test("invalid structured shell input remains data instead of becoming JavaScript", async () => {
    for (const input of ["{not-json", "[]"]) {
      let received: unknown;
      const run = new AsyncFunction("tools", "text", compileCodeModeHelperInput(input, "exec_command"));
      await run({
        exec_command: async (args: unknown) => {
          received = args;
          return "rejected";
        },
      }, () => {});
      expect(received).toEqual(input === "[]" ? [] : input);
    }
  });
});
