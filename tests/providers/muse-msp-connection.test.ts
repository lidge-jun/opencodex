import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { readFile, writeFile, access, mkdtemp, rm, symlink } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MuseMspConnection } from "../../src/adapters/muse-msp/connection";
import { createMuseIsolatedSettings } from "../../src/adapters/muse-msp/isolated-settings";
import { initializeMuseMsp } from "../../src/adapters/muse-msp/handshake";
import { MuseApprovalCapture } from "../../src/adapters/muse-msp/approval";
import { MuseMspSession, type MuseMspRequester } from "../../src/adapters/muse-msp/session";
import { MuseMspInbox } from "../../src/adapters/muse-msp/inbox";
import { MusePendingToolResult } from "../../src/adapters/muse-msp/tool-result";
import { museContinuationOwner } from "../../src/adapters/muse-msp/owner";
import { MusePendingRegistry } from "../../src/adapters/muse-msp/pending-registry";
import { createMuseCaptureServer } from "../../src/adapters/muse-msp/capture-server";
import { MuseCaptureRendezvous } from "../../src/adapters/muse-msp/capture-rendezvous";
import { admitMuseCapturedTool } from "../../src/adapters/muse-msp/admit-tool";
import { museContinuation, museHistoryDigest } from "../../src/adapters/muse-msp/history";
import { parseRequest } from "../../src/responses/parser";
import { MuseResponsesHandoff } from "../../src/adapters/muse-msp/responses-handoff";
import { buildMuseCaptureCatalog } from "../../src/adapters/muse-msp/catalog";
import { museToolCallEvents } from "../../src/adapters/muse-msp/events";
import { buildResponseJSON } from "../../src/bridge/response-json";
import { bridgeToResponsesSSE } from "../../src/bridge/sse";
import { MuseTurnSegments } from "../../src/adapters/muse-msp/segment";
import { MuseTurnRegistry } from "../../src/adapters/muse-msp/turn-registry";
import { MuseMspRunner, museProjectedText } from "../../src/adapters/muse-msp/runner";
import { createMuseOpaqueBudgetFence } from "../../src/adapters/muse-msp/opaque-budget";
import { MuseBudgetSlot, withMuseBudgetLease, withMuseOpaqueSegment } from "../../src/adapters/muse-msp/budget-slot";
import { MuseConversationCheckpoint } from "../../src/adapters/muse-msp/conversation-checkpoint";
import { MuseConversationRegistry } from "../../src/adapters/muse-msp/conversation-registry";
import { museMspSubscriptionQuota, observeMuseMspSubscriptionQuota } from "../../src/adapters/muse-msp/subscription-usage";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createMuseMspAdapter } from "../../src/adapters/muse-msp/adapter";
import { createMuseNativeAdapter } from "../../src/adapters/muse-msp/native-adapter";
import { MuseNativeRuntimePool } from "../../src/adapters/muse-msp/runtime-pool";
import { museNativeRouteKey } from "../../src/adapters/muse-msp/route-key";
import { currentMuseNativeRuntimePool, withMuseNativeRuntimePool } from "../../src/adapters/muse-msp/runtime-scope";
import { findMuseExecutable } from "../../src/adapters/muse-msp/executable";
import { museCaptureInvocation } from "../../src/adapters/muse-msp/capture-invocation";
import { createMuseNativeProviderAdapter } from "../../src/adapters/muse-msp/provider-adapter";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { openMuseCaptureChannel } from "../../src/adapters/muse-msp/capture-channel";
import { sendMuseCapture } from "../../src/adapters/muse-msp/capture-channel-client";
import { bindRouteReasoningReplayScope } from "../../src/server/responses/core-replay";
import { getAdapterDefinition } from "../../src/adapters/registry";
import { handleResponses } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig } from "../../src/types";
import { MuseMspHost } from "../../src/adapters/muse-msp/host";
import type { OcxParsedRequest } from "../../src/types";

describe("Muse MSP owned child", () => {
  test("registered Muse route supports developer-prompt projection", () => {
    expect(getProviderRegistryEntry("muse-code")).toMatchObject({ adapter: "muse-msp", authKind: "key", keyOptional: true });
  });
  test("native provider rejects missing server scope and unidentifiable clients", async () => {
    const adapter = createMuseNativeProviderAdapter("muse-code", { projectDeveloperPrompt: true });
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    const translatorBudget = createTranslatorBudget(), pool = new MuseNativeRuntimePool();
    const invoke = async () => { const events: import("../../src/types").AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget }, event => events.push(event)); return events; };
    try {
      expect(await invoke()).toContainEqual(expect.objectContaining({ type: "error", code: "server_scope_unavailable" }));
      const events = await withMuseNativeRuntimePool(pool, invoke);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "client_identity_required" }));
    } finally { await pool.close(); translatorBudget.dispose(); }
  });
  test("selects the proper capture entrypoint for source and standalone builds", () => {
    expect(museCaptureInvocation(false).args[0]).toEndWith("capture-child.ts");
    expect(museCaptureInvocation(true)).toEqual({ executable: process.execPath, args: ["__muse-mcp"] });
  });
  test("resolves a versioned Windows install without executing its command shim", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "ocx-muse-discovery-")), directory = join(root, "Programs", "muse");
    const { mkdir } = await import("node:fs/promises");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, ".muse-version"), "1.2.3-R123.4\n");
      await writeFile(join(directory, "muse-bin-1.2.3-R123.4.exe"), "fixture");
      expect(findMuseExecutable({ PATH: "", LOCALAPPDATA: root }, "win32")).toBe(join(directory, "muse-bin-1.2.3-R123.4.exe"));
      await writeFile(join(directory, ".muse-version"), "../../outside");
      expect(findMuseExecutable({ PATH: "", LOCALAPPDATA: root }, "win32")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("concurrent requests retain their own server pool scope", async () => {
    const first = new MuseNativeRuntimePool(), second = new MuseNativeRuntimePool();
    try {
      const observed = await Promise.all([first, second].map(pool => withMuseNativeRuntimePool(pool, async () => {
        await Promise.resolve(); return currentMuseNativeRuntimePool();
      })));
      expect(observed).toEqual([first, second]);
      expect(currentMuseNativeRuntimePool()).toBeUndefined();
    } finally { await Promise.all([first.close(), second.close()]); }
  });
  test("binds a native runtime to the exact restricted launch configuration", () => {
    const base = { providerId: "muse-code", profileRevision: "v1", executable: process.execPath, cwd: process.cwd(), args: ["serve"], env: { HOME: "test-home", PATH: "test-path" } };
    const key = museNativeRouteKey(base);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(museNativeRouteKey({ ...base, env: { PATH: "test-path", HOME: "test-home" } })).toBe(key);
    expect(museNativeRouteKey({ ...base, args: ["serve", "--preset", "empty"] })).not.toBe(key);
    expect(museNativeRouteKey({ ...base, profileRevision: "v2" })).not.toBe(key);
    expect(museNativeRouteKey({ ...base, env: { ...base.env, HOME: "other-home" } })).not.toBe(key);
    expect(() => museNativeRouteKey({ ...base, env: { ...base.env, META_API_KEY: "dummy" } })).toThrow("invalid_native_environment");
    expect(() => museNativeRouteKey({ ...base, env: { PATH: "one", Path: "two" } })).toThrow("invalid_native_environment");
  });
  test("server pool shares a route and drains its owned runners once", async () => {
    const pool = new MuseNativeRuntimePool(1);
    let created = 0, closed = 0, release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const create = () => { created++; return { async run() { return []; }, onResponseRendered() {}, async close() { closed++; await waiting; } }; };
    const first = pool.acquire("route-generation", create, "target");
    expect(pool.acquire("route-generation", create, "target")).toBe(first);
    expect(created).toBe(1);
    expect(() => pool.acquire("route-generation", create, "changed-target")).toThrow("runtime_binding_mismatch");
    expect(() => pool.acquire("different-route", create, "target")).toThrow("unavailable_runtime");
    const close = pool.close(); expect(pool.close()).toBe(close);
    expect(() => pool.acquire("route-generation", create, "target")).toThrow("unavailable_runtime");
    await Promise.resolve(); expect(closed).toBe(1);
    release(); await close; expect(closed).toBe(1);
  });

  test("retiring a route blocks reuse until its runner has stopped", async () => {
    const pool = new MuseNativeRuntimePool(1);
    let release!: () => void, closed = 0;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const create = () => ({ async run() { return []; }, onResponseRendered() {}, async close() { closed++; await wait; } });
    pool.acquire("route", create, "target");
    const retired = pool.retire("route");
    expect(() => pool.acquire("route", create, "target")).toThrow("unavailable_runtime");
    const shutdown = pool.close();
    release(); await retired; await shutdown;
    expect(closed).toBe(1);
  });

  test("a failed retirement never makes the key reusable", async () => {
    const pool = new MuseNativeRuntimePool(1);
    const create = () => ({ async run() { return []; }, onResponseRendered() {}, async close() { throw new Error("private"); } });
    pool.acquire("route", create, "target");
    let failed = false; try { await pool.retire("route"); } catch { failed = true; }
    expect(failed).toBe(true);
    expect(() => pool.acquire("route", create, "target")).toThrow("unavailable_runtime");
    let shutdownFailed = false; try { await pool.close(); } catch { shutdownFailed = true; }
    expect(shutdownFailed).toBe(true);
  });

  test("route changes drain the old runner and reject late stale generations", async () => {
    const pool = new MuseNativeRuntimePool(2);
    let release!: () => void, closedOld = 0, closedNew = 0;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const old = () => ({ async run() { return []; }, onResponseRendered() {}, async close() { closedOld++; await wait; } });
    const fresh = () => ({ async run() { return []; }, onResponseRendered() {}, async close() { closedNew++; } });
    const first = await pool.acquireRoute("route", 1, "generation-one", old, "target-one");
    const replacement = pool.acquireRoute("route", 2, "generation-two", fresh, "target-two");
    const stale = pool.acquireRoute("route", 1, "generation-one", old, "target-one").then(() => false, () => true);
    await Promise.resolve(); await Promise.resolve();
    expect(closedOld).toBe(1);
    release();
    expect(await replacement).not.toBe(first); expect(await stale).toBe(true);
    await pool.close(); expect(closedOld).toBe(1); expect(closedNew).toBe(1);
  });
  test("projects subscription usage with the host observation time and no tier", () => {
    const observedAtMs = 1_800_000_000_000;
    const quota = museMspSubscriptionQuota({ usage: { tier: "private-tier", observedAtMs,
      window: { usedPercent: 12, resetsAtMs: 1_800_000_100_000, windowDurationMins: 300 },
      weekly: { usedPercent: 34, resetsAtMs: 1_800_000_200_000 } } });
    expect(quota).toMatchObject({ updatedAt: observedAtMs, fiveHourPercent: 12, weeklyPercent: 34,
      fiveHourResetAt: 1_800_000_100_000, weeklyResetAt: 1_800_000_200_000 });
    expect(JSON.stringify(quota)).not.toContain("private-tier");
    expect(museMspSubscriptionQuota({})).toBeNull();
    expect(museMspSubscriptionQuota({ usage: { observedAtMs: 0, window: { usedPercent: 1 } } })).toBeNull();
  });

  test("observes host quota without losing a completed response when quota is absent", async () => {
    for (const absent of [false, true]) {
      const quotas: import("../../src/providers/quota-types").ProviderQuota[] = [];
      const scopes: { owner: string; invalidated: AbortSignal }[] = [];
      const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: [join(import.meta.dir, "../fixtures/muse-msp-fake-text-host.ts")],
        hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...(absent ? { OCX_TEST_NO_QUOTA: "1" } : {}) }, cwd: process.cwd(),
        captureExecutable: process.execPath, captureArgs: [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")], observeSubscriptionQuota: (quota, scope) => { quotas.push(quota); scopes.push(scope); } });
      const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
      parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      try {
        const events = await runner.run(parsed, { timeoutMs: 5000 });
        expect(events.some(event => event.type === "done")).toBe(true);
        expect(quotas).toHaveLength(absent ? 0 : 1);
        if (!absent) {
          expect(quotas[0]).toMatchObject({ updatedAt: 1800000000000, fiveHourPercent: 12, weeklyPercent: 34 });
          expect(scopes[0]!.owner).toBe(museContinuationOwner(parsed));
          expect(scopes[0]!.invalidated.aborted).toBe(true);
        }
      } finally { await runner.close(); }
    }
  });

  test("ignores quota lookup errors and observer errors", async () => {
    await expect(observeMuseMspSubscriptionQuota({ async request() { throw new Error("private host error"); } }, () => { throw new Error("unexpected"); }, { timeoutMs: 10 })).resolves.toBeUndefined();
    await expect(observeMuseMspSubscriptionQuota({ async request() { return { usage: { observedAtMs: 1800000000000, weekly: { usedPercent: 1 } } }; } },
      () => { throw new Error("private observer error"); }, { timeoutMs: 10 })).resolves.toBeUndefined();
  });
  test("projects text-only parts in order only with explicit projection", () => {
    const parts = [{ type: "text", text: "first" }, { type: "text", text: " second" }];
    expect(museProjectedText(parts, true)).toBe("first second");
    expect(museProjectedText(parts, false)).toBeUndefined();
    expect(museProjectedText([{ type: "text", text: "first" }, { type: "image", url: "fixture" }], true)).toBeUndefined();
    expect(museProjectedText([], true)).toBeUndefined();
  });
  test("parallel approvals are exposed one at a time and preserve both results", async () => {
    const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: [join(import.meta.dir, "../fixtures/muse-msp-fake-mcp-host.ts")],
      hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OCX_TEST_PARALLEL: "1" }, cwd: process.cwd(),
      captureExecutable: process.execPath, captureArgs: [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")] });
    const body = { model: "test", parallel_tool_calls: true, input: [{ role: "user", content: "edit" }],
      tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const bind = (input: unknown[]) => {
      const parsed = parseRequest({ ...body, input });
      parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return parsed;
    };
    const callFrom = (events: import("../../src/types").AdapterEvent[]) =>
      (buildResponseJSON(events, "test", { freeformToolNames: new Set(["apply_patch"]) }).output as Array<Record<string, unknown>>)
        .find(item => item.type === "custom_tool_call")!;
    try {
      const first = callFrom(await runner.run(bind(body.input), { timeoutMs: 5000 }));
      expect(first.input).toBe("patch text");
      const firstResult = { type: "custom_tool_call_output", call_id: first.call_id, output: "result one" };
      const secondInput = [...body.input, first, firstResult];
      const second = callFrom(await runner.run(bind(secondInput), { timeoutMs: 5000 }));
      expect(second.input).toBe("patch two");
      expect(second.call_id).not.toBe(first.call_id);
      const secondResult = { type: "custom_tool_call_output", call_id: second.call_id, output: "result two" };
      const events = await runner.run(bind([...secondInput, second, secondResult]), { timeoutMs: 5000 });
      expect(events).toContainEqual({ type: "text_delta", text: "result one|result two" });
    } finally { await runner.close(); }
  });

  test("retained runner waits for the matching rendered response before accepting the next user turn", async () => {
    const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: [join(import.meta.dir, "../fixtures/muse-msp-fake-text-host.ts")],
      hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OCX_TEST_EXPECT_CLIENT_HINT: "1" }, cwd: process.cwd(), captureExecutable: process.execPath, captureArgs: [], retainPlainTextTurns: true, maxOwnedHosts: 1 });
    const bind = (input: unknown[], thread = "thread") => {
      const parsed = parseRequest({ model: "test", input, tools: [{ type: "custom", name: "exec", description: "Codex client tools", format: { type: "text" } }] });
      parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: thread, current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return parsed;
    };
    const user = { role: "user", content: "first" }, first = bind([user]);
    try {
      const events = await runner.run(first, { timeoutMs: 5000 });
      const rendered = buildResponseJSON(events, "test");
      const next = bind([user, ...(rendered.output as unknown[]), { role: "user", content: "second" }]);
      await expect(runner.run(bind([{ role: "user", content: "another" }], "another-thread"), { timeoutMs: 5000 })).rejects.toThrow("unavailable_turn");
      await expect(runner.run(next, { timeoutMs: 5000 })).rejects.toThrow("unavailable_conversation");
      runner.onResponseRendered(bind([user]), rendered);
      await expect(runner.run(next, { timeoutMs: 5000 })).rejects.toThrow("unavailable_conversation");
      runner.onResponseRendered(bind([{ role: "user", content: "other" }]), rendered);
      await expect(runner.run(next, { timeoutMs: 5000 })).rejects.toThrow("unavailable_conversation");
      runner.onResponseRendered(first, rendered);
      await expect(runner.run(bind([{ role: "user", content: "another" }], "another-thread"), { timeoutMs: 5000 })).rejects.toThrow("unavailable_turn");
      const secondEvents = await runner.run(next, { timeoutMs: 5000 });
      expect(secondEvents).toContainEqual({ type: "text_delta", text: "answer 2" });
      runner.onResponseRendered(next, buildResponseJSON(secondEvents, "test"));
    } finally { await runner.close(); }
  });

  test.each([false, true])("runTurn rendered-response callback cannot mutate the client response (stream=%s)", async stream => {
    const definition = getAdapterDefinition("claude-cli")!, original = definition.create, releaseSpendHome = acquireOwnedSpendHome();
    let observed = "";
    definition.create = (() => ({ name: "render-fixture", buildRequest() { throw new Error("unused"); }, async *parseStream() { throw new Error("unused"); },
      async runTurn(_parsed, _incoming, emit) { emit({ type: "text_delta", text: "visible answer" }); emit({ type: "done" }); },
      onResponseRendered(_parsed, response) { observed = JSON.stringify(response); response.output = []; throw new Error("synthetic callback failure"); },
    })) as typeof definition.create;
    const config = { port: 0, defaultProvider: "claude-cli", providers: { "claude-cli": {
      adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "fixture-key", selectedModels: ["claude-sonnet-5-5"] } } } as OcxConfig;
    try {
      const request = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-cli/claude-sonnet-5-5", input: "hello", stream }) });
      const result = await handleResponses(request, config, { model: "", provider: "" });
      const wire = await result.text();
      expect(observed).toContain("visible answer");
      expect(wire).toContain("visible answer");
      expect(stream ? wire.includes("response.completed") : JSON.parse(wire).status === "completed").toBe(true);
    } finally { definition.create = original; releaseSpendHome(); }
  });

  test("experimental gate receives the real Responses handler budget", async () => {
    const definition = getAdapterDefinition("claude-cli")!, original = definition.create;
    const releaseSpendHome = acquireOwnedSpendHome();
    const slot = new MuseBudgetSlot();
    let observedBudget = false, sent = 0, gateError = "";
    const adapter = createMuseMspAdapter({ async run() { return [{ type: "text_delta", text: "mock result" }, { type: "done" }]; } }, 5000, {
      run: async (incoming, execute) => withMuseBudgetLease(slot, incoming, "muse|mock", async lease => {
        observedBudget = !!incoming.sendBudget;
        try { lease.admit(); } catch (error) { gateError = error instanceof Error ? `${error.name}: ${error.message}` : "unknown"; throw error; }
        sent++;
        return execute();
      }),
    });
    expect(adapter.reportsPhysicalSends).toBe(true);
    definition.create = (() => adapter) as typeof definition.create;
    const config = { port: 0, defaultProvider: "claude-cli", providers: { "claude-cli": {
      adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "fixture-key", selectedModels: ["claude-sonnet-5-5"] } } } as OcxConfig;
    try {
      const request = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-cli/claude-sonnet-5-5", input: "hello", stream: false }) });
      const response = await handleResponses(request, config, { model: "", provider: "" });
      const result = await response.text();
      expect(gateError).toBe("");
      expect(result).toContain("mock result");
      expect(observedBudget).toBe(true);
      expect(sent).toBe(1);
    } finally { definition.create = original; slot.close(); releaseSpendHome(); }
  });

  test("account-login probe accepts only the account login lane", async () => {
    const config = { executable: process.execPath, args: [join(import.meta.dir, "../fixtures/muse-msp-fake-host.ts")],
      cwd: process.cwd(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OCX_FAKE_ACCOUNT_STATE: "accountLogin" } };
    const host = await MuseMspHost.start(config, { timeoutMs: 5000, requireAccountLogin: true });
    await host.checkAccountLogin({ timeoutMs: 1000 });
    await host.connection.request("fixture/account-change-silent", {}, { timeoutMs: 1000 });
    let refusal: unknown;
    try { await host.checkAccountLogin({ timeoutMs: 5000 }); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("account_login_required");
    expect(host.invalidated.aborted).toBe(true);
    await host.close();
    for (const state of ["apiKey", "envKey", "loggedOut", "futureUnknown"]) {
      await expect(MuseMspHost.start({ ...config, env: { ...config.env, OCX_FAKE_ACCOUNT_STATE: state } },
        { timeoutMs: 5000, requireAccountLogin: true })).rejects.toThrow("account_login_required");
    }
    await expect(MuseMspHost.start({ ...config, env: { ...config.env, OCX_FAKE_EXPERIMENTAL: "disabled" } },
      { timeoutMs: 5000, requireAccountLogin: true })).rejects.toThrow("account_probe_unavailable");
  });

  test("invalidates a host when its account changes", async () => {
    const host = await MuseMspHost.start({ executable: process.execPath, args: [join(import.meta.dir, "../fixtures/muse-msp-fake-host.ts")],
      cwd: process.cwd(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }, { timeoutMs: 5000 });
    try {
      await host.connection.request("fixture/account-change", {}, { timeoutMs: 1000 });
      for (let i = 0; i < 100 && !host.invalidated.aborted; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(host.invalidated.aborted).toBe(true);
      await expect(host.inbox.take(() => true, { timeoutMs: 100 })).rejects.toThrow("host_account_changed");
    } finally { await host.close(); }
  });

  test("invalidates a fake host after an observed model retry is scheduled", async () => {
    const host = await MuseMspHost.start({ executable: process.execPath, args: [join(import.meta.dir, "../fixtures/muse-msp-fake-host.ts")],
      cwd: process.cwd(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }, { timeoutMs: 5000 });
    try {
      await host.connection.request("fixture/retry", {}, { timeoutMs: 1000 });
      for (let i = 0; i < 100 && !host.invalidated.aborted; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(host.invalidated.aborted).toBe(true);
      await expect(host.inbox.take(() => true, { timeoutMs: 100 })).rejects.toThrow("host_retry_scheduled");
    } finally { await host.close(); }
  });

  test.each(["fixture/view-gap", "fixture/view-unavailable"])("invalidates a host whose view may have lost events: %s", async method => {
    const host = await MuseMspHost.start({ executable: process.execPath, args: [join(import.meta.dir, "../fixtures/muse-msp-fake-host.ts")],
      cwd: process.cwd(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }, { timeoutMs: 5000 });
    try {
      await host.connection.request(method, {}, { timeoutMs: 1000 });
      for (let i = 0; i < 100 && !host.invalidated.aborted; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(host.invalidated.aborted).toBe(true);
      await expect(host.inbox.take(() => true, { timeoutMs: 100 })).rejects.toThrow("host_view_unavailable");
    } finally { await host.close(); }
  });

  test("real Responses handler supplies its send budget to an injected adapter", async () => {
    const definition = getAdapterDefinition("claude-cli")!;
    const original = definition.create;
    let runnerCalls = 0, sawBudget = false;
    const adapter = createMuseMspAdapter({ async run() { runnerCalls++; return [{ type: "done" }]; } });
    definition.create = (() => ({ ...adapter, async runTurn(parsed, incoming, emit) {
      sawBudget = incoming.sendBudget !== undefined;
      await adapter.runTurn!(parsed, incoming, emit);
    } })) as typeof definition.create;
    const config = { port: 0, defaultProvider: "claude-cli", providers: { "claude-cli": {
      adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "fixture-key", selectedModels: ["claude-sonnet-5-5"] } } } as OcxConfig;
    try {
      const request = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-cli/claude-sonnet-5-5", input: "hello", stream: false }) });
      const response = await handleResponses(request, config, { model: "", provider: "" });
      const body = await response.text();
      expect(sawBudget).toBe(true);
      expect(runnerCalls).toBe(0);
      expect(body).toContain("muse_send_budget_unsupported");
    } finally { definition.create = original; }
  });

  test("unregistered adapter emits safe errors and preserves runner events", async () => {
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    const budget = createTranslatorBudget();
    const incoming = { headers: new Headers(), translatorBudget: budget };
    const collected: import("../../src/types").AdapterEvent[] = [];
    try {
      const adapter = createMuseMspAdapter({ async run() { return [{ type: "text_delta", text: "hello" }, { type: "done" }]; } });
      expect(adapter.reportsPhysicalSends).toBeUndefined();
      await adapter.runTurn!(parsed, incoming, event => collected.push(event));
      expect(collected).toEqual([{ type: "text_delta", text: "hello" }, { type: "done" }]);
      const failed = createMuseMspAdapter({ async run() { throw new Error("private host details"); } });
      collected.length = 0;
      await failed.runTurn!(parsed, incoming, event => collected.push(event));
      expect(collected).toEqual([expect.objectContaining({ type: "error", code: "muse_session_failed", retryable: false })]);
      expect(JSON.stringify(collected)).not.toContain("private host details");
      collected.length = 0;
      await adapter.runTurn!(parsed, { ...incoming, sendBudget: {} as never }, event => collected.push(event));
      expect(collected).toEqual([expect.objectContaining({ type: "error", code: "muse_send_budget_unsupported" })]);
    } finally { budget.dispose(); }
  });

  test("invalidates the mock host on a model route change notification", async () => {
    const host = await MuseMspHost.start({ executable: process.execPath, args: [join(import.meta.dir, "../fixtures/muse-msp-fake-host.ts")],
      cwd: process.cwd(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }, { timeoutMs: 5000 });
    try {
      await MuseMspSession.open(host.connection, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
      await host.connection.request("fixture/invalidate", {}, { timeoutMs: 1000 });
      for (let i = 0; i < 100 && !host.invalidated.aborted; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(host.invalidated.aborted).toBe(true);
      await expect(host.inbox.take(() => true, { timeoutMs: 100 })).rejects.toThrow("host_route_changed");
    } finally { await host.close(); }
  });

  test("cleans up a pending tool turn immediately when its host invalidates", async () => {
    const turns = new MuseTurnRegistry(), registry = new MusePendingRegistry(), abort = new AbortController();
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
    let closes = 0, finished!: () => void;
    const closed = new Promise<void>(resolve => { finished = resolve; });
    try {
      await turns.start(parsed, { handoff: new MuseResponsesHandoff(registry), invalidated: abort.signal,
        segments: { async next() { return [{ type: "tool_call_start", id: "id", name: "tool" }, { type: "done" }]; } },
        async close() { closes++; finished(); } }, { timeoutMs: 1000 });
      abort.abort(); await closed;
      await turns.close();
      expect(closes).toBe(1); expect([...turns.owners()]).toHaveLength(0);
    } finally { await turns.close(); registry.close(); }
  });

  test("refuses a continuation before submitting a result if the owner host is invalid", async () => {
    const turns = new MuseTurnRegistry(), registry = new MusePendingRegistry();
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
    let valid = true, closes = 0;
    const handoff = new MuseResponsesHandoff(registry);
    await turns.start(parsed, { handoff, segments: { async next() { return [{ type: "tool_call_start", id: "id", name: "tool" }, { type: "done" }]; } },
      isValid: () => valid, async close() { closes++; } }, { timeoutMs: 1000 });
    valid = false;
    await expect(turns.continue(parsed, { timeoutMs: 1000 })).rejects.toThrow("unavailable_turn");
    expect(closes).toBe(1);
    await turns.close(); registry.close();
  });

  test("does not emit incremental text after its host becomes invalid", async () => {
    const turns = new MuseTurnRegistry(), registry = new MusePendingRegistry();
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
    let valid = true, closes = 0;
    const chunks: string[] = [];
    const pending = turns.start(parsed, { handoff: new MuseResponsesHandoff(registry), isValid: () => valid,
      async close() { closes++; }, segments: { async next(_parsed, options) {
        options.onText?.("first"); valid = false; options.onText?.("late");
        return [{ type: "done" }];
      } } }, { timeoutMs: 1000, onText: text => chunks.push(text) });
    await expect(pending).rejects.toThrow("turn_expired");
    expect(chunks).toEqual(["first"]); expect(closes).toBe(1);
    await turns.close(); registry.close();
  });

  test("runner closes and waits for a host still initializing", async () => {
    const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
      hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, cwd: process.cwd(), captureExecutable: process.execPath, captureArgs: [] });
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
    const first = runner.run(parsed, { timeoutMs: 5000 });
    const rejection = first.then(() => false, () => true);
    await expect(runner.run(parsed, { timeoutMs: 5000 })).rejects.toThrow("unavailable_turn");
    await runner.close();
    expect(await rejection).toBe(true);
    await expect(runner.run(parsed, { timeoutMs: 5000 })).rejects.toThrow("unavailable_continuation");
  });

  test("opt-in developer projection uses an isolated settings directory", async () => {
    const marker = "first developer\n\nsecond developer";
    const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: [join(import.meta.dir, "../fixtures/muse-msp-fake-mcp-host.ts")],
      hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OCX_TEST_EXPECT_DEVELOPER: marker, OCX_TEST_EXPECT_USER: "first user\n\nsecond user" }, cwd: process.cwd(),
      captureExecutable: process.execPath, captureArgs: [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")], projectDeveloperPrompt: true });
    const body = { model: "test", input: [{ role: "developer", content: "first developer" }, { role: "developer", content: "second developer" },
      { role: "user", content: "first user" }, { role: "user", content: "second user" }],
      tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const bind = (p: OcxParsedRequest) => { p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } }; return p; };
    const budget = createTranslatorBudget(), adapter = createMuseMspAdapter(runner, 5000);
    const invoke = async (parsed: OcxParsedRequest) => {
      const out: import("../../src/types").AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: budget }, event => out.push(event));
      return out;
    };
    try {
      const events = await invoke(bind(parseRequest(body)));
      const response = buildResponseJSON(events, "test", { freeformToolNames: new Set(["apply_patch"]) });
      const call = (response.output as Array<Record<string, unknown>>).find(item => item.type === "custom_tool_call")!;
      const output = { type: "custom_tool_call_output", call_id: call.call_id, output: "done" };
      expect(await runner.run(bind(parseRequest({ ...body, input: [...body.input, call, output] })), { timeoutMs: 5000 })).toEqual([{ type: "text_delta", text: "done" }, { type: "done" }]);
      const interleaved = bind(parseRequest({ ...body, input: [{ role: "user", content: "u" }, { role: "developer", content: "d" }, { role: "user", content: "u2" }] }));
      const { projectInitialMuseHistory } = await import("../../src/adapters/muse-msp/initial-history");
      expect(projectInitialMuseHistory(interleaved.context, true)).toEqual({ developer: "d", user: "u\n\nu2" });
    } finally { await runner.close(); budget.dispose(); }
  });

  test("mock runner preserves a pending tool result when its dispatch budget is exhausted", async () => {
    const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: [join(import.meta.dir, "../fixtures/muse-msp-fake-mcp-host.ts")],
      hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, cwd: process.cwd(),
      captureExecutable: process.execPath, captureArgs: [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")] });
    const body = { model: "test", input: [{ role: "user", content: "edit" }], tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const bind = (p: OcxParsedRequest) => { p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } }; return p; };
    const policy = { maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 };
    const spent = createRequestExecutionBudget(policy, "muse-mock-spent"), fresh = createRequestExecutionBudget(policy, "muse-mock-fresh");
    const translatorBudget = createTranslatorBudget();
    const initialFence = createMuseOpaqueBudgetFence({ headers: new Headers(), translatorBudget, sendBudget: spent }, "muse|fake");
    const deniedFence = createMuseOpaqueBudgetFence({ headers: new Headers(), translatorBudget, sendBudget: spent }, "muse|fake");
    const retryFence = createMuseOpaqueBudgetFence({ headers: new Headers(), translatorBudget, sendBudget: fresh }, "muse|fake");
    try {
      const events = await runner.run(bind(parseRequest(body)), { timeoutMs: 5000, beforeDispatch: initialFence.admit });
      initialFence.close();
      const response = buildResponseJSON(events, "test", { freeformToolNames: new Set(["apply_patch"]) });
      const call = (response.output as Array<Record<string, unknown>>).find(item => item.type === "custom_tool_call")!;
      expect(call).toMatchObject({ name: "apply_patch", input: "patch text" });
      const output = { type: "custom_tool_call_output", call_id: call.call_id, output: "client result" };
      const next = bind(parseRequest({ ...body, input: [...body.input, call, output] }));
      await expect(runner.run(next, { timeoutMs: 5000, beforeDispatch: deniedFence.admit })).rejects.toThrow();
      expect(await runner.run(next, { timeoutMs: 5000, beforeDispatch: retryFence.admit })).toEqual([{ type: "text_delta", text: "client result" }, { type: "done" }]);
      await expect(runner.run(next, { timeoutMs: 5000 })).rejects.toThrow("unavailable_turn");
    } finally { initialFence.close(); deniedFence.close(); retryFence.close(); await runner.close(); translatorBudget.dispose(); }
  });

  test("refuses a tool result if the host credential lane changed silently", async () => {
    const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: [join(import.meta.dir, "../fixtures/muse-msp-fake-mcp-host.ts")],
      hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OCX_TEST_ACCOUNT_SWITCH: "1" }, cwd: process.cwd(),
      captureExecutable: process.execPath, captureArgs: [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")], requireAccountLogin: true });
    const body = { model: "test", input: [{ role: "user", content: "edit" }], tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const bind = (p: OcxParsedRequest) => { p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } }; return p; };
    try {
      const events = await runner.run(bind(parseRequest(body)), { timeoutMs: 5000 });
      const response = buildResponseJSON(events, "test", { freeformToolNames: new Set(["apply_patch"]) });
      const call = (response.output as Array<Record<string, unknown>>).find(item => item.type === "custom_tool_call")!;
      const next = bind(parseRequest({ ...body, input: [...body.input, call, { type: "custom_tool_call_output", call_id: call.call_id, output: "result" }] }));
      let committed = false, failure: unknown;
      try { await runner.run(next, { timeoutMs: 5000, beforeResultCommit: () => { committed = true; } }); } catch (error) { failure = error; }
      expect((failure as Error).message).toContain("account_login_required");
      expect(committed).toBe(false);
      const restarted = await runner.run(bind(parseRequest(body)), { timeoutMs: 5000 });
      expect(restarted.some(event => event.type === "tool_call_start")).toBe(true);
    } finally { await runner.close(); }
  });

  test("native adapter refuses an enforced spend limit before dispatch, including a policy change during startup", async () => {
    let enforced = true, calls = 0, sends = 0, changeAtDispatch = false;
    const adapter = createMuseNativeAdapter({
      async run(_parsed, options) {
        calls++;
        if (changeAtDispatch) enforced = true;
        options.beforeDispatch?.();
        sends++;
        return [{ type: "done" }];
      },
      onResponseRendered() {},
    }, "muse|spend-test");
    const translatorBudget = createTranslatorBudget();
    const budget = createRequestExecutionBudget(undefined, "strict-spend", {
      get enforced() { return enforced; }, charge: () => true, refund: () => {},
    });
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    const invoke = async () => {
      const events: import("../../src/types").AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget, sendBudget: budget }, event => events.push(event));
      return events;
    };
    try {
      expect(await invoke()).toContainEqual(expect.objectContaining({ type: "error", code: "muse_spend_limit_unsupported" }));
      expect(calls).toBe(0);
      enforced = false; changeAtDispatch = true;
      expect(await invoke()).toContainEqual(expect.objectContaining({ type: "error", code: "muse_spend_limit_unsupported" }));
      expect(sends).toBe(0);
      expect(budget.used).toBe(0);
      enforced = false; changeAtDispatch = false;
      expect(await invoke()).toContainEqual({ type: "done" });
      expect(sends).toBe(1);
    } finally { translatorBudget.dispose(); }
  });

  test("native adapter admits each dispatched tool segment and not rejected input", async () => {
    const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: [join(import.meta.dir, "../fixtures/muse-msp-fake-mcp-host.ts")],
      hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, cwd: process.cwd(),
      captureExecutable: process.execPath, captureArgs: [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")] });
    const adapter = createMuseNativeAdapter(runner, "muse|native-test", 5000), translatorBudget = createTranslatorBudget();
    const policy = { maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 };
    const body = { model: "test", input: [{ role: "user", content: "edit" }], tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const bind = (p: OcxParsedRequest) => { p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } }; return p; };
    const invoke = async (parsed: OcxParsedRequest) => {
      const budget = createRequestExecutionBudget(policy, "native-test"), events: import("../../src/types").AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget, sendBudget: budget }, event => events.push(event));
      return { events, used: budget.used };
    };
    try {
      const invalid = bind(parseRequest({ ...body, input: [{ role: "assistant", content: "history" }, ...body.input] }));
      const rejected = await invoke(invalid); expect(rejected.used).toBe(0); expect(rejected.events.some(event => event.type === "error")).toBe(true);
      const first = await invoke(bind(parseRequest(body))); expect(first.used).toBe(1);
      const response = buildResponseJSON(first.events, "test", { freeformToolNames: new Set(["apply_patch"]) });
      const call = (response.output as Array<Record<string, unknown>>).find(item => item.type === "custom_tool_call")!;
      const next = bind(parseRequest({ ...body, input: [...body.input, call, { type: "custom_tool_call_output", call_id: call.call_id, output: "client result" }] }));
      const second = await invoke(next); expect(second.used).toBe(1);
      expect(second.events).toContainEqual({ type: "text_delta", text: "client result" });
    } finally { await runner.close(); translatorBudget.dispose(); }
  });

  test("runner owns the complete mock process and tool-result lifecycle", async () => {
    const runner = new MuseMspRunner({ hostExecutable: process.execPath, hostArgs: [join(import.meta.dir, "../fixtures/muse-msp-fake-mcp-host.ts")],
      hostEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, OCX_TEST_PRETOOL_TEXT: "before tool" }, cwd: process.cwd(),
      captureExecutable: process.execPath, captureArgs: [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")] });
    const body = { model: "test", parallel_tool_calls: true, input: [{ role: "user", content: "edit" }], tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const bind = (p: OcxParsedRequest) => { p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } }; return p; };
    let dispatches = 0;
    const budget = createTranslatorBudget(), adapter = createMuseMspAdapter({
      run: (parsed, options) => runner.run(parsed, { ...options, beforeDispatch: () => { dispatches++; } }),
    }, 5000);
    const invoke = async (parsed: OcxParsedRequest) => {
      const out: import("../../src/types").AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: budget }, event => out.push(event));
      return out;
    };
    try {
      const events = await invoke(bind(parseRequest(body)));
      async function* streamEvents() { yield* events; }
      const streamWire = await new Response(bridgeToResponsesSSE(streamEvents(), "test", undefined, new Set(["apply_patch"]))).text();
      const streamItems = streamWire.split("\n\n").flatMap(frame => {
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data || data === "data: [DONE]") return [];
        const event = JSON.parse(data.slice(6));
        return event.type === "response.output_item.done" ? [event.item] : [];
      });
      expect(streamItems.find(item => item.type === "message")?.phase).toBe("commentary");
      const response = buildResponseJSON(events, "test", { freeformToolNames: new Set(["apply_patch"]) });
      const call = (response.output as Array<Record<string, unknown>>).find(item => item.type === "custom_tool_call")!;
      const message = (response.output as Array<Record<string, unknown>>).find(item => item.type === "message")!;
      expect(JSON.stringify(message)).toContain("before tool");
      expect(call).toMatchObject({ name: "apply_patch", input: "patch text" });
      const output = { type: "custom_tool_call_output", call_id: call.call_id, output: "client result" };
      const next = bind(parseRequest({ ...body, input: [...body.input, message, call, output] }));
      const streamedCall = streamItems.find(item => item.type === "custom_tool_call");
      const streamedNext = bind(parseRequest({ ...body, input: [...body.input, streamItems.find(item => item.type === "message"), streamedCall, output] }));
      expect(museContinuation(streamedNext.context).historyDigest).toBe(museContinuation(next.context).historyDigest);
      const tampered = bind(parseRequest({ ...body, input: [...body.input, { ...message, content: [{ type: "output_text", text: "changed" }] }, call, output] }));
      await expect(runner.run(tampered, { timeoutMs: 5000 })).rejects.toThrow("unavailable_tool_result");
      const changedOptions = { ...next, options: { ...next.options, parallelToolCalls: false } };
      await expect(runner.run(changedOptions, { timeoutMs: 5000 })).rejects.toThrow("unavailable_turn");
      const cancelled = new AbortController(); cancelled.abort();
      await expect(runner.run(next, { timeoutMs: 5000, signal: cancelled.signal })).rejects.toThrow("cancelled");
      expect(await invoke(next)).toEqual([{ type: "text_delta", text: "client result" }, { type: "done" }]);
      expect(dispatches).toBe(2);
      await expect(runner.run(next, { timeoutMs: 5000 })).rejects.toThrow("unavailable_turn");
      const unsupported = bind(parseRequest({ ...body, input: [{ role: "developer", content: "directive" }, ...body.input] }));
      await expect(runner.run(unsupported, { timeoutMs: 5000 })).rejects.toThrow("unsupported_input_history");
      const withTemperature = bind(parseRequest({ ...body, temperature: 0.3 }));
      await expect(runner.run(withTemperature, { timeoutMs: 5000 })).rejects.toThrow("unsupported_request_options");
      const withTier = bind(parseRequest(body));
      withTier.options.tierDecision = { kind: "set", value: "priority" };
      await expect(runner.run(withTier, { timeoutMs: 5000 })).rejects.toThrow("unsupported_request_options");
    } finally { await runner.close(); budget.dispose(); }
  });

  test("mock MSP host launches the MCP child and completes a Responses round trip", async () => {
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous(), turns = new MuseTurnRegistry();
    const body = { model: "test", input: [{ role: "user", content: "edit" }], tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const bind = (p: OcxParsedRequest) => { p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } }; return p; };
    const initial = bind(parseRequest(body)), catalog = buildMuseCaptureCatalog(initial);
    const channel = await openMuseCaptureChannel(rendezvous, catalog.tools);
    const host = await MuseMspHost.start({ executable: process.execPath, args: [join(import.meta.dir, "../fixtures/muse-msp-fake-mcp-host.ts")],
      cwd: process.cwd(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }, { timeoutMs: 5000 });
    try {
      const session = await MuseMspSession.open(host.connection, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: {
        command: process.execPath, args: [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")],
        env: { OCX_MUSE_CAPTURE_PORT: String(channel.port), OCX_MUSE_CAPTURE_TOKEN: channel.token } } }, { timeoutMs: 5000 });
      const turnId = await session.startTurn("edit", undefined, { timeoutMs: 1000 });
      const handoff = new MuseResponsesHandoff(registry);
      const segments = new MuseTurnSegments({ session, turnId, capture: session.captureForTurn(turnId, catalog.approvalTools),
        inbox: host.inbox, connection: host.connection, handoff, rendezvous });
      const events = await turns.start(initial, { segments, handoff, close: async () => { await host.close(); await channel.close(); rendezvous.close(); registry.close(); } }, { timeoutMs: 5000 });
      const response = buildResponseJSON(events, "test", { freeformToolNames: new Set(["apply_patch"]) });
      const call = (response.output as Array<Record<string, unknown>>).find(item => item.type === "custom_tool_call")!;
      expect(call).toMatchObject({ name: "apply_patch", input: "patch text" });
      const output = { type: "custom_tool_call_output", call_id: call.call_id, output: "client result" };
      const next = bind(parseRequest({ ...body, input: [...body.input, call, output] }));
      expect(await turns.continue(next, { timeoutMs: 5000 })).toEqual([{ type: "text_delta", text: "client result" }, { type: "done" }]);
    } finally { await turns.close(); await host.close(); await channel.close(); rendezvous.close(); registry.close(); }
  });

  test.each(["module", "cli"])("MCP child obtains its catalog and returns a parked result: %s", async mode => {
    const home = await mkdtemp(join(tmpdir(), "ocx-muse-capture-test-"));
    const rendezvous = new MuseCaptureRendezvous(), registry = new MusePendingRegistry();
    const owner = "a".repeat(64), digest = "b".repeat(64);
    const pending = registry.register(owner, "call", digest, { timeoutMs: 5000 });
    rendezvous.expect({ callId: "call", name: "probe", arguments: { x: 1 } }, pending.result);
    const channel = await openMuseCaptureChannel(rendezvous, [{ name: "probe", description: "capture", inputSchema: { type: "object" } }]);
    const client = new Client({ name: "fake-muse", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: mode === "cli" ? [join(process.cwd(), "src/cli/index.ts"), "__muse-mcp"] : [join(process.cwd(), "src/adapters/muse-msp/capture-child.ts")],
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex"), OCX_MUSE_CAPTURE_PORT: String(channel.port), OCX_MUSE_CAPTURE_TOKEN: channel.token }, stderr: "pipe" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["probe"]);
      const result = client.callTool({ name: "probe", arguments: { x: 1 }, _meta: { callId: "call" } });
      registry.submit(owner, pending.clientCallId, digest, "child result");
      expect((await result).content).toEqual([{ type: "text", text: "child result" }]);
    } finally { await client.close(); await channel.close(); rendezvous.close(); registry.close(); await rm(home, { recursive: true, force: true }); }
  });

  test("local capture channel authenticates and forwards only the approved call", async () => {
    const rendezvous = new MuseCaptureRendezvous(), registry = new MusePendingRegistry();
    const owner = "a".repeat(64), digest = "b".repeat(64);
    const pending = registry.register(owner, "call", digest, { timeoutMs: 2000 });
    const call = { callId: "call", name: "probe", arguments: { x: 1 } };
    rendezvous.expect(call, pending.result);
    const channel = await openMuseCaptureChannel(rendezvous);
    try {
      await expect(sendMuseCapture(channel.port, "c".repeat(64), call, new AbortController().signal)).rejects.toThrow("capture_channel_failed");
      await expect(sendMuseCapture(channel.port, channel.token, { ...call, arguments: { x: 2 } }, new AbortController().signal)).rejects.toThrow("capture_channel_failed");
      const result = sendMuseCapture(channel.port, channel.token, call, new AbortController().signal);
      registry.submit(owner, pending.clientCallId, digest, "client result");
      expect(await result).toBe("client result");
      await expect(sendMuseCapture(channel.port, channel.token, call, new AbortController().signal)).rejects.toThrow("capture_channel_failed");
    } finally { await channel.close(); rendezvous.close(); registry.close(); }
  });

  test("holds the owner slot until asynchronous cleanup completes", async () => {
    const turns = new MuseTurnRegistry(1, 10), pending = new MusePendingRegistry();
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
    let cleanupStarted!: () => void, finishCleanup!: () => void, count = 0;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const gate = new Promise<void>(resolve => { finishCleanup = resolve; });
    const parts = { handoff: new MuseResponsesHandoff(pending),
      segments: { async next() { return [{ type: "tool_call_start" as const, id: "test", name: "probe" }, { type: "done" as const }]; } },
      async close() { count++; cleanupStarted(); await gate; } };
    await turns.start(parsed, parts, { timeoutMs: 1000 });
    const timeout = setTimeout(() => cleanupStarted(), 1000);
    await started;
    clearTimeout(timeout);
    expect(count).toBe(1);
    await expect(turns.start(parsed, parts, { timeoutMs: 1000 })).rejects.toThrow("unavailable_turn");
    await expect(turns.continue(parsed, { timeoutMs: 1000 })).rejects.toThrow("unavailable_turn");
    let closeFinished = false;
    const closing = turns.close().then(() => { closeFinished = true; });
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    finishCleanup(); await closing; pending.close();
    expect(count).toBe(1);
  });

  test("expires a parked turn and closes its resources exactly once", async () => {
    const turns = new MuseTurnRegistry(1, 10), registry = new MusePendingRegistry();
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
    let closed = 0;
    const stopped = new Promise<void>(resolve => {
      void turns.start(parsed, { handoff: new MuseResponsesHandoff(registry),
        segments: { async next() { return [{ type: "tool_call_start", id: "test", name: "probe" }, { type: "tool_call_end" }, { type: "done" }]; } },
        async close() { closed++; resolve(); } }, { timeoutMs: 1000 });
    });
    const timeout = setTimeout(() => {}, 1000);
    try {
      await Promise.race([stopped, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cleanup timed out")), 500))]);
    } finally { clearTimeout(timeout); }
    await expect(turns.continue(parsed, { timeoutMs: 1000 })).rejects.toThrow("unavailable_turn");
    await turns.close(); registry.close();
    expect(closed).toBe(1);
  });

  test("drives a full mock turn over child-process stdio", async () => {
    const host = await MuseMspHost.start({ executable: process.execPath, args: [join(import.meta.dir, "../fixtures/muse-msp-fake-host.ts")],
      cwd: process.cwd(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }, { timeoutMs: 5000 });
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous(), turns = new MuseTurnRegistry();
    try {
      const session = await MuseMspSession.open(host.connection, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
      const turnId = await session.startTurn("hello", undefined, { timeoutMs: 1000 });
      const capture = session.captureForTurn(turnId, new Map([["mcp__opencodex__probe", "probe"]]));
      const handoff = new MuseResponsesHandoff(registry);
      const segments = new MuseTurnSegments({ session, turnId, capture, rendezvous, handoff, inbox: host.inbox, connection: host.connection });
      const body = { model: "test", input: [{ role: "user", content: "hello" }] };
      const bind = (p: OcxParsedRequest) => { p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } }; return p; };
      const first = await turns.start(bind(parseRequest(body)), { segments, handoff, close: async () => { rendezvous.close(); registry.close(); await host.close(); } }, { timeoutMs: 1000 });
      const call = (buildResponseJSON(first, "test").output as Array<Record<string, unknown>>).find(item => item.type === "function_call")!;
      const pending = rendezvous.accept({ callId: "upstream", name: "probe", arguments: {} }, new AbortController().signal);
      const output = { type: "function_call_output", call_id: call.call_id, output: "result" };
      const next = bind(parseRequest({ ...body, input: [...body.input, call, output] }));
      await host.connection.request("fixture/finish", {}, { timeoutMs: 1000 });
      expect(await turns.continue(next, { timeoutMs: 1000 })).toEqual([{ type: "text_delta", text: "finished" }, { type: "done" }]);
      expect(await pending).toBe("result");
      await expect(turns.continue(next, { timeoutMs: 1000 })).rejects.toThrow("unavailable_turn");
    } finally { await turns.close(); rendezvous.close(); registry.close(); await host.close(); }
  });

  test("negotiates with and closes only its own harmless fake process", async () => {
    const script = `let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const line=b.slice(0,n);b=b.slice(n+1);const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{serverInfo:{version:'fake'},schema:{version:1},grantedCapabilities:['sessionMcp'],sessionDurability:'ephemeral'}})+'\\n');if(m.method==='initialized')process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/ready'})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
    const host = await MuseMspHost.start({ executable: process.execPath, args: ["-e", script], cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }, { timeoutMs: 5000 });
    try {
      expect(await host.inbox.take(m => m.method === "fixture/ready", { timeoutMs: 1000 })).toMatchObject({ method: "fixture/ready" });
    } finally { await host.close(); }
    await host.close();
    await expect(host.connection.request("anything", {}, { timeoutMs: 100 })).rejects.toThrow("closed");
  });

  test("fails a missing fake executable and rejects relative paths before spawning", async () => {
    await expect(MuseMspHost.start({ executable: "relative", args: [], cwd: process.cwd(), env: {} }, { timeoutMs: 100 })).rejects.toThrow("invalid_host_config");
    const fakePath = `${process.cwd()}\\missing-mock-executable-for-msp.exe`;
    await expect(MuseMspHost.start({ executable: fakePath, args: [], cwd: process.cwd(), env: {} }, { timeoutMs: 1000 })).rejects.toThrow();
  });
});

describe("Muse capture catalog", () => {
  test("preserves schemas and reversibly separates colliding names and namespaces", () => {
    const body = { model: "test", input: [{ role: "user", content: "hello" }], tools: [
      { type: "namespace", name: "a", tools: [{ type: "function", name: "b__c", description: "first", parameters: { type: "object", properties: { x: { type: "string" } } } }] },
      { type: "namespace", name: "a__b", tools: [{ type: "function", name: "c", description: "second", parameters: { type: "object", properties: {} } }] },
    ] };
    // Construct the already-parsed context explicitly because the shared parser rejects flattened-name collisions.
    const parsed = parseRequest({ model: "test", input: body.input });
    parsed.context.tools = [
      { name: "b__c", namespace: "a", description: "first", parameters: { type: "object", properties: { x: { type: "string" } } } },
      { name: "c", namespace: "a__b", description: "second", parameters: { type: "object", properties: {} } },
    ];
    const catalog = buildMuseCaptureCatalog(parsed);
    expect(new Set(catalog.tools.map(tool => tool.name)).size).toBe(2);
    expect(catalog.tools[0]!.inputSchema).toEqual(parsed.context.tools[0]!.parameters);
    expect(catalog.approvalTools.get(`mcp__opencodex__${catalog.tools[0]!.name}`)).toEqual({ name: "b__c", namespace: "a" });
    expect(catalog.approvalTools.get(`mcp__opencodex__${catalog.tools[1]!.name}`)).toEqual({ name: "c", namespace: "a__b" });
    parsed.context.tools.reverse();
    const reversed = buildMuseCaptureCatalog(parsed);
    expect(reversed.tools.map(tool => tool.name).sort()).toEqual(catalog.tools.map(tool => tool.name).sort());
  });

  test("fails closed on unsupported requirements and wire types", () => {
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    parsed.context.tools = [{ name: "probe", description: "test", parameters: { type: "object" }, imageGeneration: true }];
    expect(() => buildMuseCaptureCatalog(parsed)).toThrow("unsupported_capture_tool");
    parsed.options.toolChoice = "none";
    expect(buildMuseCaptureCatalog(parsed).tools).toEqual([]);
    parsed.options.toolChoice = "required";
    expect(() => buildMuseCaptureCatalog(parsed)).toThrow("unsupported_tool_choice");
  });
});

describe("Muse isolated settings provisioning", () => {
  test("cleaning isolated settings leaves a linked credential target intact", async () => {
    const tmpRoot = resolve(tmpdir());
    const fixtureRoot = resolve(await mkdtemp(join(tmpRoot, "ocx-muse-link-fixture-")));
    if (!fixtureRoot.startsWith(tmpRoot + sep) || !basename(fixtureRoot).startsWith("ocx-muse-link-fixture-")) throw new Error("invalid fixture root");
    const target = join(fixtureRoot, "dummy-auth.json");
    try {
      await writeFile(target, "dummy-credential", { flag: "wx" });
      let settings: Awaited<ReturnType<typeof createMuseIsolatedSettings>>;
      try {
        settings = await createMuseIsolatedSettings("developer", {}, {
          writeCredentials: async dir => { await symlink(target, join(dir, "auth.json")); },
        });
      } catch (error) {
        // Windows may not grant symlink creation; no link was created in that case.
        if (process.platform === "win32" && (error as NodeJS.ErrnoException)?.code === "EPERM") return;
        throw error;
      }
      const isolated = settings.env.XDG_CONFIG_HOME!;
      await settings.close();
      await expect(access(isolated)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("dummy-credential");
    } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
  });
  test("uses explicit isolated credentials and removes them after close or provisioning failure", async () => {
    const provision = { disableReminders: true as const,
      writeCredentials: async (dir: string) => { await writeFile(join(dir, "auth.json"), "dummy", { flag: "wx" }); } };
    const settings = await createMuseIsolatedSettings("test developer", {}, provision);
    const configDir = join(settings.env.XDG_CONFIG_HOME!, "muse");
    try {
      const document = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
      expect(document.endpoint_transport).toBeUndefined();
      expect(document.run).toEqual({ developer_prompt: "test developer", reminder_roster: { agents: [] } });
      expect(await readFile(join(configDir, "auth.json"), "utf8")).toBe("dummy");
    } finally { await settings.close(); }
    await expect(access(configDir)).rejects.toThrow();
    const withoutDeveloper = await createMuseIsolatedSettings(undefined, { META_API_KEY: "unwanted", meta_api_key: "unwanted" }, provision);
    try {
      const dir = join(withoutDeveloper.env.XDG_CONFIG_HOME!, "muse");
      const document = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
      expect(document.endpoint_transport).toBeUndefined();
      expect(document.run).toEqual({ reminder_roster: { agents: [] } });
      expect(await readFile(join(dir, "auth.json"), "utf8")).toBe("dummy");
      expect(Object.keys(withoutDeveloper.env).some(key => key.toUpperCase() === "META_API_KEY")).toBe(false);
    } finally { await withoutDeveloper.close(); }
    const noProvision = await createMuseIsolatedSettings("developer", { META_API_KEY: "unwanted", meta_api_key: "unwanted" });
    try { expect(Object.keys(noProvision.env).some(key => key.toUpperCase() === "META_API_KEY")).toBe(false); }
    finally { await noProvision.close(); }
    let failedDir = "";
    await expect(createMuseIsolatedSettings("test developer", {}, { ...provision, writeCredentials: async dir => {
      failedDir = dir; await writeFile(join(dir, "auth.json"), "dummy"); throw new Error("synthetic provisioning failure");
    } })).rejects.toThrow("synthetic provisioning failure");
    expect(failedDir).not.toBe("");
    await expect(access(failedDir)).rejects.toThrow();
  });
});

describe("Muse parsed Responses continuation", () => {
  test("retained conversation isolates owner, replay and overlapping turns", async () => {
    const registry = new MuseConversationRegistry(), user = { role: "user", content: "first" };
    const reply = (text: string) => (buildResponseJSON([{ type: "text_delta", text }, { type: "done" }], "test").output as Array<Record<string, unknown>>).find(item => item.type === "message")!;
    const answer = reply("answer"), second = { role: "user", content: "second" };
    const bind = (input: unknown[], principal = "a".repeat(64)) => {
      const parsed = parseRequest({ model: "test", input });
      parsed._reasoningReplayScope = { clientPrincipalId: principal, clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return parsed;
    };
    let starts = 0, closes = 0;
    registry.retain(bind([user, answer]), { isValid: () => true, async close() { closes++; }, async startTurn(text) { starts++; expect(text).toBe("second"); return "turn-2"; } });
    try {
      const next = bind([user, answer, second]);
      await expect(registry.resume(bind([user, answer, second], "b".repeat(64)), { timeoutMs: 1000 })).rejects.toThrow("unavailable_conversation");
      await expect(registry.resume(bind([{ ...user, content: "changed" }, answer, second]), { timeoutMs: 1000 })).rejects.toThrow("unavailable_conversation");
      await expect(registry.resume(next, { timeoutMs: 1000, beforeDispatch: () => { throw new Error("denied"); } })).rejects.toThrow("denied");
      expect(starts).toBe(0);
      expect(await registry.resume(next, { timeoutMs: 1000 })).toBe("turn-2");
      await expect(registry.resume(next, { timeoutMs: 1000 })).rejects.toThrow("unavailable_conversation");
      const secondAnswer = reply("second answer");
      await registry.finish(bind([user, answer, second, secondAnswer]));
      await expect(registry.resume(next, { timeoutMs: 1000 })).rejects.toThrow("unavailable_conversation");
      expect(starts).toBe(1);
    } finally { await registry.close(); }
    expect(closes).toBe(1);
  });

  test("retained conversation closes when the rendered completion has altered history", async () => {
    const registry = new MuseConversationRegistry(), user = { role: "user", content: "first" }, answer = { role: "assistant", content: "answer" }, nextUser = { role: "user", content: "second" };
    const bind = (input: unknown[]) => {
      const parsed = parseRequest({ model: "test", input });
      parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return parsed;
    };
    let closes = 0;
    registry.retain(bind([user, answer]), { isValid: () => true, async close() { closes++; }, async startTurn() { return "turn"; } });
    await registry.resume(bind([user, answer, nextUser]), { timeoutMs: 1000 });
    await expect(registry.finish(bind([{ ...user, content: "altered" }, answer, nextUser, { role: "assistant", content: "done" }]))).rejects.toThrow("unavailable_conversation");
    expect(closes).toBe(1);
    await registry.close(); expect(closes).toBe(1);
  });

  test("expiring a starting conversation aborts and closes only its owned session", async () => {
    const registry = new MuseConversationRegistry(1, 20), user = { role: "user", content: "first" }, answer = { role: "assistant", content: "answer" };
    const bind = (input: unknown[]) => {
      const parsed = parseRequest({ model: "test", input });
      parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return parsed;
    };
    let closes = 0;
    registry.retain(bind([user, answer]), { isValid: () => true, async close() { closes++; }, startTurn(_text, options) {
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    await expect(registry.resume(bind([user, answer, { role: "user", content: "second" }]), { timeoutMs: 1000 })).rejects.toThrow("aborted");
    expect(closes).toBe(1);
    await registry.close(); expect(closes).toBe(1);
  });

  test("invalidating a retained host releases its owner slot and closes once", async () => {
    const registry = new MuseConversationRegistry(1), invalidated = new AbortController();
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hi" }, { role: "assistant", content: "answer" }] });
    parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
    let closes = 0;
    registry.retain(parsed, { isValid: () => !invalidated.signal.aborted, invalidated: invalidated.signal, async close() { closes++; }, async startTurn() { return "turn"; } });
    invalidated.abort();
    for (let i = 0; i < 100 && closes === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(closes).toBe(1);
    await registry.discard(parsed);
    registry.retain(parsed, { isValid: () => true, async close() { closes++; }, async startTurn() { return "turn"; } });
    await registry.close(); expect(closes).toBe(2);
  });

  test("does not accept completion while a retained turn is still being admitted", async () => {
    const registry = new MuseConversationRegistry(), user = { role: "user", content: "first" }, answer = { role: "assistant", content: "answer" }, second = { role: "user", content: "second" };
    const bind = (input: unknown[]) => {
      const parsed = parseRequest({ model: "test", input });
      parsed._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return parsed;
    };
    let resolveStart!: (id: string) => void, closes = 0;
    registry.retain(bind([user, answer]), { isValid: () => true, async close() { closes++; }, startTurn: () => new Promise(resolve => { resolveStart = resolve; }) });
    try {
      const started = registry.resume(bind([user, answer, second]), { timeoutMs: 1000 });
      await expect(registry.finish(bind([user, answer, second, { role: "assistant", content: "done" }]))).rejects.toThrow("unavailable_conversation");
      resolveStart("turn"); expect(await started).toBe("turn");
      await registry.finish(bind([user, answer, second, { role: "assistant", content: "done" }]));
    } finally { await registry.close(); }
    expect(closes).toBe(1);
  });

  test("binds a completed visible conversation to its owner, history, tools and options", () => {
    const user = { role: "user", content: "first question" };
    const response = buildResponseJSON([{ type: "text_delta", text: "first answer" }, { type: "done" }], "test");
    const answer = (response.output as Array<Record<string, unknown>>).find(item => item.type === "message")!;
    const tools = [{ type: "function", name: "probe", parameters: { type: "object", properties: {} } }];
    const bind = (input: unknown[], principal = "a".repeat(64), suppliedTools = tools) => {
      const parsed = parseRequest({ model: "test", input, tools: suppliedTools });
      parsed._reasoningReplayScope = { clientPrincipalId: principal, clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return parsed;
    };
    const completed = bind([user, answer]);
    const checkpoint = new MuseConversationCheckpoint(completed);
    const nextUser = { role: "user", content: "next question" };
    expect(() => checkpoint.next(bind([user, answer, nextUser], "b".repeat(64)))).toThrow("unavailable_conversation");
    expect(() => checkpoint.next(bind([{ ...user, content: "changed" }, answer, nextUser]))).toThrow("unavailable_conversation");
    expect(() => checkpoint.next(bind([user, { ...answer, content: [{ type: "output_text", text: "changed" }] }, nextUser]))).toThrow("unavailable_conversation");
    expect(() => checkpoint.next(bind([user, answer, nextUser], "a".repeat(64), []))).toThrow("unavailable_conversation");
    const changedOptions = bind([user, answer, nextUser]); changedOptions.options.parallelToolCalls = false;
    expect(() => checkpoint.next(changedOptions)).toThrow("unavailable_conversation");
    const changedRoute = bind([user, answer, nextUser]); changedRoute._reasoningReplayScope!.current!.modelId = "other-model";
    expect(() => checkpoint.next(changedRoute)).toThrow("unavailable_conversation");
    expect(() => checkpoint.next(bind([nextUser]))).toThrow("unavailable_conversation");
    expect(() => checkpoint.next(bind([user, answer, nextUser]), () => { throw new Error("denied"); })).toThrow("denied");
    const equivalent = bind([user, answer, nextUser]);
    const assistant = equivalent.context.messages.find(message => message.role === "assistant");
    if (assistant?.role === "assistant") assistant.model = "client-alias";
    expect(checkpoint.next(equivalent, () => {
      expect(() => checkpoint.next(bind([user, answer, nextUser]))).toThrow("unavailable_conversation");
    })).toBe("next question");
    expect(() => checkpoint.next(bind([user, answer, nextUser]))).toThrow("unavailable_conversation");
  });

  test("terminates when the host removes a queued turn", async () => {
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous(), inbox = new MuseMspInbox();
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "s" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "queued", turnId: "t" };
      throw new Error("unexpected");
    } };
    const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
    await session.startTurn("hello", undefined, { timeoutMs: 1000, allowQueued: true });
    const segments = new MuseTurnSegments({ session, turnId: "t", inbox, capture: session.captureForTurn("t", new Map()),
      rendezvous, handoff: new MuseResponsesHandoff(registry), connection: { async respond() {} } });
    try {
      inbox.push({ method: "turn/unqueued", params: { sessionId: "s", turnId: "t" } });
      await expect(segments.next(parseRequest({ model: "test", input: "hello" }), { timeoutMs: 1000 })).rejects.toThrow("turn_unqueued");
    } finally { inbox.close(); rendezvous.close(); registry.close(); }
  });

  test("streams validated message deltas before completion and avoids duplicating completed text", async () => {
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous(), inbox = new MuseMspInbox();
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "s" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "t" };
      throw new Error("unexpected");
    } };
    const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
    await session.startTurn("hello", undefined, { timeoutMs: 1000 });
    const segments = new MuseTurnSegments({ session, turnId: "t", inbox, capture: session.captureForTurn("t", new Map()),
      rendezvous, handoff: new MuseResponsesHandoff(registry), connection: { async respond() {} } });
    const chunks: string[] = [];
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    try {
      const result = segments.next(parsed, { timeoutMs: 1000, onText: chunk => chunks.push(chunk) });
      inbox.push({ method: "item/started", params: { sessionId: "s", item: { itemId: "i", turnId: "t", kind: "agentMessage", text: "" } } });
      const delta = { method: "item/delta", params: { sessionId: "s", itemId: "i", viewCursor: "one", delta: "hel" } };
      inbox.push(delta); inbox.push(delta);
      inbox.push({ method: "item/delta", params: { sessionId: "s", itemId: "unknown-tool", viewCursor: "other", delta: "not user text" } });
      for (let i = 0; i < 100 && chunks.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(chunks).toEqual(["hel"]);
      inbox.push({ method: "item/completed", params: { sessionId: "s", item: { itemId: "i", turnId: "t", kind: "agentMessage", text: "hello" } } });
      inbox.push({ method: "turn/completed", params: { sessionId: "s", turnId: "t", terminal: "completed" } });
      expect(await result).toEqual([{ type: "done" }]);
      expect(chunks).toEqual(["hel", "lo"]);
    } finally { inbox.close(); rendezvous.close(); registry.close(); }
  });

  test("rejects completed text that contradicts a streamed delta", async () => {
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous(), inbox = new MuseMspInbox();
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "s" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "t" };
      throw new Error("unexpected");
    } };
    const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
    await session.startTurn("hello", undefined, { timeoutMs: 1000 });
    const segments = new MuseTurnSegments({ session, turnId: "t", inbox, capture: session.captureForTurn("t", new Map()),
      rendezvous, handoff: new MuseResponsesHandoff(registry), connection: { async respond() {} } });
    try {
      inbox.push({ method: "item/started", params: { sessionId: "s", item: { itemId: "i", turnId: "t", kind: "agentMessage" } } });
      inbox.push({ method: "item/delta", params: { sessionId: "s", itemId: "i", viewCursor: "one", delta: "hello" } });
      inbox.push({ method: "item/completed", params: { sessionId: "s", item: { itemId: "i", turnId: "t", kind: "agentMessage", text: "different" } } });
      await expect(segments.next(parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] }), { timeoutMs: 1000, onText: () => {} })).rejects.toThrow("stream_item_mismatch");
    } finally { inbox.close(); rendezvous.close(); registry.close(); }
  });

  test("preserves observed segment usage when the Muse turn fails", async () => {
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous(), inbox = new MuseMspInbox();
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "s" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "t" };
      throw new Error("unexpected");
    } };
    const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
    await session.startTurn("hello", undefined, { timeoutMs: 1000 });
    const segments = new MuseTurnSegments({ session, turnId: "t", inbox, capture: session.captureForTurn("t", new Map()),
      rendezvous, handoff: new MuseResponsesHandoff(registry), connection: { async respond() {} } });
    const parsed = parseRequest({ model: "test", input: [{ role: "user", content: "hello" }] });
    const translatorBudget = createTranslatorBudget();
    try {
      inbox.push({ method: "session/tokenUsage", params: { sessionId: "s", turnId: "t", viewCursor: "usage-1", promptTokens: 100, totalTokens: 125 } });
      inbox.push({ method: "turn/completed", params: { sessionId: "s", turnId: "t", terminal: "failed" } });
      const adapter = createMuseMspAdapter({ run: (p, options) => segments.next(p, { timeoutMs: options.timeoutMs }) });
      const events: import("../../src/types").AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget }, event => events.push(event));
      expect(events).toEqual([{ type: "error", message: "Muse session could not be completed.", status: 502,
        errorType: "upstream_error", code: "muse_session_failed", retryable: false,
        usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } }]);
      let loggedUsage: unknown;
      async function* failedEvents() { yield* events; }
      const wire = await new Response(bridgeToResponsesSSE(failedEvents(), "test", undefined, undefined, undefined, undefined, 2000,
        { onUsage: usage => { loggedUsage = usage; } })).text();
      const failed = wire.split("\n\n").flatMap(frame => frame.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))))
        .find(event => event.type === "response.failed");
      expect(loggedUsage).toEqual({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
      expect(failed.response.usage).toMatchObject({ input_tokens: 100, output_tokens: 25, total_tokens: 125 });
    } finally { inbox.close(); rendezvous.close(); registry.close(); translatorBudget.dispose(); }
  });

  test("segments one mocked turn into a tool response and a final text response", async () => {
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous(), inbox = new MuseMspInbox();
    let result: Promise<string> | undefined;
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "s" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "t" };
      if (method === "approval/decide") {
        result = rendezvous.accept({ callId: "upstream", name: "probe", arguments: {} }, new AbortController().signal);
        return { commandId: params.commandId, status: "accepted", approvalId: params.approvalId, terminal: true };
      }
      throw new Error("unexpected");
    } };
    const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
    await session.startTurn("hello", undefined, { timeoutMs: 1000 });
    const capture = session.captureForTurn("t", new Map([["mcp__opencodex__probe", "probe"]]));
    const handoff = new MuseResponsesHandoff(registry), replies: unknown[] = [];
    const segments = new MuseTurnSegments({ session, turnId: "t", inbox, capture, rendezvous, handoff,
      connection: { async respond(id, value) { replies.push([id, value]); } } });
    const params = { sessionId: "s", turnId: "t", approvalId: "a", toolCallId: "upstream", toolName: "mcp__opencodex__probe", rawArgs: "{}",
      currentRequirementId: { approvalId: "a", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }] };
    const body = { model: "test", input: [{ role: "user", content: "hello" }] };
    const bind = (p: OcxParsedRequest) => { p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
      providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } }; return p; };
    try {
      inbox.push({ method: "approval/requested", params });
      inbox.push({ method: "approval/request", id: 5, params });
      const first = await segments.next(bind(parseRequest(body)), { timeoutMs: 1000 });
      const call = (buildResponseJSON(first, "test").output as Array<Record<string, unknown>>).find(item => item.type === "function_call")!;
      expect(call.name).toBe("probe");
      const output = { type: "function_call_output", call_id: call.call_id, output: "result" };
      const next = bind(parseRequest({ ...body, input: [...body.input, call, output] }));
      handoff.submit(next);
      expect(await result).toBe("result");
      const usage = { method: "session/tokenUsage", params: { sessionId: "s", turnId: "t", viewCursor: "usage-1", promptTokens: 100, totalTokens: 125 } };
      inbox.push(usage); inbox.push(usage);
      inbox.push({ method: "item/completed", params: { sessionId: "s", item: { itemId: "i", turnId: "t", kind: "agentMessage", text: "finished" } } });
      inbox.push({ method: "turn/completed", params: { sessionId: "s", turnId: "t", terminal: "completed" } });
      expect(await segments.next(next, { timeoutMs: 1000 })).toEqual([{ type: "text_delta", text: "finished" },
        { type: "done", usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } }]);
      expect(replies).toEqual([[5, {}]]);
      await expect(segments.next(next, { timeoutMs: 1000 })).rejects.toThrow("segment_unavailable");
    } finally { inbox.close(); rendezvous.close(); registry.close(); }
  });

  test("round trips a freeform call through catalog, mock MSP, MCP and Responses", async () => {
    const body = { model: "test", input: [{ role: "user", content: "edit" }], tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const bind = (p: OcxParsedRequest) => {
      p._reasoningReplayScope = { clientPrincipalId: "a".repeat(64), clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return p;
    };
    const parsed = bind(parseRequest(body));
    const catalog = buildMuseCaptureCatalog(parsed), alias = catalog.tools[0]!.name;
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous();
    const server = createMuseCaptureServer(catalog.tools, (call, signal) => rendezvous.accept(call, signal));
    const client = new Client({ name: "fake-muse", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    let mcpResult: ReturnType<typeof client.callTool> | undefined;
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "s" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "t" };
      if (method === "approval/decide") {
        mcpResult = client.callTool({ name: alias, arguments: { input: "patch text" }, _meta: { callId: "internal" } });
        return { commandId: params.commandId, status: "accepted", approvalId: params.approvalId, terminal: true };
      }
      throw new Error("unexpected");
    } };
    try {
      const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
      await session.startTurn("edit", undefined, { timeoutMs: 1000 });
      const capture = session.captureForTurn("t", catalog.approvalTools);
      const approval = capture.capture({ method: "approval/requested", params: {
        sessionId: "s", turnId: "t", approvalId: "a", toolCallId: "internal", toolName: `mcp__opencodex__${alias}`, rawArgs: '{"input":"patch text"}',
        currentRequirementId: { approvalId: "a", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
      } })!;
      const handoff = new MuseResponsesHandoff(registry);
      const admitted = await handoff.admit({ parsed, session, turnId: "t", capture, approval, rendezvous, timeoutMs: 1000 });
      const response = buildResponseJSON([...museToolCallEvents(admitted), { type: "done" }], "test", { freeformToolNames: new Set(["apply_patch"]) });
      const call = (response.output as Array<Record<string, unknown>>).find(item => item.type === "custom_tool_call")!;
      expect(call).toMatchObject({ name: "apply_patch", input: "patch text", call_id: admitted.clientCallId });
      const result = { type: "custom_tool_call_output", call_id: admitted.clientCallId, output: "client result" };
      handoff.submit(bind(parseRequest({ ...body, input: [...body.input, call, result] })));
      expect((await mcpResult!).content).toEqual([{ type: "text", text: "client result" }]);
    } finally { registry.close(); rendezvous.close(); await client.close(); await server.close(); }
  });

  test("streams freeform output through the existing Responses SSE bridge", async () => {
    const id = `msp_${"b".repeat(48)}`;
    const events = museToolCallEvents({ clientCallId: id, name: "apply_patch", freeform: true, arguments: '{"input":"patch text"}' });
    async function* source() { yield* events; yield { type: "done" as const }; }
    const stream = bridgeToResponsesSSE(source(), "test", undefined, new Set(["apply_patch"]));
    const wire = await new Response(stream).text();
    expect(wire).toContain('"type":"custom_tool_call"');
    expect(wire).toContain('"input":"patch text"');
    expect(wire).toContain(`"call_id":"${id}"`);
    expect(wire).not.toContain('"type":"function_call"');
  });

  test("emits the captured freeform call through the existing Responses JSON bridge", () => {
    const id = `msp_${"a".repeat(48)}`;
    const events = museToolCallEvents({ clientCallId: id, name: "apply_patch", freeform: true, arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) });
    const response = buildResponseJSON([...events, { type: "done" }], "test", { freeformToolNames: new Set(["apply_patch"]) });
    expect(response.output).toContainEqual(expect.objectContaining({ type: "custom_tool_call", call_id: id, name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }));
    expect(() => museToolCallEvents({ clientCallId: id, name: "apply_patch", freeform: true, arguments: '{"input":"x","extra":1}' })).toThrow("invalid_capture_call");
  });

  test("binds freeform input and kind through the Responses parser", () => {
    const body = { model: "test", input: [{ role: "user", content: "edit" }], tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "text" } }] };
    const first = parseRequest(body);
    const catalog = buildMuseCaptureCatalog(first);
    const alias = catalog.tools[0]!.name;
    const scope = new MuseApprovalCapture("s", "t", catalog.approvalTools);
    const makeApproval = (rawArgs: string) => ({ method: "approval/requested", params: { sessionId: "s", turnId: "t", approvalId: "a", toolCallId: "u",
      toolName: `mcp__opencodex__${alias}`, rawArgs, currentRequirementId: { approvalId: "a", sourceIndex: 0 },
      availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }] } });
    expect(() => scope.capture(makeApproval('{"input":"patch","extra":1}'))).toThrow("invalid_tool_arguments");
    const approval = scope.capture(makeApproval('{"input":"patch"}'))!;
    expect(approval.clientToolFreeform).toBe(true);
    const digest = museHistoryDigest(first.context, approval.clientToolName, { input: "patch" }, undefined, true);
    const input = [...body.input, { type: "custom_tool_call", call_id: "id", name: "apply_patch", input: "patch" },
      { type: "custom_tool_call_output", call_id: "id", output: "done" }];
    expect(museContinuation(parseRequest({ ...body, input }).context).historyDigest).toBe(digest);
    const wrongKind = [...body.input, { type: "function_call", call_id: "id", name: "apply_patch", arguments: '{"input":"patch"}' },
      { type: "function_call_output", call_id: "id", output: "done" }];
    expect(museContinuation(parseRequest({ ...body, input: wrongKind }).context).historyDigest).not.toBe(digest);
  });

  test("binds the explicit namespace without confusing tools with the same name", () => {
    const body = { model: "test", input: [{ role: "user", content: "hello" }], tools: [
      { type: "namespace", name: "first", tools: [{ type: "function", name: "probe", description: "probe", parameters: { type: "object", properties: {} } }] },
      { type: "namespace", name: "second", tools: [{ type: "function", name: "probe", description: "probe", parameters: { type: "object", properties: {} } }] },
    ] };
    const initial = parseRequest(body);
    const digest = museHistoryDigest(initial.context, "probe", { x: 1 }, "first");
    const continuation = (namespace: string) => parseRequest({ ...body, input: [...body.input,
      { type: "function_call", call_id: "id", name: "probe", namespace, arguments: '{"x":1}' },
      { type: "function_call_output", call_id: "id", output: "done" }] });
    expect(museContinuation(continuation("first").context).historyDigest).toBe(digest);
    expect(museContinuation(continuation("second").context).historyDigest).not.toBe(digest);
    expect(museHistoryDigest(initial.context, "probe", { x: 1 })).not.toBe(digest);
  });

  test("handoff independently derives owner and history on both sides", async () => {
    const registry = new MusePendingRegistry(), rendezvous = new MuseCaptureRendezvous();
    const handoff = new MuseResponsesHandoff(registry);
    let mcpResult: Promise<string> | undefined;
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "session" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "turn" };
      if (method === "approval/decide") {
        mcpResult = rendezvous.accept({ callId: "upstream", name: "probe", arguments: { x: 1 } }, new AbortController().signal);
        return { commandId: params.commandId, status: "accepted", approvalId: params.approvalId, terminal: true };
      }
      throw new Error("unexpected");
    } };
    const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
    await session.startTurn("hello", undefined, { timeoutMs: 1000 });
    const capture = session.captureForTurn("turn", new Map([["mcp__opencodex__probe", { name: "probe", namespace: "first" }]]));
    const approval = capture.capture({ method: "approval/requested", params: {
      sessionId: "session", turnId: "turn", approvalId: "approval", toolCallId: "upstream", toolName: "mcp__opencodex__probe", rawArgs: '{"x":1}',
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
    } })!;
    const body = { model: "test", input: [{ role: "user", content: "hello" }] };
    const bind = (request: OcxParsedRequest, principal = "a".repeat(64)) => {
      request._reasoningReplayScope = { clientPrincipalId: principal, clientThreadId: "thread", current: {
        providerName: "muse", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "test", credentialIdentity: "account" } };
      return request;
    };
    try {
      const admitted = await handoff.admit({ parsed: bind(parseRequest(body)), session, turnId: "turn", capture, approval, rendezvous, timeoutMs: 1000 });
      expect(admitted.namespace).toBe("first");
      const call = { type: "function_call", call_id: admitted.clientCallId, name: admitted.name, namespace: admitted.namespace, arguments: admitted.arguments };
      const output = { type: "function_call_output", call_id: admitted.clientCallId, output: "answer" };
      const continuation = (content: string, principal?: string) => bind(parseRequest({ ...body, input: [{ role: "user", content }, call, output] }), principal);
      const observed: Readonly<{ callId: string; output: string }>[] = [];
      const observe = (result: Readonly<{ callId: string; output: string }>) => observed.push(result);
      expect(() => handoff.submit(continuation("hello", "b".repeat(64)), observe)).toThrow("unavailable_tool_result");
      expect(() => handoff.submit(continuation("modified"), observe)).toThrow("unavailable_tool_result");
      expect(() => handoff.submit(bind(parseRequest({ ...body, input: [...body.input, { ...call, namespace: "second" }, output] })), observe)).toThrow("unavailable_tool_result");
      expect(observed).toEqual([]);
      handoff.submit(continuation("hello"), observe);
      expect(observed).toEqual([{ callId: "upstream", output: "answer" }]);
      expect(await mcpResult).toBe("answer");
      expect(() => handoff.submit(continuation("hello"))).toThrow("unavailable_tool_result");
    } finally { registry.close(); rendezvous.close(); }
  });

  test("derives matching history from a full parser round trip and rejects modifications", () => {
    const input = [{ role: "developer", content: "instructions" }, { role: "user", content: "hello" }];
    const body = { model: "test", input, tools: [{ type: "function", name: "probe", description: "probe", parameters: { type: "object", properties: {} } }] };
    const first = parseRequest(body);
    const digest = museHistoryDigest(first.context, "probe", { b: 2, a: 1 });
    const continuation = (items: unknown[]) => parseRequest({ ...body, input: [...input, ...items] });
    const call = { type: "function_call", call_id: "external", name: "probe", arguments: '{"a":1,"b":2}' };
    const result = { type: "function_call_output", call_id: "external", output: "done" };
    const parsed = continuation([call, result]);
    expect(museContinuation(parsed.context)).toEqual({ clientCallId: "external", historyDigest: digest, output: "done" });
    const changed = parseRequest({ ...body, input: [input[0], { role: "user", content: "changed" }, call, result] });
    expect(museContinuation(changed.context).historyDigest).not.toBe(digest);
    expect(museContinuation(continuation([{ ...call, arguments: '{"a":3,"b":2}' }, result]).context).historyDigest).not.toBe(digest);
    expect(() => museContinuation(continuation([call, { ...result, call_id: "wrong" }]).context)).toThrow("invalid_continuation");
  });

  test("preserves preceding assistant text when the parser merges a tool call", () => {
    const input = [{ role: "user", content: "hello" }, { role: "assistant", content: "earlier response" }];
    const body = { model: "test", input };
    const first = parseRequest(body);
    const digest = museHistoryDigest(first.context, "probe", {});
    const next = parseRequest({ ...body, input: [...input, { type: "function_call", call_id: "id", name: "probe", arguments: "{}" },
      { type: "function_call_output", call_id: "id", output: "done" }] });
    expect(museContinuation(next.context).historyDigest).toBe(digest);
    const assistant = first.context.messages.find(message => message.role === "assistant")!;
    if (assistant.role === "assistant") assistant.model = "different-provider-selector";
    expect(museHistoryDigest(first.context, "probe", {})).toBe(digest);
  });
});

describe("Muse capture MCP endpoint", () => {
  test("failed admission cancels its staged result and releases capacity", async () => {
    const registry = new MusePendingRegistry(1), rendezvous = new MuseCaptureRendezvous();
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "session" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "turn" };
      throw new Error("private upstream error");
    } };
    const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, { timeoutMs: 1000 });
    await session.startTurn("hello", undefined, { timeoutMs: 1000 });
    const capture = session.captureForTurn("turn", new Map([["mcp__opencodex__probe", "probe"]]));
    const approval = capture.capture({ method: "approval/requested", params: {
      sessionId: "session", turnId: "turn", approvalId: "approval", toolCallId: "call", toolName: "mcp__opencodex__probe", rawArgs: '{}',
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
    } })!;
    const owner = "a".repeat(64), historyDigest = "b".repeat(64);
    try {
      await expect(admitMuseCapturedTool({ session, turnId: "turn", capture, approval, registry, rendezvous, owner, historyDigest, timeoutMs: 1000 })).rejects.toThrow();
      await Promise.resolve();
      await expect(rendezvous.accept({ callId: "call", name: "probe", arguments: {} }, new AbortController().signal)).rejects.toThrow();
      const next = registry.register(owner, "next", historyDigest, { timeoutMs: 1000 });
      registry.submit(owner, next.clientCallId, historyDigest, "ok");
      expect((await next.result).output).toBe("ok");
    } finally { registry.close(); rendezvous.close(); }
  });

  test("stages the actual MSP approval before admitting and returning the client call", async () => {
    const registry = new MusePendingRegistry();
    const rendezvous = new MuseCaptureRendezvous();
    let duringAdmission: Promise<string> | undefined;
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "session" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "turn" };
      if (method === "approval/decide") {
        duringAdmission = rendezvous.accept({ callId: "call", name: "probe", arguments: { x: 1 } }, new AbortController().signal);
        return { commandId: params.commandId, status: "accepted", approvalId: params.approvalId, terminal: true };
      }
      throw new Error("unexpected");
    } };
    const options = { timeoutMs: 1000 };
    const session = await MuseMspSession.open(mock, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: [] } }, options);
    await session.startTurn("hello", undefined, options);
    const capture = session.captureForTurn("turn", new Map([["mcp__opencodex__probe", "original_tool"]]));
    const approval = capture.capture({ method: "approval/requested", params: {
      sessionId: "session", turnId: "turn", approvalId: "approval", toolCallId: "call", toolName: "mcp__opencodex__probe", rawArgs: '{"x":1}',
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
    } })!;
    const owner = "a".repeat(64), historyDigest = "b".repeat(64);
    try {
      const out = await admitMuseCapturedTool({ session, turnId: "turn", capture, approval, registry, rendezvous, owner, historyDigest, timeoutMs: 1000 });
      expect(out).toMatchObject({ name: "original_tool", arguments: '{"x":1}' });
      expect(duringAdmission).toBeDefined();
      registry.submit(owner, out.clientCallId, historyDigest, "client result");
      expect(await duringAdmission).toBe("client result");
      await expect(admitMuseCapturedTool({ session, turnId: "turn", capture, approval, registry, rendezvous, owner, historyDigest, timeoutMs: 1000 })).rejects.toThrow();
    } finally { registry.close(); rendezvous.close(); }
  });

  test("connects only the approved invocation to the owned continuation", async () => {
    const registry = new MusePendingRegistry();
    const rendezvous = new MuseCaptureRendezvous();
    const owner = "a".repeat(64), digest = "b".repeat(64);
    const pending = registry.register(owner, "upstream-call", digest, { timeoutMs: 1000 });
    rendezvous.expect({ callId: "upstream-call", name: "probe", arguments: { value: 1 } }, pending.result);
    const server = createMuseCaptureServer([{ name: "probe", description: "capture", inputSchema: { type: "object" } }],
      (call, signal) => rendezvous.accept(call, signal));
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      await expect(client.callTool({ name: "probe", arguments: { value: 2 }, _meta: { callId: "upstream-call" } })).rejects.toThrow();
      const captured = client.callTool({ name: "probe", arguments: { value: 1 }, _meta: { callId: "upstream-call" } });
      await expect(client.callTool({ name: "probe", arguments: { value: 1 }, _meta: { callId: "upstream-call" } })).rejects.toThrow();
      expect(() => registry.submit("c".repeat(64), pending.clientCallId, digest, "wrong")).toThrow();
      registry.submit(owner, pending.clientCallId, digest, "approved result");
      expect((await captured).content).toEqual([{ type: "text", text: "approved result" }]);
    } finally { rendezvous.close(); registry.close(); await client.close(); await server.close(); }
  });

  test("closes parked capture waits and preserves already-settled legitimate results", async () => {
    const rendezvous = new MuseCaptureRendezvous();
    const call = { callId: "first", name: "probe", arguments: {} };
    rendezvous.expect(call, Promise.resolve({ callId: "first", output: "ready" }));
    await Promise.resolve();
    expect(await rendezvous.accept(call, new AbortController().signal)).toBe("ready");
    rendezvous.expect({ ...call, callId: "second" }, new Promise(() => {}));
    const parked = rendezvous.accept({ ...call, callId: "second" }, new AbortController().signal);
    rendezvous.close();
    await expect(parked).rejects.toThrow("cancelled");
  });

  test("advertises a snapshot and waits for the client-owned result", async () => {
    const tools = [{ name: "probe", description: "Capture only", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
    let resolveResult!: (value: string) => void;
    let captured: unknown;
    const server = createMuseCaptureServer(tools, call => {
      captured = call;
      return new Promise(resolve => { resolveResult = resolve; });
    });
    tools[0]!.description = "changed";
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools[0]!.description).toBe("Capture only");
      const pending = client.callTool({ name: "probe", arguments: { text: "hello" }, _meta: { callId: "call-a" } });
      // In-memory transport dispatches asynchronously; observe callback admission explicitly.
      for (let i = 0; i < 100 && !captured; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(captured).toEqual({ name: "probe", callId: "call-a", arguments: { text: "hello" } });
      let finished = false;
      void pending.then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);
      resolveResult("external result");
      expect((await pending).content).toEqual([{ type: "text", text: "external result" }]);
    } finally { await client.close(); await server.close(); }
  });

  test("rejects undeclared calls and redacts callback errors", async () => {
    let called = 0;
    const server = createMuseCaptureServer([{ name: "probe", description: "capture", inputSchema: { type: "object" } }], async () => {
      called++;
      throw new Error("private callback detail");
    });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      await expect(client.callTool({ name: "other", arguments: {}, _meta: { callId: "a" } })).rejects.toThrow();
      await expect(client.callTool({ name: "probe", arguments: {} })).rejects.toThrow();
      expect(called).toBe(0);
      await expect(client.callTool({ name: "probe", arguments: {}, _meta: { callId: "a" } })).rejects.toThrow("capture_call_failed");
      expect(called).toBe(1);
    } finally { await client.close(); await server.close(); }
  });
});

function rig(limits?: { maxLineBytes?: number; maxPending?: number }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  const received: Record<string, unknown>[] = [];
  output.on("data", chunk => written.push(String(chunk)));
  const connection = new MuseMspConnection(input, output, message => received.push(message), limits);
  return { input, written, received, connection };
}

describe("Muse MSP connection", () => {
  test("correlates out-of-order responses and preserves fragmented UTF-8 notifications", async () => {
    const { input, written, received, connection } = rig();
    const first = connection.request("session/start", {}, { timeoutMs: 1000 });
    const second = connection.request("model/list", {}, { timeoutMs: 1000 });
    expect(written.map(line => JSON.parse(line).id)).toEqual([1, 2]);
    const bytes = Buffer.from('{"jsonrpc":"2.0","method":"event","params":{"text":"日本"}}\n');
    const split = bytes.indexOf(Buffer.from("日")) + 1;
    input.write(bytes.subarray(0, split)); input.write(bytes.subarray(split));
    input.write('{"jsonrpc":"2.0","id":2,"result":{"models":[]}}\n');
    input.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ models: [] });
    expect(received).toEqual([{ jsonrpc: "2.0", method: "event", params: { text: "日本" } }]);
    connection.close();
  });

  test("cancellation ignores late response and does not affect other requests", async () => {
    const { input, connection } = rig();
    const controller = new AbortController();
    const first = connection.request("turn/start", {}, { timeoutMs: 1000, signal: controller.signal });
    const second = connection.request("model/list", {}, { timeoutMs: 1000 });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    input.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    input.write('{"jsonrpc":"2.0","id":2,"result":42}\n');
    expect(await second).toBe(42);
    connection.close();
  });

  test("enforces pending and line bounds, failing every pending call on a malformed stream", async () => {
    const { input, connection } = rig({ maxLineBytes: 128, maxPending: 1 });
    const request = connection.request("initialize", {}, { timeoutMs: 1000 });
    await expect(connection.request("model/list", {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "too_many_pending" });
    input.write(Buffer.alloc(129, 65));
    await expect(request).rejects.toMatchObject({ code: "line_too_large" });
    await expect(connection.request("model/list", {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "closed" });
  });

  test("reports truncated EOF and never includes remote error text", async () => {
    const a = rig();
    const first = a.connection.request("initialize", {}, { timeoutMs: 1000 });
    a.input.end('{"jsonrpc":"2.0"');
    await expect(first).rejects.toMatchObject({ code: "truncated_message" });
    const b = rig();
    const second = b.connection.request("initialize", {}, { timeoutMs: 1000 });
    b.input.write('{"jsonrpc":"2.0","id":1,"error":{"message":"sensitive upstream text"}}\n');
    await expect(second).rejects.toMatchObject({ code: "remote_error", message: "Muse MSP: remote_error" });
    b.connection.close();
  });

  test("sends initialized as a notification and times out a silent peer", async () => {
    const { written, connection } = rig();
    await connection.notify("initialized");
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", method: "initialized" });
    await expect(connection.request("model/list", {}, { timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
    connection.close();
  });

  test("a broken writer rejects the pending request with a redacted error", async () => {
    const input = new PassThrough();
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("private transport detail")); } });
    const connection = new MuseMspConnection(input, output, () => {});
    // The process owner also observes its child streams; the connection does not own them.
    output.on("error", () => {});
    await expect(connection.request("initialize", {}, { timeoutMs: 1000 })).rejects.toMatchObject({
      message: "Muse MSP: write_failed", code: "write_failed",
    });
  });

  test("acknowledges server requests independently of matching client request IDs", async () => {
    const { input, written, received, connection } = rig();
    const pending = connection.request("turn/start", {}, { timeoutMs: 1000 });
    input.write('{"jsonrpc":"2.0","id":1,"method":"approval/request","params":{"toolCallId":"call"}}\n');
    expect(received[0]).toMatchObject({ id: 1, method: "approval/request" });
    await expect(connection.respond(1, undefined)).rejects.toMatchObject({ code: "invalid_response" });
    await connection.respond(1, {});
    expect(JSON.parse(written[1]!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    await expect(connection.respond(1, {})).rejects.toMatchObject({ code: "unknown_server_request" });
    input.write('{"jsonrpc":"2.0","id":1,"result":{"status":"accepted"}}\n');
    expect(await pending).toEqual({ status: "accepted" });
    connection.close();
  });

  test("duplicate in-flight server request IDs fail closed", async () => {
    const { input, connection } = rig();
    const pending = connection.request("turn/start", {}, { timeoutMs: 1000 });
    input.write('{"jsonrpc":"2.0","id":"a","method":"approval/request"}\n');
    input.write('{"jsonrpc":"2.0","id":"a","method":"approval/request"}\n');
    await expect(pending).rejects.toMatchObject({ code: "invalid_message" });
  });
});

describe("Muse MSP handshake", () => {
  test("requires and negotiates session MCP before sending initialized", async () => {
    const { input, written, connection } = rig();
    const result = initializeMuseMsp(connection, { timeoutMs: 1000, requireEphemeral: true });
    expect(JSON.parse(written[0]!)).toMatchObject({ method: "initialize", params: { capabilities: { requestedCapabilities: ["sessionMcp"] } } });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      serverInfo: { name: "muse", version: "1.4.14" }, schema: { version: 1 },
      grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral",
    } }) + "\n");
    expect(await result).toEqual({ serverVersion: "1.4.14", schemaVersion: 1, sessionDurability: "ephemeral" });
    expect(JSON.parse(written[1]!)).toEqual({ jsonrpc: "2.0", method: "initialized" });
    connection.close();
  });

  test("refuses missing capability, unknown schemas and durable sessions before initialized", async () => {
    for (const sample of [
      { schema: { version: 1 }, grantedCapabilities: [], sessionDurability: "ephemeral", code: "incompatible_host" },
      { schema: { version: 2 }, grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral", code: "incompatible_host" },
      { schema: { version: 1 }, grantedCapabilities: ["sessionMcp"], sessionDurability: "durable", code: "durable_session_refused" },
    ]) {
      const { input, written, connection } = rig();
      const promise = initializeMuseMsp(connection, { timeoutMs: 1000, requireEphemeral: true });
      input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "1.4.14" }, ...sample } }) + "\n");
      await expect(promise).rejects.toMatchObject({ code: sample.code });
      expect(written).toHaveLength(1);
      await expect(connection.request("session/start", {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: "closed" });
    }
  });

  test("times out when initialized cannot be written", async () => {
    const input = new PassThrough();
    let writes = 0;
    const output = new Writable({ write(_chunk, _encoding, callback) { if (++writes === 1) callback(); } });
    output.on("error", () => {});
    const connection = new MuseMspConnection(input, output, () => {});
    const promise = initializeMuseMsp(connection, { timeoutMs: 10, requireEphemeral: true });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      serverInfo: { version: "1.4.14" }, schema: { version: 1 },
      grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral",
    } }) + "\n");
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("Muse approval capture", () => {
  const event = () => ({
    jsonrpc: "2.0", method: "approval/requested", params: {
      sessionId: "session", turnId: "turn", approvalId: "approval", toolCallId: "call",
      toolName: "mcp__capture__exec_command", rawArgs: '{"cmd":"echo test"}',
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
      availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
    },
  });
  const capture = (max = 16) => new MuseApprovalCapture("session", "turn", new Map([["mcp__capture__exec_command", "exec_command"]]), max);

  test("deduplicates notification and server request without approving the tool", () => {
    const state = capture();
    const first = state.capture(event());
    const second = state.capture({ ...event(), method: "approval/request", id: 7 });
    expect(first).toMatchObject({ callId: "call", clientToolName: "exec_command", duplicate: false });
    expect(second).toMatchObject({ callId: "call", requestId: 7, duplicate: true });
    expect(first).not.toHaveProperty("requestId");
  });

  test("rejects wrong scope, undeclared tools, malformed args and unsafe choice", () => {
    const state = capture();
    expect(() => state.capture({ ...event(), params: { ...event().params, sessionId: "other" } })).toThrow("invalid_approval");
    expect(() => state.capture({ ...event(), params: { ...event().params, toolName: "muse.read_file" } })).toThrow("undeclared_tool");
    expect(() => state.capture({ ...event(), params: { ...event().params, rawArgs: "[]" } })).toThrow("invalid_tool_arguments");
    expect(() => state.capture({ ...event(), params: { ...event().params, availableChoices: [{ choiceId: "allow_session", decision: "approvedForSession", scope: "session" }] } })).toThrow("approval_choice_unavailable");
    expect(state.capture(event())?.duplicate).toBe(false);
  });

  test("rejects changed calls, call-id reuse and excess approvals", () => {
    const state = capture(1);
    state.capture(event());
    expect(() => state.capture({ ...event(), params: { ...event().params, rawArgs: '{"cmd":"other"}' } })).toThrow("conflicting_approval");
    expect(() => state.capture({ ...event(), params: { ...event().params, approvalId: "another", currentRequirementId: { approvalId: "another", sourceIndex: 0 } } })).toThrow("conflicting_approval");
    expect(() => state.capture({ ...event(), params: { ...event().params, approvalId: "another", toolCallId: "another-call", currentRequirementId: { approvalId: "another", sourceIndex: 0 } } })).toThrow("too_many_approvals");
  });

  test("invalid server request does not consume the approval", () => {
    const state = capture();
    expect(() => state.capture({ ...event(), method: "approval/request", id: null })).toThrow("invalid_approval");
    expect(state.capture(event())?.duplicate).toBe(false);
  });
});

describe("Muse MSP session commands", () => {
  const options = { timeoutMs: 1000 };
  const config = { workspaceRoot: process.cwd(), modelId: "fake-model", captureServer: { command: process.execPath, args: ["capture"] } };
  const ids = () => { let n = 0; return () => `test-command-${++n}`; };

  test("opens an isolated capture session, starts, admits a captured tool once, and cancels", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const mock: MuseMspRequester = { async request(method, params) {
      calls.push({ method, params });
      if (method === "session/start") return { session: { sessionId: "session" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "started", turnId: "turn" };
      if (method === "approval/decide") return { commandId: params.commandId, status: "accepted", approvalId: params.approvalId, terminal: true };
      if (method === "turn/cancel") return { commandId: params.commandId, status: "accepted", turnId: params.turnId };
      throw new Error("unexpected method");
    } };
    const session = await MuseMspSession.open(mock, config, options, ids());
    expect(calls[0]!.params).toMatchObject({ approvalMode: "promptUnmatched", config: { mcpServers: { opencodex: { mode: "required", transport: "stdio" } } } });
    expect(await session.startTurn("hello", "high", options)).toBe("turn");
    const capture = session.captureForTurn("turn", new Map([["mcp__opencodex__tool", "tool"]]));
    const approval = capture.capture({ method: "approval/requested", params: {
      sessionId: "session", turnId: "turn", approvalId: "approval", toolCallId: "call", toolName: "mcp__opencodex__tool", rawArgs: "{}",
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
    } })!;
    await expect(session.admitCapture("wrong-turn", capture, approval, options)).rejects.toMatchObject({ code: "unowned_approval" });
    await session.admitCapture("turn", capture, approval, options);
    await expect(session.admitCapture("turn", capture, approval, options)).rejects.toMatchObject({ code: "unowned_approval" });
    expect(calls[2]!.params).toMatchObject({ sessionId: "session", approvalId: "approval", choiceId: "allow_once" });
    await session.cancelTurn("turn", options);
    expect(calls[3]!.params).toMatchObject({ sessionId: "session", turnId: "turn" });
    expect(() => session.finishTurn({ method: "turn/completed", params: { sessionId: "other", turnId: "turn", terminal: "completed" } })).toThrow("invalid_turn_terminal");
    expect(() => session.finishTurn({ method: "turn/foregroundCompleted", params: { sessionId: "session", turnId: "turn", terminal: "completed" } })).toThrow("invalid_turn_terminal");
    session.finishTurn({ method: "turn/completed", params: { sessionId: "session", turnId: "turn", terminal: "cancelled" } });
    await expect(session.admitCapture("turn", capture, approval, options)).rejects.toMatchObject({ code: "unowned_approval" });
  });

  test("accepts a queued turn only when explicitly enabled", async () => {
    const mock: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "session" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: "queued", turnId: "queued-turn" };
      throw new Error("unexpected");
    } };
    const session = await MuseMspSession.open(mock, config, options, ids());
    expect(await session.startTurn("hello", undefined, { ...options, allowQueued: true })).toBe("queued-turn");
    expect(session.captureForTurn("queued-turn", new Map())).toBeDefined();
    session.finishTurn({ method: "turn/completed", params: { sessionId: "session", turnId: "queued-turn", terminal: "completed" } });
  });

  test("fails closed on relative executable, queued turns and nonterminal approvals", async () => {
    let queued = true;
    const valid: MuseMspRequester = { async request(method, params) {
      if (method === "session/start") return { session: { sessionId: "session" } };
      if (method === "turn/start") return { commandId: params.commandId, status: "accepted", disposition: queued ? "queued" : "started", turnId: "turn" };
      return { commandId: params.commandId, status: "accepted", approvalId: params.approvalId, terminal: false };
    } };
    await expect(MuseMspSession.open(valid, { ...config, captureServer: { command: "relative", args: [] } }, options)).rejects.toMatchObject({ code: "invalid_session_config" });
    const session = await MuseMspSession.open(valid, config, options, ids());
    await expect(session.startTurn("hello", undefined, options)).rejects.toMatchObject({ code: "invalid_turn_response" });
    await expect(session.startTurn("hello", undefined, options)).rejects.toMatchObject({ code: "session_unusable" });
    queued = false;
    const secondSession = await MuseMspSession.open(valid, config, options, ids());
    await secondSession.startTurn("hello", undefined, options);
    const capture = secondSession.captureForTurn("turn", new Map([["mcp__opencodex__tool", "tool"]]));
    const approval = capture.capture({ method: "approval/requested", params: {
      sessionId: "session", turnId: "turn", approvalId: "approval", toolCallId: "call", toolName: "mcp__opencodex__tool", rawArgs: "{}",
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
    } })!;
    await expect(secondSession.admitCapture("turn", capture, approval, options)).rejects.toMatchObject({ code: "invalid_approval_response" });
    await expect(secondSession.admitCapture("turn", capture, approval, options)).rejects.toMatchObject({ code: "unowned_approval" });
  });

  test("passes a valid capture capability via MCP environment, not arguments", async () => {
    let start: Record<string, unknown> | undefined;
    const mock: MuseMspRequester = { async request(_method, params) { start = params; return { session: { sessionId: "session" } }; } };
    const token = "a".repeat(64);
    await MuseMspSession.open(mock, { ...config, captureServer: { ...config.captureServer,
      env: { OCX_MUSE_CAPTURE_PORT: "12345", OCX_MUSE_CAPTURE_TOKEN: token } } }, options, ids());
    const server = (start!.config as { mcpServers: { opencodex: { args: string[]; env: Record<string, string> } } }).mcpServers.opencodex;
    expect(server.env).toEqual({ OCX_MUSE_CAPTURE_PORT: "12345", OCX_MUSE_CAPTURE_TOKEN: token });
    expect(JSON.stringify(server.args)).not.toContain(token);
    await expect(MuseMspSession.open(mock, { ...config, captureServer: { ...config.captureServer,
      env: { OCX_MUSE_CAPTURE_PORT: "65536", OCX_MUSE_CAPTURE_TOKEN: token } } }, options, ids())).rejects.toThrow("invalid_session_config");
  });
});

describe("Muse MSP early-event inbox", () => {
  test("retains events before the turn acknowledgement and preserves unrelated ordering", async () => {
    const inbox = new MuseMspInbox();
    inbox.push({ method: "turn/started", params: { turnId: "a" } });
    inbox.push({ method: "approval/requested", params: { turnId: "a" } });
    expect(await inbox.take(m => m.method === "approval/requested", { timeoutMs: 1000 })).toMatchObject({ method: "approval/requested" });
    expect(await inbox.take(m => m.method === "turn/started", { timeoutMs: 1000 })).toMatchObject({ method: "turn/started" });
    inbox.close();
  });

  test("cancellation does not consume later events and a second waiter is refused", async () => {
    const inbox = new MuseMspInbox();
    const controller = new AbortController();
    const pending = inbox.take(m => m.method === "wanted", { timeoutMs: 1000, signal: controller.signal });
    await expect(inbox.take(() => true, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "inbox_busy" });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    inbox.push({ method: "wanted" });
    expect(await inbox.take(() => true, { timeoutMs: 1000 })).toEqual({ method: "wanted" });
    inbox.close();
  });

  test("overflow fails closed and discharges a pending waiter", async () => {
    const inbox = new MuseMspInbox(1, 1024);
    const pending = inbox.take(m => m.method === "wanted", { timeoutMs: 1000 });
    inbox.push({ method: "other" });
    inbox.push({ method: "another" });
    await expect(pending).rejects.toMatchObject({ code: "inbox_overflow" });
    await expect(inbox.take(() => true, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "inbox_overflow" });
  });
});

test("fake host preserves an approval arriving before turn/start acknowledgement", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const inbox = new MuseMspInbox();
  const connection = new MuseMspConnection(input, output, message => inbox.push(message));
  const methods: string[] = [];
  const reply = (id: unknown, result: unknown) => input.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  output.on("data", chunk => {
    const message = JSON.parse(String(chunk)) as Record<string, unknown>;
    if (typeof message.method !== "string") return;
    methods.push(message.method);
    const params = message.params as Record<string, unknown> | undefined;
    if (message.method === "initialize") reply(message.id, { serverInfo: { version: "1.4.14" }, schema: { version: 1 }, grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral" });
    if (message.method === "session/start") reply(message.id, { session: { sessionId: "session" } });
    if (message.method === "turn/start") {
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "approval/requested", params: {
        sessionId: "session", turnId: "turn", approvalId: "approval", toolCallId: "call", toolName: "mcp__opencodex__tool", rawArgs: "{}",
        currentRequirementId: { approvalId: "approval", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
      } }) + "\n");
      reply(message.id, { commandId: params!.commandId, status: "accepted", disposition: "started", turnId: "turn" });
    }
    if (message.method === "approval/decide") reply(message.id, { commandId: params!.commandId, status: "accepted", approvalId: "approval", terminal: true });
    if (message.method === "turn/cancel") reply(message.id, { commandId: params!.commandId, status: "accepted", turnId: "turn" });
  });
  try {
    await initializeMuseMsp(connection, { timeoutMs: 1000, requireEphemeral: true });
    const session = await MuseMspSession.open(connection, {
      workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: ["capture"] },
    }, { timeoutMs: 1000 });
    const turn = await session.startTurn("hello", undefined, { timeoutMs: 1000 });
    const capture = session.captureForTurn(turn, new Map([["mcp__opencodex__tool", "tool"]]));
    const event = await inbox.take(message => message.method === "approval/requested", { timeoutMs: 1000 });
    const approval = capture.capture(event)!;
    expect(approval).toMatchObject({ callId: "call", clientToolName: "tool" });
    await session.admitCapture(turn, capture, approval, { timeoutMs: 1000 });
    await session.cancelTurn(turn, { timeoutMs: 1000 });
    expect(methods).toEqual(["initialize", "initialized", "session/start", "turn/start", "approval/decide", "turn/cancel"]);
  } finally {
    inbox.close(); connection.close(); input.destroy(); output.destroy();
  }
});

test("captured tool result returns to its mock MCP waiter only after owned continuation", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const inbox = new MuseMspInbox();
  const connection = new MuseMspConnection(input, output, message => inbox.push(message));
  const owner = "d".repeat(64);
  let pending: MusePendingToolResult | undefined;
  let delivered: string | undefined;
  const reply = (id: unknown, result: unknown) => input.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  output.on("data", chunk => {
    const message = JSON.parse(String(chunk)) as Record<string, unknown>;
    const params = message.params as Record<string, unknown> | undefined;
    if (message.method === "initialize") reply(message.id, { serverInfo: { version: "test" }, schema: { version: 1 }, grantedCapabilities: ["sessionMcp"], sessionDurability: "ephemeral" });
    if (message.method === "session/start") reply(message.id, { session: { sessionId: "s" } });
    if (message.method === "turn/start") {
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "approval/requested", params: {
        sessionId: "s", turnId: "t", approvalId: "a", toolCallId: "call", toolName: "mcp__opencodex__tool", rawArgs: '{"value":"test"}',
        currentRequirementId: { approvalId: "a", sourceIndex: 0 }, availableChoices: [{ choiceId: "allow_once", decision: "approved", scope: "once" }],
      } }) + "\n");
      reply(message.id, { commandId: params!.commandId, status: "accepted", disposition: "started", turnId: "t" });
    }
    if (message.method === "approval/decide") {
      pending = new MusePendingToolResult("call", owner, { timeoutMs: 1000 });
      void pending.result.then(result => {
        delivered = result.output;
        input.write(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s", turnId: "t", terminal: "completed" } }) + "\n");
      });
      reply(message.id, { commandId: params!.commandId, status: "accepted", approvalId: "a", terminal: true });
    }
  });
  try {
    await initializeMuseMsp(connection, { timeoutMs: 1000, requireEphemeral: true });
    const session = await MuseMspSession.open(connection, { workspaceRoot: process.cwd(), modelId: "fake", captureServer: { command: process.execPath, args: ["capture"] } }, { timeoutMs: 1000 });
    const turn = await session.startTurn("hello", undefined, { timeoutMs: 1000 });
    const capture = session.captureForTurn(turn, new Map([["mcp__opencodex__tool", "tool"]]));
    const event = await inbox.take(message => message.method === "approval/requested", { timeoutMs: 1000 });
    const approval = capture.capture(event)!;
    await session.admitCapture(turn, capture, approval, { timeoutMs: 1000 });
    expect(pending).toBeDefined();
    expect(() => pending!.submit("e".repeat(64), { callId: "call", output: "foreign" })).toThrow("unowned_tool_result");
    expect(delivered).toBeUndefined();
    pending!.submit(owner, { callId: "call", output: "client result" });
    const terminal = await inbox.take(message => message.method === "turn/completed", { timeoutMs: 1000 });
    session.finishTurn(terminal);
    expect(delivered).toBe("client result");
    expect(() => pending!.submit(owner, { callId: "call", output: "duplicate" })).toThrow("tool_result_settled");
  } finally {
    pending?.close(); inbox.close(); connection.close(); input.destroy(); output.destroy();
  }
});

describe("Muse captured tool result", () => {







  test("request-scoped budget lease is released when its runner fails", async () => {
    const slot = new MuseBudgetSlot(), translatorBudget = createTranslatorBudget();
    const incoming = { headers: new Headers(), translatorBudget };
    try {
      await expect(withMuseBudgetLease(slot, incoming, "muse|fake", async () => { throw new Error("synthetic failure"); })).rejects.toThrow("synthetic failure");
      const next = slot.bind(incoming, "muse|fake");
      next.close();
    } finally { slot.close(); translatorBudget.dispose(); }
  });



  test("opaque segment retains its producer through success and failure", async () => {
    const policy = { maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0 };
    const translatorBudget = createTranslatorBudget(), slot = new MuseBudgetSlot();
    let active = 0;
    const meta = () => { const sendBudget = createRequestExecutionBudget(policy, "mock-segment");
      sendBudget.beginSpendProducer = () => { active++; return { close: () => { active--; } }; };
      return { headers: new Headers(), translatorBudget, sendBudget }; };
    try {
      await withMuseOpaqueSegment(slot, meta(), "muse|fake", async () => { expect(active).toBe(1); });
      expect(active).toBe(0);
      let failed = false;
      try { await withMuseOpaqueSegment(slot, meta(), "muse|fake", async () => { expect(active).toBe(1); throw new Error("fixture"); }); }
      catch { failed = true; }
      expect(failed).toBe(true); expect(active).toBe(0);
    } finally { slot.close(); translatorBudget.dispose(); }
  });

  test("budget slot retains spend producer and blocks replacement until send finishes", () => {
    const policy = { maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0 };
    const translatorBudget = createTranslatorBudget(), budget = createRequestExecutionBudget(policy, "mock-flight"), slot = new MuseBudgetSlot();
    let activeProducers = 0;
    budget.beginSpendProducer = () => { activeProducers++; return { close: () => { activeProducers--; } }; };
    const incoming = { headers: new Headers(), translatorBudget, sendBudget: budget };
    try {
      const lease = slot.bind(incoming, "muse|fake");
      const finish = lease.beginSend();
      expect(activeProducers).toBe(1);
      lease.close();
      expect(() => lease.beginSend()).toThrow("budget_slot_unavailable");
      expect(() => slot.bind(incoming, "muse|fake")).toThrow("budget_slot_unavailable");
      finish(); finish();
      expect(activeProducers).toBe(0);
      const next = slot.bind(incoming, "muse|fake");
      next.close();
    } finally { slot.close(); translatorBudget.dispose(); }
  });

  test("budget slot refuses overlaps and stale leases across two request budgets", () => {
    const policy = { maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0 };
    const translatorBudget = createTranslatorBudget(), slot = new MuseBudgetSlot();
    const meta = () => ({ headers: new Headers(), translatorBudget, sendBudget: createRequestExecutionBudget(policy, "mock-slot") });
    try {
      expect(() => slot.bind(meta(), "")).toThrow("invalid_budget_target");
      const first = slot.bind(meta(), "muse|fake");
      expect(() => slot.bind(meta(), "muse|fake")).toThrow("budget_slot_unavailable");
      first.admit();
      expect(() => first.admit()).toThrow();
      first.close();
      const second = slot.bind(meta(), "muse|fake");
      first.close();
      expect(() => first.admit()).toThrow("budget_slot_unavailable");
      second.admit();
      expect(() => second.admit()).toThrow();
      slot.close();
      expect(() => second.admit()).toThrow("budget_slot_unavailable");
      expect(() => slot.bind(meta(), "muse|fake")).toThrow("budget_slot_unavailable");
    } finally { slot.close(); translatorBudget.dispose(); }
  });

  const owner = "a".repeat(64);
  test("experimental opaque dispatch fence denies exhausted budgets before releasing a tool result", async () => {
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 1, baseSendAllowance: 1,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, "muse-fake-budget");
    const translatorBudget = createTranslatorBudget();
    const incoming = { headers: new Headers(), translatorBudget, sendBudget: budget };
    const first = createMuseOpaqueBudgetFence(incoming, "muse|fake");
    const second = createMuseOpaqueBudgetFence(incoming, "muse|fake");
    const pending = new MusePendingToolResult("call", owner, { timeoutMs: 1000 });
    try {
      first.admit(); first.close();
      expect(() => pending.submit(owner, { callId: "call", output: "result" }, second.admit)).toThrow();
      pending.submit(owner, { callId: "call", output: "result" });
      expect((await pending.result).output).toBe("result");
      expect(budget.used).toBe(1);
    } finally { first.close(); second.close(); translatorBudget.dispose(); }
  });

  test("dispatch fence runs only after validation and can refuse without consuming the result", async () => {
    const pending = new MusePendingToolResult("call", owner, { timeoutMs: 1000 });
    let fences = 0;
    let admitted: Readonly<{ callId: string; output: string }> | undefined;
    expect(() => pending.submit("b".repeat(64), { callId: "call", output: "x" }, () => { fences++; })).toThrow("unowned_tool_result");
    expect(fences).toBe(0);
    expect(() => pending.submit(owner, { callId: "call", output: "x" }, () => { fences++; throw new Error("denied"); })).toThrow("denied");
    expect(fences).toBe(1);
    pending.submit(owner, { callId: "call", output: "ok" }, result => { fences++; admitted = result; });
    expect(await pending.result).toEqual({ callId: "call", output: "ok" });
    expect(admitted).toEqual({ callId: "call", output: "ok" });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(fences).toBe(2);
  });

  test("accepts only its owner and exact call, once", async () => {
    const pending = new MusePendingToolResult("call-1", owner, { timeoutMs: 1000, maxOutputBytes: 8 });
    expect(() => pending.submit("b".repeat(64), { callId: "call-1", output: "wrong" })).toThrow("unowned_tool_result");
    expect(() => pending.submit(owner, { callId: "call-2", output: "wrong" })).toThrow("invalid_tool_result");
    expect(() => pending.submit(owner, { callId: "call-1", output: "123456789" })).toThrow("invalid_tool_result");
    pending.submit(owner, { callId: "call-1", output: "ok" });
    expect(await pending.result).toEqual({ callId: "call-1", output: "ok" });
    expect(() => pending.submit(owner, { callId: "call-1", output: "duplicate" })).toThrow("tool_result_settled");
  });

  test("two sessions with the same tool call id remain isolated", async () => {
    const first = new MusePendingToolResult("same", owner, { timeoutMs: 1000 });
    const second = new MusePendingToolResult("same", "b".repeat(64), { timeoutMs: 1000 });
    expect(() => second.submit(owner, { callId: "same", output: "leak" })).toThrow("unowned_tool_result");
    first.submit(owner, { callId: "same", output: "first" });
    second.submit("b".repeat(64), { callId: "same", output: "second" });
    expect(await first.result).toEqual({ callId: "same", output: "first" });
    expect(await second.result).toEqual({ callId: "same", output: "second" });
  });

  test("abort, timeout and close discharge pending waits and forbid later results", async () => {
    const controller = new AbortController();
    const aborted = new MusePendingToolResult("call", owner, { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await expect(aborted.result).rejects.toMatchObject({ code: "cancelled" });
    expect(() => aborted.submit(owner, { callId: "call", output: "late" })).toThrow("tool_result_settled");
    const timed = new MusePendingToolResult("call", owner, { timeoutMs: 5 });
    await expect(timed.result).rejects.toMatchObject({ code: "timeout" });
    const closed = new MusePendingToolResult("call", owner, { timeoutMs: 1000 });
    closed.close();
    await expect(closed.result).rejects.toMatchObject({ code: "closed" });
  });
});

describe("Muse continuation ownership", () => {

  test("existing route binding cannot identify a local CLI-owned credential", () => {
    const parsed = parseRequest({ model: "muse", input: [{ role: "user", content: "hello" }] });
    parsed._reasoningReplayScope = { clientThreadId: "thread", clientPrincipalId: "a".repeat(64) };
    bindRouteReasoningReplayScope({ parsed, providerName: "muse-code", adapterName: "muse-msp",
      provider: { baseUrl: "http://127.0.0.1", authMode: "local" } as never });
    expect(parsed._reasoningReplayScope.current).toBeUndefined();
    expect(museContinuationOwner(parsed)).toBeUndefined();
  });

  test("keyless native Muse routes bind only the private session owner", () => {
    const forged = parseRequest({ model: "muse", input: [{ role: "user", content: "hello" }], _museNativeRoute: { providerName: "attacker" } });
    expect(forged._museNativeRoute).toBeUndefined();
    const parsed = parseRequest({ model: "muse", input: [{ role: "user", content: "hello" }] });
    parsed._reasoningReplayScope = { clientThreadId: "thread", clientPrincipalId: "a".repeat(64) };
    const provider = { adapter: "muse-msp", baseUrl: "https://api.meta.ai/v1", authMode: "key" } as const;
    bindRouteReasoningReplayScope({ parsed, providerName: "muse-code", adapterName: "muse-msp", provider });
    expect(parsed._reasoningReplayScope.current).toBeUndefined();
    expect(museContinuationOwner(parsed)).toMatch(/^[0-9a-f]{64}$/);
    const owned = museContinuationOwner(parsed);
    parsed._reasoningReplayScope.clientPrincipalId = "b".repeat(64);
    expect(museContinuationOwner(parsed)).not.toBe(owned);
    bindRouteReasoningReplayScope({ parsed, providerName: "muse-code", adapterName: "muse-msp", provider: { ...provider, apiKey: "dummy" } });
    expect(parsed._museNativeRoute).toBeUndefined();
    bindRouteReasoningReplayScope({ parsed, providerName: "other", adapterName: "claude-cli", provider });
    expect(parsed._museNativeRoute).toBeUndefined();
  });

  const request = (): OcxParsedRequest => ({
    modelId: "muse", context: { messages: [] }, stream: true, options: {},
    _reasoningReplayScope: {
      clientPrincipalId: "a".repeat(64), clientThreadId: "parent",
      current: { providerName: "muse-code", providerDestinationIdentity: "dest", adapterName: "muse-msp", modelId: "muse", credentialIdentity: "credential" },
    },
  });
  test("binds stable owner to principal, individual thread and physical route", () => {
    const original = request(); original._codexOwnThreadId = "thread-one";
    const owner = museContinuationOwner(original);
    expect(owner).toMatch(/^[0-9a-f]{64}$/);
    expect(museContinuationOwner(original)).toBe(owner);
    const sibling = request(); sibling._codexOwnThreadId = "thread-two";
    expect(museContinuationOwner(sibling)).not.toBe(owner);
    const otherPrincipal = request(); otherPrincipal._codexOwnThreadId = "thread-one";
    otherPrincipal._reasoningReplayScope = { ...otherPrincipal._reasoningReplayScope!, clientPrincipalId: "b".repeat(64) };
    expect(museContinuationOwner(otherPrincipal)).not.toBe(owner);
    const changedRoute = request(); changedRoute._codexOwnThreadId = "thread-one";
    changedRoute._reasoningReplayScope = { ...changedRoute._reasoningReplayScope!, current: { ...changedRoute._reasoningReplayScope!.current!, credentialIdentity: "other" } };
    expect(museContinuationOwner(changedRoute)).not.toBe(owner);
  });

  test("rejects keyless, unbound, ambiguous and malformed ownership", () => {
    const keyless = request(); keyless._reasoningReplayScope = { ...keyless._reasoningReplayScope!, clientPrincipalId: undefined };
    keyless._codexOwnThreadId = "attacker-controlled";
    expect(museContinuationOwner(keyless)).toBeUndefined();
    const unbound = request(); unbound._reasoningReplayScope = { ...unbound._reasoningReplayScope!, current: undefined };
    expect(museContinuationOwner(unbound)).toBeUndefined();
    const shared = request(); shared._promptCacheKeyIsSharedCohort = true;
    expect(museContinuationOwner(shared)).toBeUndefined();
    shared._codexOwnThreadId = "actual-child";
    expect(museContinuationOwner(shared)).toMatch(/^[0-9a-f]{64}$/);
    const malformed = request(); malformed._codexOwnThreadId = "invalid id with spaces";
    expect(museContinuationOwner(malformed)).toBeUndefined();
  });
});

describe("Muse pending registry", () => {
  const owner = "a".repeat(64), other = "b".repeat(64), history = "c".repeat(64);
  test("uses opaque unique client IDs and binds owner, history and upstream call", async () => {
    const registry = new MusePendingRegistry();
    const first = registry.register(owner, "upstream-id", history, { timeoutMs: 1000 });
    const second = registry.register(other, "upstream-id", history, { timeoutMs: 1000 });
    expect(first.clientCallId).toMatch(/^msp_[0-9a-f]{48}$/);
    expect(first.clientCallId).not.toBe(second.clientCallId);
    expect(() => registry.submit(other, first.clientCallId, history, "foreign")).toThrow("unavailable_tool_result");
    expect(() => registry.submit(owner, first.clientCallId, "d".repeat(64), "changed")).toThrow("unavailable_tool_result");
    registry.submit(owner, first.clientCallId, history, "first result");
    expect(await first.result).toEqual({ callId: "upstream-id", output: "first result" });
    expect(() => registry.submit(owner, first.clientCallId, history, "replay")).toThrow("unavailable_tool_result");
    registry.submit(other, second.clientCallId, history, "second result");
    expect(await second.result).toEqual({ callId: "upstream-id", output: "second result" });
    registry.close();
  });

  test("bounds pending entries, releases timed-out entries and closes all waiters", async () => {
    const registry = new MusePendingRegistry(1);
    const first = registry.register(owner, "first", history, { timeoutMs: 5 });
    expect(() => registry.register(owner, "second", history, { timeoutMs: 1000 })).toThrow("too_many_pending_tools");
    await expect(first.result).rejects.toMatchObject({ code: "timeout" });
    expect(() => registry.submit(owner, first.clientCallId, history, "late")).toThrow("unavailable_tool_result");
    const second = registry.register(owner, "second", history, { timeoutMs: 1000 });
    registry.close();
    await expect(second.result).rejects.toMatchObject({ code: "closed" });
    expect(() => registry.register(owner, "third", history, { timeoutMs: 1000 })).toThrow("closed");
  });
});
