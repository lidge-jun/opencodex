import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";

import { NativeProfileManager } from "../../src/codex/native-profile-manager";
import { isCodexAccountUsable } from "../../src/codex/account-usability";
import { isMainAccountTokenLive, MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { loadConfig } from "../../src/config";
import {
  nativeMainStartupGateSnapshot,
  waitForNativeMainStartupGate,
} from "../../src/codex/native-profile-startup";
import type { NativeProfileKey, NativeProfileKeyProvider } from "../../src/codex/native-profile-types";
import { startServer } from "../../src/server";

const launchedAt = Number(process.env.NATIVE_STARTUP_LAUNCHED_AT ?? Date.now());

/**
 * When this child is slow, the parent only learns that it was slow. Name each phase so the
 * next slow run says WHERE — module load, `startServer`, or publication — instead of costing
 * another forensic round. Run 35118018849 reported a single elapsedMs=50728 with no way to
 * tell which of the three it was.
 */
const phase = (name: string): void => {
  console.info(`[native-startup] ${name} elapsedMs=${Date.now() - launchedAt}`);
};

phase("child-entry");

/**
 * A disposable port number is not a secret, so it must not travel through the production
 * secret writer. On Windows `atomicWriteFile` runs `hardenSecretPath(..., required: true)`
 * twice (`src/config/atomic-write.ts`), each of which can spawn PowerShell for SID resolution
 * and several `icacls` passes budgeted at 30s apiece — an ACL ceremony performed inside the
 * window the parent measures as "time to reach a port".
 *
 * The parent's actual contract is narrower (#1061): it treats existence as readiness and parses
 * immediately, so it must never observe the file between create and write. A rename within the
 * same directory gives exactly that — a reader sees either nothing or the whole document.
 */
function publishFixtureFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

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

if (process.env.OCX_TEST_NATIVE_STARTUP_FAIL_BEFORE_LISTEN === "1") {
  throw new Error("injected native startup failure before listen");
}

phase("start-server-begin");
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
phase("start-server-end");

// Test-only causal probe, normally disabled: a healthy process can publish later
// than the old generic deadline without changing recovery/admission behavior.
const portDelayMs = Number(process.env.OCX_TEST_NATIVE_STARTUP_DELAY_PORT_MS ?? 0);
if (!Number.isFinite(portDelayMs) || portDelayMs < 0 || portDelayMs > 60_000) {
  throw new Error("invalid native startup port delay fault");
}
if (portDelayMs > 0) await Bun.sleep(portDelayMs);
phase("port-publish-begin");
publishFixtureFile(portPath, String(server.port));
phase("port-published");
void waitForNativeMainStartupGate().then(() => {
  publishFixtureFile(settledPath, JSON.stringify({
    gate: nativeMainStartupGateSnapshot(),
    mainTokenLive: isMainAccountTokenLive(),
    mainUsable: isCodexAccountUsable(loadConfig(), MAIN_CODEX_ACCOUNT_ID),
  }));
}).catch((error: unknown) => {
  publishFixtureFile(settledPath, JSON.stringify({
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  }));
});

while (!existsSync(stopPath)) await Bun.sleep(10);
// Test-only stall, opt-in. It exists so the parent's bounded teardown can be shown
// firing (#1061) — without it the timeout branch is present but never exercised.
if (process.env.OCX_TEST_STALL_ON_STOP === "1") await new Promise(() => {});
await server.stop(true);
