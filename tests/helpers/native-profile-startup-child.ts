import { appendFileSync, existsSync } from "node:fs";

import { NativeProfileManager } from "../../src/codex/native-profile-manager";
import { isCodexAccountUsable } from "../../src/codex/account-usability";
import { isMainAccountTokenLive, MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { atomicWriteFile, loadConfig } from "../../src/config";
import {
  nativeMainStartupGateSnapshot,
  waitForNativeMainStartupGate,
} from "../../src/codex/native-profile-startup";
import type { NativeProfileKey, NativeProfileKeyProvider } from "../../src/codex/native-profile-types";
import { startServer } from "../../src/server";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const codexHome = required("NATIVE_STARTUP_CODEX_HOME");
const configDir = required("NATIVE_STARTUP_CONFIG_DIR");
const keyBytes = Buffer.from(required("NATIVE_STARTUP_KEY"), "base64");
const keyRef = process.env.NATIVE_STARTUP_KEY_REF ?? "memory:startup-test";
const portPath = required("NATIVE_STARTUP_PORT");
const recoveryReleasePath = required("NATIVE_STARTUP_RECOVERY_RELEASE");
const settledPath = required("NATIVE_STARTUP_SETTLED");
const upstreamPath = required("NATIVE_STARTUP_UPSTREAM");
const stopPath = required("NATIVE_STARTUP_STOP");

class EnvKeyProvider implements NativeProfileKeyProvider {
  async get(): Promise<NativeProfileKey> { return { keyRef, key: Buffer.from(keyBytes) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef, key: Buffer.from(keyBytes) }; }
}

const manager = new NativeProfileManager({
  codexHome,
  configDir,
  keyProvider: new EnvKeyProvider(),
  hardenPath: async () => {},
  processProbe: async () => ({ status: "clear", count: 0 }),
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "chatgpt.com" && url.pathname.endsWith("/responses")) {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    appendFileSync(upstreamPath, `${JSON.stringify({ authorization: headers.get("authorization") })}\n`);
    return Response.json({
      id: "resp_startup_gate",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

const server = startServer(0, {
  inspectNativeCodexOwnership: () => ({
    ownership: "owned",
    reason: "native startup test fixture",
  }),
  nativeMainStartup: {
    manager,
    beforeRecovery: async () => {
      while (!existsSync(recoveryReleasePath)) await Bun.sleep(10);
    },
  },
  managementApi: { nativeProfileApi: { manager } },
});

// The parent treats existence as readiness and parses the port immediately. Publish
// through a rename so it can never observe the file between create and write.
atomicWriteFile(portPath, String(server.port));
// #1061: the parent parses this file as soon as it exists, so a partial write
// surfaces as `Unexpected EOF`. atomicWriteFile publishes through a rename, so a
// reader sees either nothing or the whole document.
void waitForNativeMainStartupGate().then(() => {
  atomicWriteFile(settledPath, JSON.stringify({
    gate: nativeMainStartupGateSnapshot(),
    mainTokenLive: isMainAccountTokenLive(),
    mainUsable: isCodexAccountUsable(loadConfig(), MAIN_CODEX_ACCOUNT_ID),
  }));
}).catch((error: unknown) => {
  atomicWriteFile(settledPath, JSON.stringify({
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  }));
});

while (!existsSync(stopPath)) await Bun.sleep(10);
// Test-only stall, opt-in. It exists so the parent's bounded teardown can be shown
// firing (#1061) — without it the timeout branch is present but never exercised.
if (process.env.OCX_TEST_STALL_ON_STOP === "1") await new Promise(() => {});
await server.stop(true);
