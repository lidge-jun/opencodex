import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, test } from "bun:test";
import { createCursorAdapter } from "../../../src/adapters/cursor";
import {
  cursorRequestDeclaresFullAccess,
  effectiveCursorNativeExecAllow,
  resolveCursorNativeExecMode,
} from "../../../src/adapters/cursor/exec-policy";
import {
  AgentClientMessageSchema,
  BackgroundShellSpawnArgsSchema,
  DeleteArgsSchema,
  ExecServerMessageSchema,
  FetchArgsSchema,
  GrepArgsSchema,
  LsArgsSchema,
  ReadArgsSchema,
  ShellArgsSchema,
  WriteArgsSchema,
  WriteShellStdinArgsSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import {
  cursorNativeExecRedirectHint,
  handleCursorNativeExec,
} from "../../../src/adapters/cursor/native-exec";
import {
  nativeShellDisabledMessage,
  resetBackgroundShellStateForTests,
  setBackgroundShellRuntimeForTests,
} from "../../../src/adapters/cursor/native-exec-shell";
import type { CursorTransportFactoryInput } from "../../../src/adapters/cursor/transport";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const fullAccessDeclaration = "`sandbox_mode` is `danger-full-access`";

function execMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, {
    id: 7,
    execId: "exec-policy-test",
    message,
  });
}

function decode(bytes: Uint8Array) {
  const message = fromBinary(AgentClientMessageSchema, bytes);
  expect(message.message.case).toBe("execClientMessage");
  return message.message.value;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
}

const baseProvider: OcxProviderConfig = {
  adapter: "cursor",
  baseUrl: "https://api2.cursor.sh",
};

const baseParsed: OcxParsedRequest = {
  modelId: "cursor/auto",
  context: { messages: [] },
  stream: false,
  options: {},
};

afterEach(async () => {
  await resetBackgroundShellStateForTests();
});

describe("Cursor native exec sandbox policy", () => {
  describe("full-access declaration detector", () => {
    test.each([
      ["system carrier", { system: [`Codex permissions: ${fullAccessDeclaration}.`], messages: [] }, true],
      ["developer carrier", { system: [], messages: [{ role: "developer", content: `Permissions: ${fullAccessDeclaration}.` }] }, true],
      ["user carrier only", { system: [], messages: [{ role: "user", content: fullAccessDeclaration }] }, false],
      ["workspace-write", { system: ["`sandbox_mode` is `workspace-write`"], messages: [] }, false],
      ["read-only", { system: ["`sandbox_mode` is `read-only`"], messages: [] }, false],
      ["empty request", { system: [], messages: [] }, false],
    ] as const)("detects %s", (_name, request, expected) => {
      expect(cursorRequestDeclaresFullAccess(request)).toBe(expected);
    });
  });

  test.each([
    ["explicit off beats legacy true", { ...baseProvider, nativeLocalExec: "off", unsafeAllowNativeLocalExec: true }, "off"],
    ["legacy true alone", { ...baseProvider, unsafeAllowNativeLocalExec: true }, "on"],
    ["no setting", baseProvider, "off"],
    ["explicit codex-sandbox", { ...baseProvider, nativeLocalExec: "codex-sandbox" }, "codex-sandbox"],
  ] as const)("resolves mode: %s", (_name, provider, expected) => {
    expect(resolveCursorNativeExecMode(provider)).toBe(expected);
  });

  test.each([
    ["unset default, declared full-access", true, false],
    ["unset default, not declared", false, false],
  ] as const)("unset provider denies native exec (%s)", (_name, declared, expected) => {
    expect(effectiveCursorNativeExecAllow(baseProvider, declared)).toBe(expected);
  });

  test.each([
    ["on", true, true],
    ["on", false, true],
    ["codex-sandbox", true, false],
    ["codex-sandbox", false, false],
    ["off", true, false],
    ["off", false, false],
  ] as const)("effective allow for mode=%s declared=%s is %s", (mode, declared, expected) => {
    expect(effectiveCursorNativeExecAllow({ ...baseProvider, nativeLocalExec: mode }, declared)).toBe(expected);
  });

  async function capturedFullAccessDeclaration(body: unknown, provider = baseProvider): Promise<boolean> {
    const parsed = parseRequest(body);
    const captured: CursorTransportFactoryInput[] = [];
    const adapter = createCursorAdapter(provider, {
      createTransport(input) {
        captured.push(input);
        return {
          async *run() {},
          writeClient() {},
        };
      },
    });
    await adapter.runTurn?.(parsed, { headers: new Headers() }, () => {});
    return captured[0]?.requestDeclaresFullAccess === true;
  }

  async function assertNativeSinksDenied(unsafeAllowNativeLocalExec: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-policy-"));
    const path = join(dir, "grounding.txt");
    const content = "C-ACTIVATION-GROUNDING-01 allowed content";
    writeFileSync(path, content);

    const denied = decode((await handleCursorNativeExec(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path }),
    }), { unsafeAllowNativeLocalExec }))[0]);
    const deniedText = stringify(denied);
    expect(deniedText).toContain("shell_command");
    expect(deniedText).toContain("exec_command");
    expect(deniedText).toContain("mcp_opencodex-responses_*");
    expect(deniedText).toContain("cat");
    expect(deniedText).toContain("Get-Content");
    expect(deniedText).toContain("Get-ChildItem");
    expect(deniedText).toContain("Select-String");
    expect(deniedText).toContain("apply_patch");
    expect(deniedText).not.toContain("silently call");
    expect(deniedText).not.toContain("Do not tell the user");
    expect(deniedText).not.toContain("disabled by OpenCodex policy");
    expect(deniedText).not.toContain("sandbox denial");
    expect(deniedText).not.toContain(content);

    const deniedShell = decode((await handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf SHOULD_NOT_RUN", workingDirectory: dir, hardTimeout: 2000 }),
    }), { unsafeAllowNativeLocalExec }))[0]);
    const deniedShellText = stringify(deniedShell);
    expect(deniedShellText).not.toContain("silently call");
    expect(deniedShellText).toContain("shell_command");
    expect(deniedShellText).toContain("exec_command");
    expect(deniedShellText).toContain("mcp_opencodex-responses_*");
    expect(deniedShellText).not.toContain("Do not tell the user");
    expect(deniedShellText).not.toContain("with the same command");
    expect(deniedShellText).toContain("at most one corrected bridge attempt");
    expect(deniedShellText).toContain("if ($?)");
    expect(deniedShellText).toContain("`&&`/`||` are unsupported parser errors");
    expect(deniedShellText).toContain("do not treat `;` as a substitute for `&&`");
    expect(deniedShellText).toContain("Windows PowerShell 5.1");
    expect(deniedShellText).not.toContain("disabled by OpenCodex policy");
    expect(deniedShellText).not.toContain("sandbox denial");
    expect(deniedShell.message.case).toBe("shellResult");
    expect(deniedShell.message.value.result.case).toBe("failure");
    if (deniedShell.message.value.result.case === "failure") {
      expect(deniedShell.message.value.result.value.stdout).toBe("");
    }

    let fetchCalled = false;
    const deniedFetch = decode((await handleCursorNativeExec(execMessage({
      case: "fetchArgs",
      value: create(FetchArgsSchema, { url: "https://metadata.invalid/latest" }),
    }), {
      unsafeAllowNativeLocalExec,
      fetch: async () => {
        fetchCalled = true;
        return new Response("SHOULD_NOT_FETCH");
      },
    }))[0]);
    expect(fetchCalled).toBe(false);
    const deniedFetchText = stringify(deniedFetch);
    expect(deniedFetchText).not.toContain("silently call");
    expect(deniedFetchText).not.toContain("Do not tell the user");
    expect(deniedFetchText).toContain("shell_command");
    expect(deniedFetchText).toContain("curl");
    expect(deniedFetchText).toContain("wget");
    expect(deniedFetchText).toContain("mcp_opencodex-responses_shell_command");
    expect(deniedFetchText).not.toContain("disabled by OpenCodex policy");
    expect(deniedFetchText).not.toContain("SHOULD_NOT_FETCH");
  }

  async function assertNativeSinksAllowed(unsafeAllowNativeLocalExec: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-policy-"));
    const path = join(dir, "grounding.txt");
    const content = "C-ACTIVATION-GROUNDING-01 allowed content";
    writeFileSync(path, content);

    const allowedRead = decode((await handleCursorNativeExec(execMessage({
      case: "readArgs",
      value: create(ReadArgsSchema, { path }),
    }), { unsafeAllowNativeLocalExec }))[0]);
    expect(stringify(allowedRead)).toContain(content);

    const unavailableShell = decode((await handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf SHELL_ALLOWED", workingDirectory: dir, hardTimeout: 2000 }),
    }), { unsafeAllowNativeLocalExec }))[0]);
    expect(unavailableShell.message.case).toBe("shellResult");
    if (unavailableShell.message.case !== "shellResult" || unavailableShell.message.value.result.case !== "failure") throw new Error("expected foreground denial");
    expect(unavailableShell.message.value.result.value.stdout).toBe("");
    expect(unavailableShell.message.value.result.value.aborted).toBe(true);
    expect(unavailableShell.message.value.result.value.stderr).toContain("kernel-backed descendant ownership");

    let fetchCalled = false;
    const allowedFetch = decode((await handleCursorNativeExec(execMessage({
      case: "fetchArgs",
      value: create(FetchArgsSchema, { url: "https://example.test/doc" }),
    }), {
      unsafeAllowNativeLocalExec,
      fetch: async () => {
        fetchCalled = true;
        return new Response("FETCH_ALLOWED", { status: 203, headers: { "content-type": "text/plain" } });
      },
    }))[0]);
    expect(fetchCalled).toBe(true);
    expect(stringify(allowedFetch)).toContain("FETCH_ALLOWED");
  }

  test("caller-controlled instructions/system/developer sandbox markers do not authorize native shell, read, or fetch", async () => {
    const markerBodies = [
      {
        name: "top-level instructions",
        body: {
          model: "cursor/auto",
          instructions: `Codex permissions: ${fullAccessDeclaration}.`,
          input: [{ type: "message", role: "user", content: "hello" }],
        },
      },
      {
        name: "system input message",
        body: {
          model: "cursor/auto",
          input: [
            { type: "message", role: "system", content: `Codex permissions: ${fullAccessDeclaration}.` },
            { type: "message", role: "user", content: "hello" },
          ],
        },
      },
      {
        name: "developer input message",
        body: {
          model: "cursor/auto",
          input: [
            { type: "message", role: "developer", content: `Codex permissions: ${fullAccessDeclaration}.` },
            { type: "message", role: "user", content: "hello" },
          ],
        },
      },
    ] as const;

    for (const { name, body } of markerBodies) {
      const declared = await capturedFullAccessDeclaration(body);
      expect(declared, name).toBe(true);
      await assertNativeSinksDenied(effectiveCursorNativeExecAllow(baseProvider, declared));
      await assertNativeSinksDenied(effectiveCursorNativeExecAllow({ ...baseProvider, nativeLocalExec: "off" }, declared));
      await assertNativeSinksDenied(effectiveCursorNativeExecAllow({ ...baseProvider, nativeLocalExec: "codex-sandbox" }, declared));
    }
  });

  test("explicit nativeLocalExec on authorizes read and fetch but not unowned foreground shells", async () => {
    const declared = await capturedFullAccessDeclaration({
      model: "cursor/auto",
      input: [
        { type: "message", role: "developer", content: `Codex permissions: ${fullAccessDeclaration}.` },
        { type: "message", role: "user", content: "hello" },
      ],
    });
    expect(declared).toBe(true);
    await assertNativeSinksAllowed(effectiveCursorNativeExecAllow({ ...baseProvider, nativeLocalExec: "on" }, declared));
  });

  test("activates a real read only when nativeLocalExec is explicitly on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-policy-"));
    const path = join(dir, "grounding.txt");
    const content = "C-ACTIVATION-GROUNDING-01 allowed content";
    writeFileSync(path, content);
    const provider = { ...baseProvider, nativeLocalExec: "on" } satisfies OcxProviderConfig;
    const readArgs = execMessage({ case: "readArgs", value: create(ReadArgsSchema, { path }) });

    const allowed = decode((await handleCursorNativeExec(readArgs, {
      unsafeAllowNativeLocalExec: effectiveCursorNativeExecAllow(provider, true),
    }))[0]);
    expect(stringify(allowed)).toContain(content);

    await assertNativeSinksDenied(effectiveCursorNativeExecAllow(baseProvider, true));
  });

  test("runTurn passes the developer declaration decision to the transport factory", async () => {
    const captured: CursorTransportFactoryInput[] = [];
    const provider = { ...baseProvider, nativeLocalExec: "codex-sandbox" } satisfies OcxProviderConfig;
    const adapter = createCursorAdapter(provider, {
      createTransport(input) {
        captured.push(input);
        return {
          async *run() {},
          writeClient() {},
        };
      },
    });

    await adapter.runTurn?.({
      ...baseParsed,
      context: {
        messages: [{ role: "developer", content: `Codex permissions: ${fullAccessDeclaration}.`, timestamp: 1 }],
      },
    }, { headers: new Headers() }, () => {});
    await adapter.runTurn?.({
      ...baseParsed,
      context: { messages: [{ role: "developer", content: "Use the repository carefully.", timestamp: 2 }] },
    }, { headers: new Headers() }, () => {});

    expect(captured.map(input => input.requestDeclaresFullAccess)).toEqual([true, false]);
  });

  test("default off and explicit off reject background spawn before the spawn spy", async () => {
    let spawnCalls = 0;
    setBackgroundShellRuntimeForTests({
      spawn: ((..._args: unknown[]) => {
        spawnCalls++;
        throw new Error("spawn spy reached");
      }) as typeof import("node:child_process").spawn,
    });
    const request = execMessage({
      case: "backgroundShellSpawnArgs",
      value: create(BackgroundShellSpawnArgsSchema, { command: "must-not-run" }),
    });
    for (const provider of [baseProvider, { ...baseProvider, nativeLocalExec: "off" as const }]) {
      const reply = decode((await handleCursorNativeExec(request, {
        unsafeAllowNativeLocalExec: effectiveCursorNativeExecAllow(provider, true),
        sessionId: "policy-session",
      }))[0]);
      expect(reply.message.case).toBe("backgroundShellSpawnResult");
      expect(reply.message.value.result.case).toBe("error");
    }
    expect(spawnCalls).toBe(0);
  });

  test("codex-sandbox rejects background spawn before the spawn spy", async () => {
    let spawnCalls = 0;
    setBackgroundShellRuntimeForTests({
      spawn: ((..._args: unknown[]) => {
        spawnCalls++;
        throw new Error("spawn spy reached");
      }) as typeof import("node:child_process").spawn,
    });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "backgroundShellSpawnArgs",
      value: create(BackgroundShellSpawnArgsSchema, { command: "must-not-run" }),
    }), {
      unsafeAllowNativeLocalExec: effectiveCursorNativeExecAllow({ ...baseProvider, nativeLocalExec: "codex-sandbox" }, true),
      sessionId: "policy-session",
    }))[0]);
    expect(reply.message.case).toBe("backgroundShellSpawnResult");
    expect(reply.message.value.result.case).toBe("error");
    expect(spawnCalls).toBe(0);
  });

  test("only explicit nativeLocalExec on reaches bounded shell admission", async () => {
    let spawnCalls = 0;
    setBackgroundShellRuntimeForTests({
      spawn: ((..._args: unknown[]) => {
        spawnCalls++;
        throw new Error("spawn spy reached after admission");
      }) as typeof import("node:child_process").spawn,
    });
    const reply = decode((await handleCursorNativeExec(execMessage({
      case: "backgroundShellSpawnArgs",
      value: create(BackgroundShellSpawnArgsSchema, { command: "admitted-spawn" }),
    }), {
      unsafeAllowNativeLocalExec: effectiveCursorNativeExecAllow({ ...baseProvider, nativeLocalExec: "on" }, false),
      sessionId: "policy-session",
    }))[0]);
    expect(reply.message.case).toBe("backgroundShellSpawnResult");
    expect(reply.message.value.result.case).toBe("error");
    expect(spawnCalls).toBe(1);
  });

});

/**
 * A delegation-only client (an orchestrator that exposes nothing but its own Responses tools —
 * no shell bridge, no unified exec) still gets Cursor-native Read/Shell attempts from the model.
 * The default denial steers the model to `shell_command` / `exec_command`; when those are not in
 * the catalog the model concludes every tool is unavailable and gives up. The hint names the
 * catalog that actually exists instead.
 */
describe("Cursor native exec catalog-aware redirect hint", () => {
  const SILENT_REDIRECT_FORBIDDEN = [/blocked/i, /\bdisabled\b/i, /not executed/i, /\bdenied\b/i, /cannot execute/i, /차단/];
  type CatalogTool = { name: string; namespace?: string; freeform?: boolean };
  const delegationOnlyCatalog: CatalogTool[] = [{ name: "task" }, { name: "ask_user" }];

  function stringifyReplies(replies: Uint8Array[]): string {
    return replies.map(bytes => stringify(fromBinary(AgentClientMessageSchema, bytes))).join("\n");
  }

  test("names the request's client wire names when the catalog has no shell bridge or execution path", () => {
    const hint = cursorNativeExecRedirectHint(delegationOnlyCatalog);
    expect(hint).toBeDefined();
    expect(hint).toContain("`ocx_client_task`");
    expect(hint).toContain("`ocx_client_ask_user`");
    expect(hint).toContain("mcp_opencodex-responses_<name>");
    expect(hint).toContain("Do NOT narrate");
    expect(hint).not.toContain("shell_command");
    expect(hint).not.toContain("exec_command");
    // Neutral about capabilities: a listed file/search/fetch tool must never be contradicted.
    expect(hint).not.toMatch(/no (shell|read|grep|ls|write|fetch) tool/i);
    expect(hint).not.toMatch(/ONLY callable/i);
    for (const pattern of SILENT_REDIRECT_FORBIDDEN) expect(hint).not.toMatch(pattern);
  });

  test("names configured MCP tools advertised for the turn by their harness display form", () => {
    const hint = cursorNativeExecRedirectHint(
      [{ name: "task" }],
      [{ name: "read_file", providerIdentifier: "opencodex" }],
    ) ?? "";
    expect(hint).toContain("`ocx_client_task`");
    expect(hint).toContain("`mcp_opencodex_read_file`");
    // No client tools at all, but configured MCP tools: those are the catalog, so name them.
    const mcpOnly = cursorNativeExecRedirectHint(undefined, [{ name: "read_file", providerIdentifier: "opencodex" }]) ?? "";
    expect(mcpOnly).toContain("`mcp_opencodex_read_file`");
    expect(mcpOnly).not.toContain("ocx_client_");
    expect(mcpOnly).not.toContain("shell_command");
    // Nothing advertised anywhere keeps the default bridge wording.
    expect(cursorNativeExecRedirectHint(undefined, [])).toBeUndefined();
    expect(cursorNativeExecRedirectHint([], [])).toBeUndefined();
  });

  test.each<[string, CatalogTool[] | undefined]>([
    ["an undefined catalog", undefined],
    ["an empty catalog", []],
    ["a bare exec_command bridge", [{ name: "exec_command" }]],
    ["a bare shell_command bridge next to client tools", [{ name: "task" }, { name: "shell_command" }]],
    ["unified exec next to client tools", [{ name: "task" }, { name: "exec", freeform: true }]],
  ])("keeps the default bridge wording for %s", (_name, tools) => {
    expect(cursorNativeExecRedirectHint(tools)).toBeUndefined();
  });

  test("lists namespaced tools by wire name and caps a long catalog", () => {
    const hint = cursorNativeExecRedirectHint([{ namespace: "mcp__docker", name: "ps" }, { name: "task" }]) ?? "";
    expect(hint).toContain("`mcp__docker__ps`");
    expect(hint).toContain("`ocx_client_task`");
    const capped = cursorNativeExecRedirectHint(Array.from({ length: 20 }, (_, index) => ({ name: `tool_${index}` }))) ?? "";
    expect(capped).toContain("`ocx_client_tool_15`");
    expect(capped).not.toContain("`ocx_client_tool_16`");
    expect(capped).toContain("(+4 more)");
  });

  test("without a hint the bridge wording is unchanged", () => {
    expect(nativeShellDisabledMessage()).toContain("shell_command");
    expect(nativeShellDisabledMessage("custom hint")).toBe("custom hint");
  });

  test("every denied native fs, shell, and fetch frame carries the hint and executes nothing", async () => {
    const hint = cursorNativeExecRedirectHint(delegationOnlyCatalog);
    expect(hint).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-hint-"));
    const existing = join(dir, "grounding.txt");
    const content = "HINT-GROUNDING-01 must not leak";
    writeFileSync(existing, content);
    const newPath = join(dir, "must-not-exist.txt");
    let fetchCalled = false;
    const deps = {
      unsafeAllowNativeLocalExec: false,
      nativeExecRedirectHint: hint,
      fetch: async () => {
        fetchCalled = true;
        return new Response("SHOULD_NOT_FETCH");
      },
    };
    const frames = [
      execMessage({ case: "readArgs", value: create(ReadArgsSchema, { path: existing }) }),
      execMessage({ case: "lsArgs", value: create(LsArgsSchema, { path: dir }) }),
      execMessage({ case: "grepArgs", value: create(GrepArgsSchema, { pattern: "HINT", path: dir }) }),
      execMessage({ case: "writeArgs", value: create(WriteArgsSchema, { path: newPath, fileText: "SHOULD_NOT_WRITE" }) }),
      execMessage({ case: "deleteArgs", value: create(DeleteArgsSchema, { path: existing }) }),
      execMessage({ case: "shellArgs", value: create(ShellArgsSchema, { command: "printf RAN_%s MARKER", workingDirectory: dir, hardTimeout: 2000 }) }),
      execMessage({ case: "shellStreamArgs", value: create(ShellArgsSchema, { command: "printf RAN_%s MARKER", workingDirectory: dir }) }),
      execMessage({ case: "backgroundShellSpawnArgs", value: create(BackgroundShellSpawnArgsSchema, { command: "printf RAN_%s MARKER", workingDirectory: dir }) }),
      execMessage({ case: "writeShellStdinArgs", value: create(WriteShellStdinArgsSchema, { shellId: 999, chars: "SHOULD_NOT_WRITE" }) }),
      execMessage({ case: "fetchArgs", value: create(FetchArgsSchema, { url: "https://metadata.invalid/latest" }) }),
    ];
    for (const frame of frames) {
      const text = stringifyReplies(await handleCursorNativeExec(frame, deps));
      expect(text).toContain("`ocx_client_task`");
      expect(text).toContain("Do NOT narrate");
      expect(text).not.toContain("shell_command");
      expect(text).not.toContain("exec_command");
      expect(text).not.toContain(content);
      // Denied shell frames echo the command text; only an executed command could produce the joined marker.
      expect(text).not.toContain("RAN_MARKER");
      expect(text).not.toContain("SHOULD_NOT_WRITE");
      expect(text).not.toContain("SHOULD_NOT_FETCH");
    }
    expect(fetchCalled).toBe(false);
    expect(existsSync(existing)).toBe(true);
    expect(existsSync(newPath)).toBe(false);
  });

  // The hint only helps if the live transport actually derives it per request. Asserting that
  // through LiveCursorTransport means stubbing a private method, which pins a seam rather than
  // the production path; read the production path instead. Both carried contributor PRs were
  // drafts whose hosted suite never ran, so nothing else proves this line exists.
  test("the live transport derives the hint from each turn's visible catalog", async () => {
    const { repoPath } = await import("../../helpers/repo-root");
    const source = readFileSync(repoPath("src/adapters/cursor/live-transport.ts"), "utf8");
    const assignment = source.match(/nativeExecRedirectHint:\s*cursorNativeExecRedirectHint\(([^)]*)\)/)?.[1];
    expect(assignment).toBeDefined();
    // Derived from THIS turn's visible catalog and advertised MCP tools, not from the raw request
    // or a value cached across turns: a catalog that gains or loses a shell alias must re-derive.
    expect(assignment).toContain("cursorVisibleTools");
    expect(assignment).toContain("mcpToolDefs");
    // Inside the per-request execContext assignment, not module or constructor scope.
    const perRequest = source.indexOf("rejectNativeFileMutations: cursorRequestAdvertisesApplyPatch");
    const hint = source.indexOf("nativeExecRedirectHint: cursorNativeExecRedirectHint");
    expect(perRequest).toBeGreaterThan(-1);
    expect(Math.abs(hint - perRequest)).toBeLessThan(400);
  });
});
