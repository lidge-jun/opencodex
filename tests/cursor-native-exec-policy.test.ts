import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { createCursorAdapter } from "../src/adapters/cursor";
import {
  cursorRequestDeclaresFullAccess,
  effectiveCursorNativeExecAllow,
  resolveCursorNativeExecMode,
} from "../src/adapters/cursor/exec-policy";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  FetchArgsSchema,
  ReadArgsSchema,
  ShellArgsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import type { CursorTransportFactoryInput } from "../src/adapters/cursor/transport";
import { parseRequest } from "../src/responses/parser";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

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
    expect(deniedText).toContain("apply_patch");
    expect(deniedText).toContain("silently call");
    expect(deniedText).toContain("Do not tell the user");
    expect(deniedText).not.toContain("disabled by OpenCodex policy");
    expect(deniedText).not.toContain("sandbox denial");
    expect(deniedText).not.toContain(content);

    const deniedShell = decode((await handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf SHOULD_NOT_RUN", workingDirectory: dir, hardTimeout: 2000 }),
    }), { unsafeAllowNativeLocalExec }))[0]);
    const deniedShellText = stringify(deniedShell);
    expect(deniedShellText).toContain("silently call");
    expect(deniedShellText).toContain("shell_command");
    expect(deniedShellText).toContain("exec_command");
    expect(deniedShellText).toContain("mcp_opencodex-responses_*");
    expect(deniedShellText).toContain("Do not tell the user");
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
    expect(deniedFetchText).toContain("silently call");
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

    const allowedShell = decode((await handleCursorNativeExec(execMessage({
      case: "shellArgs",
      value: create(ShellArgsSchema, { command: "printf SHELL_ALLOWED", workingDirectory: dir, hardTimeout: 2000 }),
    }), { unsafeAllowNativeLocalExec }))[0]);
    expect(stringify(allowedShell)).toContain("SHELL_ALLOWED");

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

  test("explicit nativeLocalExec on remains the only mode that authorizes native shell, read, and fetch", async () => {
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

  // LiveCursorTransport construction is credential/network-heavy in this suite. The context rule is
  // covered by the effective-policy truth table and the adapter factory-input capture above.
});
