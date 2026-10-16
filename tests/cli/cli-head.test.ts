import { describe, expect, spyOn, test } from "bun:test";
import { parseCliHead, runCli } from "../../src/cli/root";
import * as autorestore from "../../src/cli/codex-shim-autorestore";
import { DEFAULT_READY_WAIT_TIMEOUT_SECONDS } from "../../src/cli/ready";

describe("parseCliHead (pure CLI head, Phase 1)", () => {
  test("preserves explicit nested help paths and original argv", () => {
    for (const args of [["help", "models", "context"], ["models", "context", "--help"], ["models", "context", "-h"]]) {
      const head = parseCliHead(args);
      expect(head).toMatchObject({ kind: "help", helpTarget: "models", helpPath: ["models", "context"] });
      expect(head.args).toBe(args);
    }
  });

  test("full-reference help is explicit", () => {
    for (const args of [["help", "--all"], ["--help", "--all"]]) {
      expect(parseCliHead(args)).toEqual({ kind: "help", command: args[0], args, helpAll: true });
    }
  });

  test("help-valued operands and passthrough flags remain ordinary argv", () => {
    for (const args of [
      ["alias", "set", "demo", "help"], ["config", "set", "defaultModel", "help"],
      ["claude", "--", "--help"], ["claude", "--", "help"], ["models", "--all"],
    ]) {
      expect(parseCliHead(args)).toEqual({ kind: "command", command: args[0], args });
      expect(parseCliHead(args).args).toBe(args);
    }
  });

  test("head scanning stops at the delimiter and the first option ends the topic", () => {
    expect(parseCliHead(["help", "models", "context", "--", "shadow"]))
      .toMatchObject({ helpPath: ["models", "context"] });
    expect(parseCliHead(["models", "--provider", "help", "--help"]))
      .toEqual({ kind: "help", command: "models", args: ["models", "--provider", "help", "--help"], helpTarget: "models" });
    expect(parseCliHead(["help", "--", "--all"])).not.toHaveProperty("helpAll");
  });

  test("unknown option-like roots retain their error target", () => {
    for (const args of [["--nosuch", "--help"], ["help", "--nosuch"]]) {
      expect(parseCliHead(args)).toEqual({ kind: "help", command: args[0], args, helpTarget: "--nosuch" });
    }
  });

  test("version flags exit as version", () => {
    expect(parseCliHead(["--version"])).toEqual({ kind: "version", command: "--version", args: ["--version"] });
    expect(parseCliHead(["-v"])).toEqual({ kind: "version", command: "-v", args: ["-v"] });
    expect(parseCliHead(["version"])).toEqual({ kind: "version", command: "version", args: ["version"] });
  });

  test("bare help forms exit as help", () => {
    expect(parseCliHead([])).toEqual({ kind: "help", command: undefined, args: [] });
    expect(parseCliHead(["help"])).toEqual({ kind: "help", command: "help", args: ["help"] });
    expect(parseCliHead(["--help"])).toEqual({ kind: "help", command: "--help", args: ["--help"] });
    expect(parseCliHead(["-h"])).toEqual({ kind: "help", command: "-h", args: ["-h"] });
  });

  test("help with a subcommand carries the subcommand", () => {
    expect(parseCliHead(["help", "service"])).toEqual({
      kind: "help",
      command: "help",
      args: ["help", "service"],
      helpTarget: "service",
    });
  });

  test("help with an unknown subcommand still carries the helpTarget", () => {
    expect(parseCliHead(["help", "nosuch"])).toEqual({
      kind: "help",
      command: "help",
      args: ["help", "nosuch"],
      helpTarget: "nosuch",
    });
  });

  test("help flag after position 0 is a help exit for that command", () => {
    expect(parseCliHead(["sync", "--help"])).toEqual({
      kind: "help",
      command: "sync",
      args: ["sync", "--help"],
      helpTarget: "sync",
    });
    expect(parseCliHead(["sync", "help"])).toEqual({
      kind: "help",
      command: "sync",
      args: ["sync", "help"],
      helpTarget: "sync",
    });
    expect(parseCliHead(["provider", "-h"])).toEqual({
      kind: "help",
      command: "provider",
      args: ["provider", "-h"],
      helpTarget: "provider",
    });
  });

  test("helpTarget routes the subcommand or command whose usage should print", () => {
    expect(parseCliHead(["help", "service"])).toEqual({
      kind: "help",
      command: "help",
      args: ["help", "service"],
      helpTarget: "service",
    });
    expect(parseCliHead(["sync", "--help"])).toEqual({
      kind: "help",
      command: "sync",
      args: ["sync", "--help"],
      helpTarget: "sync",
    });
    expect(parseCliHead(["provider", "-h"])).toEqual({
      kind: "help",
      command: "provider",
      args: ["provider", "-h"],
      helpTarget: "provider",
    });
    expect(parseCliHead(["ready", "--help"])).toEqual({
      kind: "help",
      command: "ready",
      args: ["ready", "--help"],
      helpTarget: "ready",
    });
  });

  test("valid ready args are pre-parsed and stashed", () => {
    expect(parseCliHead(["ready"])).toEqual({
      kind: "ready",
      command: "ready",
      args: ["ready"],
      readyArgs: { json: false, wait: false, timeoutSeconds: DEFAULT_READY_WAIT_TIMEOUT_SECONDS },
    });
    expect(parseCliHead(["ready", "--json", "--wait", "--timeout", "120"])).toEqual({
      kind: "ready",
      command: "ready",
      args: ["ready", "--json", "--wait", "--timeout", "120"],
      readyArgs: { json: true, wait: true, timeoutSeconds: 120 },
    });
  });

  test("invalid ready args fail closed with no readyArgs", () => {
    expect(parseCliHead(["ready", "--timeout", "5"])).toEqual({
      kind: "ready",
      command: "ready",
      args: ["ready", "--timeout", "5"],
      readyArgs: undefined,
    });
    expect(parseCliHead(["ready", "--nope"])).toEqual({
      kind: "ready",
      command: "ready",
      args: ["ready", "--nope"],
      readyArgs: undefined,
    });
    expect(parseCliHead(["ready", "--wait", "--timeout", "abc"])).toEqual({
      kind: "ready",
      command: "ready",
      args: ["ready", "--wait", "--timeout", "abc"],
      readyArgs: undefined,
    });
  });

  test("ordinary commands dispatch as command", () => {
    expect(parseCliHead(["status"])).toEqual({ kind: "command", command: "status", args: ["status"] });
    expect(parseCliHead(["start", "--port", "8080"])).toEqual({
      kind: "command",
      command: "start",
      args: ["start", "--port", "8080"],
    });
    expect(parseCliHead(["sync"])).toEqual({ kind: "command", command: "sync", args: ["sync"] });
    expect(parseCliHead(["provider", "list"])).toEqual({
      kind: "command",
      command: "provider",
      args: ["provider", "list"],
    });
    expect(parseCliHead([""])).toEqual({ kind: "command", command: "", args: [""] });
  });
});

describe("uninstall argument validation", () => {
  test("uninstall and remove reject trailing arguments before shim preflight", async () => {
    const preflight = spyOn(autorestore, "maybeAutoRestoreCodexShim").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation((() => { throw new Error("usage-exit"); }) as never);
    try {
      for (const command of ["uninstall", "remove"]) {
        for (const trailing of [["--dry-run"], ["--yes"], ["extra"], ["--", "--help"]]) {
          await expect(runCli([command, ...trailing])).rejects.toThrow("usage-exit");
          expect(exit).toHaveBeenLastCalledWith(2);
          expect(error.mock.calls.at(-1)?.[0]).toContain("No changes were made.");
          expect(error.mock.calls.at(-1)?.[0]).toContain(`ocx help ${command}`);
        }
      }
      expect(preflight).not.toHaveBeenCalled();
    } finally { preflight.mockRestore(); error.mockRestore(); exit.mockRestore(); }
  });

  test("uninstall help bypasses preflight and bare commands retain it", async () => {
    const preflight = spyOn(autorestore, "maybeAutoRestoreCodexShim").mockImplementation(() => {});
    const output = spyOn(console, "log").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation((() => { throw new Error("help-exit"); }) as never);
    try {
      for (const command of ["uninstall", "remove"]) {
        for (const args of [[command, "--help"], [command, "-h"], [command, "help"], ["help", command]]) {
          await expect(runCli(args)).rejects.toThrow("help-exit");
          expect(exit).toHaveBeenLastCalledWith(0);
        }
      }
      expect(preflight).not.toHaveBeenCalled();
      for (const command of ["uninstall", "remove"]) {
        expect(await runCli([command])).toMatchObject({ kind: "command", command });
      }
      expect(preflight).toHaveBeenCalledTimes(2);
    } finally { preflight.mockRestore(); output.mockRestore(); exit.mockRestore(); }
  });
});
