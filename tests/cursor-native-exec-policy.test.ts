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
  ReadArgsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { handleCursorNativeExec } from "../src/adapters/cursor/native-exec";
import type { CursorTransportFactoryInput } from "../src/adapters/cursor/transport";
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
    ["no setting", baseProvider, "codex-sandbox"],
    ["explicit codex-sandbox", { ...baseProvider, nativeLocalExec: "codex-sandbox" }, "codex-sandbox"],
  ] as const)("resolves mode: %s", (_name, provider, expected) => {
    expect(resolveCursorNativeExecMode(provider)).toBe(expected);
  });

  // Default "codex-sandbox" (approve most): with neither field set, native local exec is APPROVED
  // for a request that declares the Codex danger-full-access sandbox and DENIED otherwise. Set
  // nativeLocalExec "off" to deny all, or "on" to always allow.
  test.each([
    ["unset default, declared full-access", true, true],
    ["unset default, not declared", false, false],
  ] as const)("unset provider approves declared full-access (%s)", (_name, declared, expected) => {
    expect(effectiveCursorNativeExecAllow(baseProvider, declared)).toBe(expected);
  });

  test.each([
    ["on", true, true],
    ["on", false, true],
    ["codex-sandbox", true, true],
    ["codex-sandbox", false, false],
    ["off", true, false],
    ["off", false, false],
  ] as const)("effective allow for mode=%s declared=%s is %s", (mode, declared, expected) => {
    expect(effectiveCursorNativeExecAllow({ ...baseProvider, nativeLocalExec: mode }, declared)).toBe(expected);
  });

  test("activates a real read only when codex-sandbox is declared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cursor-policy-"));
    const path = join(dir, "grounding.txt");
    const content = "C-ACTIVATION-GROUNDING-01 allowed content";
    writeFileSync(path, content);
    const provider = { ...baseProvider, nativeLocalExec: "codex-sandbox" } satisfies OcxProviderConfig;
    const readArgs = execMessage({ case: "readArgs", value: create(ReadArgsSchema, { path }) });

    const stringify = (value: unknown): string =>
      JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
    const allowed = decode((await handleCursorNativeExec(readArgs, {
      unsafeAllowNativeLocalExec: effectiveCursorNativeExecAllow(provider, true),
    }))[0]);
    expect(stringify(allowed)).toContain(content);

    const denied = decode((await handleCursorNativeExec(readArgs, {
      unsafeAllowNativeLocalExec: effectiveCursorNativeExecAllow(provider, false),
    }))[0]);
    const deniedText = stringify(denied);
    expect(deniedText).toContain("Cursor native local filesystem execution is not available for this request");
    expect(deniedText).not.toContain(content);
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
