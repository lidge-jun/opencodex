import { describe, expect, test } from "bun:test";
import { parseCliHead } from "../src/cli/root";
import { DEFAULT_READY_WAIT_TIMEOUT_SECONDS } from "../src/cli/ready";

describe("parseCliHead (pure CLI head, Phase 1)", () => {
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
