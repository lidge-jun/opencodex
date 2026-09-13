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

  test("view_image compiles to tools.view_image and forwards image_url to image()", async () => {
    const source = compileCodeModeHelperInput(
      JSON.stringify({ path: "/tmp/shot.png", detail: "high" }),
      "default.view_image",
    );
    let received: unknown;
    let surfaced: unknown;
    const run = new AsyncFunction("tools", "text", "image", source);

    await run(
      {
        view_image: async (args: unknown) => {
          received = args;
          return { image_url: "data:image/png;base64,AAAA" };
        },
      },
      () => { throw new Error("image result leaked into text output"); },
      (value: unknown) => { surfaced = value; },
    );

    expect(received).toEqual({ path: "/tmp/shot.png", detail: "high" });
    expect(surfaced).toBe("data:image/png;base64,AAAA");
  });

  test("view_image maps file_path/file/image_path aliases onto path", async () => {
    for (const alias of ["file_path", "file", "image_path"]) {
      const source = compileCodeModeHelperInput(
        JSON.stringify({ [alias]: "/tmp/alias.png" }),
        "view_image",
      );
      let received: unknown;
      const run = new AsyncFunction("tools", "text", "image", source);
      await run(
        {
          view_image: async (args: unknown) => {
            received = args;
            return {};
          },
        },
        () => {},
        () => {},
      );
      expect(received).toEqual({ path: "/tmp/alias.png" });
    }
  });

  test("view_image keeps explicit path precedence and removes provider aliases", async () => {
    const source = compileCodeModeHelperInput(
      JSON.stringify({ path: "/tmp/right.png", file_path: "/tmp/wrong.png", detail: "original" }),
      "view_image",
    );
    let received: unknown;
    const run = new AsyncFunction("tools", "text", "image", source);
    await run(
      {
        view_image: async (args: unknown) => {
          received = args;
          return {};
        },
      },
      () => {},
      () => {},
    );
    expect(received).toEqual({ path: "/tmp/right.png", detail: "original" });
  });

  test("view_image aliases use deterministic precedence when providers send more than one", async () => {
    const source = compileCodeModeHelperInput(
      JSON.stringify({
        file_path: "/tmp/file-path.png",
        file: "/tmp/file.png",
        image_path: "/tmp/image-path.png",
      }),
      "view_image",
    );
    let received: unknown;
    const run = new AsyncFunction("tools", "text", "image", source);
    await run(
      {
        view_image: async (args: unknown) => {
          received = args;
          return {};
        },
      },
      () => {},
      () => {},
    );

    expect(received).toEqual({ path: "/tmp/file-path.png" });
  });

  test("view_image without image_url still returns the host result", async () => {
    const source = compileCodeModeHelperInput(
      JSON.stringify({ path: "/tmp/missing.png" }),
      "view_image",
    );
    let surfaced = false;
    let output: unknown;
    const run = new AsyncFunction("tools", "text", "image", source);
    await run(
      {
        view_image: async () => ({ error: "not found" }),
      },
      (value: unknown) => { output = value; },
      () => { surfaced = true; },
    );
    expect(surfaced).toBe(false);
    expect(output).toEqual({ error: "not found" });
  });

  test("invalid view_image input remains data instead of becoming JavaScript", async () => {
    const input = "{not-json`); throw new Error('escaped') //";
    let received: unknown;
    const run = new AsyncFunction(
      "tools",
      "text",
      "image",
      compileCodeModeHelperInput(input, "view_image"),
    );

    await run(
      {
        view_image: async (args: unknown) => {
          received = args;
          return { error: "invalid input" };
        },
      },
      () => {},
      () => {},
    );

    expect(received).toBe(input);
  });
});
