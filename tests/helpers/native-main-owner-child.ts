import { appendFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { atomicWriteFileAsync } from "../../src/config";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { nativeMainOwnerSnapshot } from "../../src/codex/native-main-owner";
import { NativeProfileManager } from "../../src/codex/native-profile-manager";
import {
  nativeMainStartupGateSnapshot,
} from "../../src/codex/native-profile-startup";
import type { NativeProfileKey, NativeProfileKeyProvider } from "../../src/codex/native-profile-types";
import { drainAndShutdown } from "../../src/server";
import { startServer } from "../../src/server";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const codexHome = required("NATIVE_OWNER_CODEX_HOME");
const configDir = required("NATIVE_OWNER_CONFIG_DIR");
const keyBytes = Buffer.from(required("NATIVE_OWNER_KEY"), "base64");
const keyRef = process.env.NATIVE_OWNER_KEY_REF ?? "memory:native-owner-test";
const holdRecovery = process.env.NATIVE_OWNER_HOLD_RECOVERY === "1";
const holdSwitchBoundary = process.env.NATIVE_OWNER_HOLD_SWITCH_BOUNDARY;
const holdAuthTemp = process.env.NATIVE_OWNER_HOLD_AUTH_TEMP === "1";
const receiptPath = process.env.NATIVE_OWNER_RECEIPTS;

const emit = (value: Record<string, unknown>): void => {
  process.stdout.write(`@@native-owner@@${JSON.stringify(value)}\n`);
};

class EnvKeyProvider implements NativeProfileKeyProvider {
  async get(): Promise<NativeProfileKey> { return { keyRef, key: Buffer.from(keyBytes) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef, key: Buffer.from(keyBytes) }; }
}

let releaseRecovery!: () => void;
const recoveryBarrier = new Promise<void>(resolve => { releaseRecovery = resolve; });
let releaseSwitch!: () => void;
const switchBarrier = new Promise<void>(resolve => { releaseSwitch = resolve; });
const authTempBarrier = new Promise<void>(() => {});

function managerFor(home = codexHome): NativeProfileManager {
  const canonicalAuthPath = join(realpathSync.native(home), "auth.json");
  return new NativeProfileManager({
    codexHome: home,
    configDir,
    keyProvider: new EnvKeyProvider(),
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
    atomicWrite: holdAuthTemp
      ? (path, content) => atomicWriteFileAsync(path, content, undefined, {
          afterTempWrite: async tempPath => {
            if (resolve(path) !== resolve(canonicalAuthPath)) return;
            emit({ event: "auth-temp-written", name: basename(tempPath) });
            await authTempBarrier;
          },
        })
      : undefined,
    onSwitchBoundary: async boundary => {
      if (boundary !== holdSwitchBoundary) return;
      emit({ event: "switch-boundary", boundary });
      await switchBarrier;
    },
  });
}

const realFetch = globalThis.fetch;
const receipts: Array<{ url: string; authorization: string | null }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "chatgpt.com" || url.hostname === "direct.example.com") {
    const receipt = { url: url.href, authorization: request.headers.get("authorization") };
    receipts.push(receipt);
    if (receiptPath) appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    if (url.hostname === "direct.example.com") {
      return new Response([
        `data: ${JSON.stringify({
          id: "chatcmpl-owner-direct",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "direct" }, finish_reason: null }],
        })}`,
        `data: ${JSON.stringify({
          id: "chatcmpl-owner-direct",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: "resp_native_owner",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }
  return realFetch(request);
}) as typeof fetch;

const primaryManager = managerFor();
const servers: Array<ReturnType<typeof startServer> | null> = [];

function start(home = codexHome): ReturnType<typeof startServer> {
  const manager = home === codexHome ? primaryManager : managerFor(home);
  const server = startServer(0, {
    // The fixture builds its own CODEX_HOME/OPENCODEX_HOME under a temp root, so
    // real service-home evidence on the developer's machine is irrelevant to what
    // this child proves. Without this seam `startServer` inspects the INSTALLED
    // service instead: a machine running ocx as a launchd/systemd job reports
    // `ownership: "unknown"` for the fixture's homes (the job is loaded, but its
    // plist names other homes), native-main admission is fenced closed, and every
    // gate assertion here times out on `reason: "ownership-unknown"`.
    //
    // That made the suite pass in CI — where no service is installed — and fail on
    // exactly the maintainer machines that run the proxy they are developing,
    // including through the local preflight in scripts/release.ts. Matches the
    // seam tests/helpers/native-profile-startup-child.ts already uses.
    inspectNativeCodexOwnership: () => ({
      ownership: "owned",
      reason: "native-main owner test fixture",
    }),
    nativeMainStartup: {
      manager,
      owner: { retryMs: 25, hardenPath: async () => {} },
      beforeRecovery: holdRecovery
        ? async () => {
            emit({ event: "before-recovery", homeId: manager.context.homeId });
            await recoveryBarrier;
          }
        : undefined,
    },
    managementApi: { nativeProfileApi: { manager } },
  });
  servers.push(server);
  return server;
}

const primary = start();
emit({ event: "listening", pid: process.pid, port: primary.port, homeId: primaryManager.context.homeId });

let lastGate = "";
const gateTimer = setInterval(() => {
  const gate = nativeMainStartupGateSnapshot();
  const serialized = JSON.stringify(gate);
  if (serialized === lastGate) return;
  lastGate = serialized;
  emit({ event: "gate", gate, owner: nativeMainOwnerSnapshot(primaryManager.context) });
}, 10);
gateTimer.unref?.();

async function request(port: number, kind: string): Promise<{ status: number; text: string }> {
  if (kind === "health") {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return { status: response.status, text: await response.text() };
  }
  if (kind === "management-list" || kind === "management-doctor") {
    const path = kind === "management-doctor" ? "/api/native-main-profiles/doctor" : "/api/native-main-profiles";
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "x-opencodex-api-key": process.env.OPENCODEX_ADMIN_AUTH_TOKEN ?? "" },
    });
    return { status: response.status, text: await response.text() };
  }
  if (kind === "direct") {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-direct" },
      body: JSON.stringify({
        model: "direct/direct-model",
        messages: [{ role: "user", content: "direct" }],
        stream: false,
      }),
    });
    return { status: response.status, text: await response.text() };
  }
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: kind, stream: false }),
  });
  return { status: response.status, text: await response.text() };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let command: Record<string, unknown>;
  try { command = JSON.parse(line) as Record<string, unknown>; }
  catch { emit({ event: "fatal", message: "invalid command" }); continue; }
  const id = String(command.id ?? "");
  try {
    if (command.op === "snapshot") {
      emit({
        event: "reply",
        id,
        ok: true,
        gate: nativeMainStartupGateSnapshot(),
        owner: nativeMainOwnerSnapshot(primaryManager.context),
        upstreamCalls: receipts.length,
        lastReceipt: receipts.at(-1) ?? null,
      });
      continue;
    }
    if (command.op === "set-mode") {
      const mode = String(command.mode);
      if (mode !== "direct") {
        const response = await fetch(`http://127.0.0.1:${primary.port}/api/codex-auth/active`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-opencodex-api-key": process.env.OPENCODEX_ADMIN_AUTH_TOKEN ?? "",
          },
          body: JSON.stringify({ accountId: mode === "pool" ? "pool-a" : MAIN_CODEX_ACCOUNT_ID }),
        });
        if (!response.ok) throw new Error(await response.text());
      }
      emit({ event: "reply", id, ok: true });
      continue;
    }
    if (command.op === "request") {
      const index = Number(command.index ?? 0);
      const server = servers[index];
      if (!server) throw new Error("server is not running");
      const result = await request(server.port!, String(command.kind));
      emit({
        event: "reply",
        id,
        ok: true,
        ...result,
        upstreamCalls: receipts.length,
        lastReceipt: receipts.at(-1) ?? null,
      });
      continue;
    }
    if (command.op === "release-recovery") {
      releaseRecovery();
      emit({ event: "reply", id, ok: true });
      continue;
    }
    if (command.op === "release-switch") {
      releaseSwitch();
      emit({ event: "reply", id, ok: true });
      continue;
    }
    if (command.op === "start-extra-server") {
      const alias = String(command.codexHomeAlias ?? codexHome);
      const server = start(alias);
      emit({ event: "reply", id, ok: true, index: servers.length - 1, port: server.port });
      continue;
    }
    if (command.op === "stop-server") {
      const index = Number(command.index);
      const server = servers[index];
      if (server) {
        await server.stop(true);
        servers[index] = null;
      }
      emit({ event: "reply", id, ok: true });
      continue;
    }
    if (command.op === "stop") {
      for (let index = 0; index < servers.length; index += 1) {
        const server = servers[index];
        if (!server) continue;
        await server.stop(true);
        servers[index] = null;
      }
      emit({ event: "reply", id, ok: true, owner: nativeMainOwnerSnapshot(primaryManager.context) });
      emit({ event: "stopped" });
      break;
    }
    throw new Error("unknown command");
  } catch (error) {
    emit({ event: "reply", id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

clearInterval(gateTimer);
globalThis.fetch = realFetch;
keyBytes.fill(0);
lines.close();
