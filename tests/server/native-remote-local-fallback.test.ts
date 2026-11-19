import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
// Bootstrap-only modules: server/router/adapters are imported only after the gate below.
import { isTestHomeGuardArmed } from "../../src/lib/test-home-guard";
import { getConfigDir } from "../../src/config/paths";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";

type Mode = "healthy" | "tool" | "unauthorized" | "quota" | "reset" | "timeout";
type Wire = "responses" | "chat" | "messages" | "read";
type WireRequest = { path: string; body: Record<string, unknown>; bytes: number; bodyAt: number; closedAt?: number; repliedAt?: number; continuity?: string };
type Double = { role: string; port: number; url: string; calls: WireRequest[]; sockets: Set<Socket>; errors: string[]; backupCalls: number; closed: boolean; onBody?: () => void; stop(): Promise<void> };
let core: typeof import("../../src/server/responses");
let configModule: typeof import("../../src/config");
let combos: typeof import("../../src/combos");
let state: typeof import("../../src/responses/state");
let background: typeof import("../../src/lib/background-work");
let keyring: typeof import("../../src/providers/api-key-resolve");
let ownedSpend: typeof import("../helpers/owned-spend-home");
let upstream: typeof import("../../src/lib/upstream-retry");
let chat: typeof import("../../src/server/chat-completions");
let messages: typeof import("../../src/server/claude-messages");
const originalFetch = globalThis.fetch;
const MODEL = "fixture_native_model";
const HOME_KEY = "fixture-home-key-not-real", LOCAL_KEY = "fixture-local-key-not-real";
const BACKUP_KEY = "fixture-backup-key-not-real";
// CI keeps the mandatory helper regressions. This native proof requires an explicitly clean outer environment.
const proofEnabled = process.env.OCX_NATIVE_PROOF_CREDENTIAL_FREE === "1";
const nativeProof = proofEnabled ? test : test.skip;
const COOLDOWN_MS = 1_500;
let proofRoot = "", baseHome = "", caseHome = "";
let serial = 0, inFlight = 0, keyringAccesses = 0;
let remoteId = "", localId = "", comboId = "";
let doubles: Double[] = [];
let releaseSpend: (() => void) | undefined;

function canonical(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("No canonical ancestor");
    suffix.unshift(basename(ancestor)); ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}
function contained(path: string | undefined): void {
  expect(typeof path).toBe("string");
  const rel = relative(proofRoot, canonical(path!));
  expect(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)).toBe(false);
}

beforeAll(async () => {
  if (!proofEnabled) return;
  expect(process.env.OCX_TEST_PRELOAD_PID).toBe(String(process.pid));
  expect(isTestHomeGuardArmed()).toBe(true);
  expect(process.env.OCX_NATIVE_PROOF_CREDENTIAL_FREE).toBe("1");
  proofRoot = canonical(process.env.OCX_NATIVE_PROOF_ROOT!);
  for (const path of [process.env.HOME, process.env.USERPROFILE, process.env.OPENCODEX_HOME,
    getConfigDir(), process.env.CODEX_HOME, process.env.TEMP, process.env.TMP, process.env.APPDATA,
    process.env.LOCALAPPDATA, process.env.OCX_OWNER_REGISTRY_DIR, process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH]) contained(path);
  const credentialNames = Object.keys(process.env).filter(name => /API_KEY|PASSWORD|SECRET|CREDENTIAL|(?:^|_)TOKEN(?:_|$)/i.test(name)
    && !["OCX_TEST_RUN_LOCK_TOKEN", "OCX_NATIVE_PROOF_CREDENTIAL_FREE"].includes(name));
  expect(credentialNames).toEqual([]);
  baseHome = process.env.OPENCODEX_HOME!;
  console.info("[native-proof] " + JSON.stringify({ stage: "preflight", preloadPidMatch: true, guardArmed: true, canonicalContainment: true, credentialEnvCount: 0 }));
  keyring = await import("../../src/providers/api-key-resolve");
  keyring.setProviderKeychainEntryFactoryForTests(() => { keyringAccesses++; throw new Error("Proof forbids native keyring access"); });
  [core, configModule, combos, state, background, ownedSpend, upstream, chat, messages] = await Promise.all([
    import("../../src/server/responses"), import("../../src/config"), import("../../src/combos"),
    import("../../src/responses/state"), import("../../src/lib/background-work"), import("../helpers/owned-spend-home"),
    import("../../src/lib/upstream-retry"), import("../../src/server/chat-completions"), import("../../src/server/claude-messages"),
  ]);
}, 60_000);

beforeEach(() => {
  if (!proofEnabled) return;
  expect(globalThis.fetch).toBe(originalFetch);
  serial++; doubles = []; inFlight = 0;
  remoteId = `proof_remote_${serial}`; localId = `proof_local_${serial}`; comboId = `proof_pair_${serial}`;
  caseHome = mkdtempSync(join(baseHome, "native-proof-"));
  process.env.OPENCODEX_HOME = caseHome;
  contained(getConfigDir());
  combos.clearComboSelectionState(); combos.clearComboTargetCooldowns();
  state.clearResponseStateForTests();
  releaseSpend = ownedSpend.acquireOwnedSpendHome();
});

afterEach(async () => {
  if (!background) return;
  const failures: unknown[] = [];
  for (const double of doubles) try { await double.stop(); } catch (error) { failures.push(error); }
  try { await state.flushResponseState(); state.setResponseStatePersistAttemptHookForTests(null); state.clearResponseStateForTests(); } catch (error) { failures.push(error); }
  try { releaseSpend?.(); } catch (error) { failures.push(error); } finally { releaseSpend = undefined; }
  combos.clearComboTargetCooldowns(); combos.clearComboSelectionState();
  const settled = await background.settleBackgroundWork({ timeoutMs: 10_000 });
  const residue = { requests: inFlight, sockets: doubles.reduce((n, d) => n + d.sockets.size, 0),
    listeners: doubles.filter(d => !d.closed).length, spendLease: releaseSpend !== undefined,
    pending: settled.pending, keyringAccesses, fixtureErrors: doubles.flatMap(d => d.errors), cleanupFailures: failures.length };
  console.info("[native-proof] " + JSON.stringify({ stage: "drain", ...residue }));
  process.env.OPENCODEX_HOME = baseHome;
  expect(residue).toEqual({ requests: 0, sockets: 0, listeners: 0, spendLease: false, pending: [], keyringAccesses: 0, fixtureErrors: [], cleanupFailures: 0 });
  expect(globalThis.fetch).toBe(originalFetch);
  // No case tree is deleted here. The official preload/wrapper owns removal after drain.
}, 60_000);

afterAll(() => { keyring?.setProviderKeychainEntryFactoryForTests(null); });

async function tcpDouble(role: "home" | "local", mode: Mode, port = 0, wire: Wire = "responses"): Promise<Double> {
  const calls: WireRequest[] = [], sockets = new Set<Socket>(), errors: string[] = [];
  let firstToolId = "", firstResponseId = "";
  let server: Server;
  let stopping = false;
  const double: Double = { role, port: 0, url: "", calls, sockets, errors, backupCalls: 0, closed: false, async stop() {
    if (double.closed) return;
    stopping = true;
    const closed = new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    for (const socket of sockets) socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned listener did not drain")), 2_000); })]); }
    finally { clearTimeout(timer); }
    await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
    if (sockets.size) throw new Error("Owned sockets remain");
    double.closed = true;
  } };
  server = createServer(socket => {
    sockets.add(socket);
    let record: WireRequest | undefined;
    socket.on("close", () => {
      sockets.delete(socket);
      if (record) {
        record.closedAt = performance.now();
        console.info("[native-proof] " + JSON.stringify({ stage: "socket-close", serial, role, mode,
          bodyBeforeClose: record.bodyAt <= record.closedAt, closeAfterBodyMs: Math.round(record.closedAt - record.bodyAt), replied: record.repliedAt !== undefined }));
      }
    });
    socket.on("error", error => {
      const code = (error as NodeJS.ErrnoException).code ?? error.name;
      if (mode === "timeout" && ["ECONNRESET", "EPIPE"].includes(code)) {
        console.info("[native-proof] " + JSON.stringify({ stage: "peer-cancel", serial, role, mode, code, bodyReceived: record !== undefined }));
      } else if (!stopping && mode !== "reset") errors.push(`socket_error:${code}`);
    });
    let bytes = Buffer.alloc(0), handled = false;
    const send = (status: number, payload: unknown, extra = "") => {
      const body = JSON.stringify(payload);
      if (record) record.repliedAt = performance.now();
      socket.end(`HTTP/1.1 ${status} ${status === 200 ? "OK" : "Fixture Error"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`);
    };
    socket.on("data", chunk => {
      if (handled) return;
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      if (bytes.length > 1024 * 1024) { errors.push("oversized_fixture_request"); socket.destroy(); return; }
      const headEnd = bytes.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = bytes.subarray(0, headEnd).toString();
      const method = head.split(" ")[0]!;
      const length = /\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1];
      if (length === undefined && wire !== "read") { errors.push("missing_content_length"); socket.destroy(); return; }
      const size = Number(length ?? 0);
      if (bytes.length < headEnd + 4 + size) return;
      handled = true;
      let body: Record<string, unknown>;
      try { body = size ? JSON.parse(bytes.subarray(headEnd + 4, headEnd + 4 + size).toString()) : {}; }
      catch { errors.push("invalid_request_json"); socket.destroy(); return; }
      const path = head.split("\r\n")[0]!.split(" ")[1]!;
      record = { path, body, bytes: size, bodyAt: performance.now() }; calls.push(record);
      const key = role === "home" ? HOME_KEY : LOCAL_KEY;
      const lower = head.toLowerCase();
      const expectedPath = wire === "chat" ? "/v1/chat/completions" : wire === "messages" ? "/v1/messages" : "/v1/responses";
      const header = wire === "messages" ? "x-api-key: " : "authorization: bearer ";
      const credentialMatches = [key, BACKUP_KEY].some(value => lower.includes(header + value));
      if (lower.includes(header + BACKUP_KEY)) double.backupCalls++;
      if ((wire === "read" ? !["GET", "HEAD"].includes(method) : method !== "POST") || path !== expectedPath || !credentialMatches) {
        errors.push("wrong_native_wire_or_fixture_key"); send(400, { error: { code: "fixture_wire_mismatch" } }); return;
      }
      double.onBody?.();
      if (mode === "reset") { socket.destroy(); return; }
      if (mode === "timeout") return; // Full body received; deliberately never send response headers.
      if (mode === "unauthorized") { send(401, { error: { type: "authentication_error", code: "invalid_api_key", message: "Fixture key rejected" } }); return; }
      if (mode === "quota") { send(429, { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Fixture quota reached" } }, "Retry-After: 1\r\n"); return; }
      const input = Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
      const result = input.find(item => item.type === "function_call_output");
      if (mode === "tool" && result) {
        const forwarded = body.previous_response_id === firstResponseId;
        const replayed = input.some(item => item.type === "function_call" && item.call_id === firstToolId)
          && JSON.stringify(input).includes("fixture prompt");
        if (result.call_id !== firstToolId || (!forwarded && !replayed)) {
          errors.push("lost_tool_continuity"); send(400, { error: { code: "fixture_continuity_mismatch" } }); return;
        }
        record.continuity = forwarded ? "previous_response_id" : "replayed-prefix";
      }
      const id = `resp_fixture_${serial}_${role}_${calls.length}`;
      const tool = mode === "tool" && !result;
      if (tool) { firstResponseId = id; firstToolId = `call_fixture_${serial}_${role}_1`; }
      const output = tool ? [{ id: `fc_fixture_${serial}_${role}`, type: "function_call", status: "completed", call_id: firstToolId, name: "fixture_echo", arguments: '{"value":"ping"}' }]
        : [{ id: `msg_fixture_${serial}_${role}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `fixture ${role} answer`, annotations: [] }] }];
      send(200, { id, object: "response", created_at: 1, status: "completed", model: MODEL, output,
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
    });
  });
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", ready); });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new Error("Non-loopback fixture listener");
  double.port = address.port; double.url = `http://127.0.0.1:${address.port}`;
  doubles.push(double);
  return double;
}

function configuration(home: Double, local: Double, connectTimeoutMs = 2_000, wire: Wire = "responses"): OcxConfig {
  const adapter = wire === "chat" ? "openai-chat" : wire === "messages" ? "anthropic" : "openai-responses";
  const provider = (url: string, key: string) => ({ adapter, authMode: "key", allowPrivateNetwork: true, baseUrl: `${url}/v1`, apiKey: key,
    models: [MODEL], retryOnReset: { enabled: false }, retryOn429: { enabled: false } });
  const config = { port: 0, defaultProvider: remoteId, connectTimeoutMs,
    fallback: { model: true, provider: true }, providers: { [remoteId]: provider(home.url, HOME_KEY), [localId]: provider(local.url, LOCAL_KEY) },
    combos: { [comboId]: { strategy: "failover", cooldownMs: COOLDOWN_MS, waitForCooldownMs: 0,
      targets: [{ provider: remoteId, model: MODEL, metered: false }, { provider: localId, model: MODEL, metered: false }] } } } as OcxConfig;
  configModule.saveConfig(config);
  return config;
}

async function turn(config: OcxConfig, local: Double, overrides: Record<string, unknown> = {}, wire: Wire = "responses", caller?: AbortController) {
  const controller = caller ?? new AbortController();
  let watchdog = false;
  const timer = setTimeout(() => { watchdog = true; controller.abort(new Error("Proof request watchdog")); }, 8_000);
  const log: RequestLogContext = { model: "", provider: "" };
  const body = wire === "responses" ? { model: `combo/${comboId}`, stream: false, store: false,
    input: [{ role: "user", content: [{ type: "input_text", text: "fixture prompt" }] }], ...overrides }
    : { model: `${remoteId}/${MODEL}`, stream: false, ...(wire === "messages" ? { max_tokens: 32 } : {}),
      messages: [{ role: "user", content: "fixture prompt" }], ...overrides };
  inFlight++;
  const started = performance.now();
  try {
    const path = wire === "chat" ? "/v1/chat/completions" : wire === "messages" ? "/v1/messages" : "/v1/responses";
    const request = new Request(`${local.url}${path}`, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = wire === "chat" ? await chat.handleChatCompletions(request, config, log)
      : wire === "messages" ? await messages.handleClaudeMessages(request, config, log) : await core.handleResponses(request, config, log);
    const policy = { replayRefusal: upstream.isReplayRefusalResponse(response), nonReplayable: upstream.isNonReplayableResponse(response),
      retryHeader: response.headers.get("x-should-retry"), retryAfter: response.headers.get("retry-after") };
    const json = JSON.parse(await response.text()) as Record<string, any>;
    return { status: response.status, json, log, elapsedMs: Math.round(performance.now() - started), watchdog, policy };
  } finally { inFlight--; clearTimeout(timer); }
}
function observation(name: string, result: Awaited<ReturnType<typeof turn>>) {
  const attempts = result.log.attempts?.map(attempt => ({ provider: attempt.provider, status: attempt.status,
    code: (attempt as unknown as Record<string, unknown>).errorCode ?? null })) ?? [];
  const observed = { case: name, status: result.status, homeBodies: doubles.filter(d => d.role === "home").reduce((n, d) => n + d.calls.length, 0),
    localBodies: doubles.filter(d => d.role === "local").reduce((n, d) => n + d.calls.length, 0), attempts, elapsedMs: result.elapsedMs,
    watchdog: result.watchdog, timeoutMentioned: /timeout|timed out/i.test(result.log.upstreamError ?? ""), policy: result.policy };
  console.info("[native-proof] " + JSON.stringify(observed));
  expect(result.watchdog).toBe(false);
  return observed;
}

nativeProof("healthy Home uses the native Responses adapter with no local hop", async () => {
  const home = await tcpDouble("home", "healthy"), local = await tcpDouble("local", "healthy");
  const result = await turn(configuration(home, local), local);
  const seen = observation("healthy-home", result);
  expect(result.status).toBe(200); expect(seen.homeBodies).toBe(1); expect(seen.localBodies).toBe(0);
  expect(home.calls[0]!.path).toBe("/v1/responses"); expect(home.calls[0]!.body.input).toBeDefined();
});

nativeProof("connect-refused Home permits one local hop", async () => {
  const home = await tcpDouble("home", "healthy"), local = await tcpDouble("local", "healthy");
  const config = configuration(home, local); await home.stop();
  const seen = observation("connect-refused", await turn(config, local));
  expect(seen.status).toBe(200); expect(seen.homeBodies).toBe(0); expect(seen.localBodies).toBe(1);
});

nativeProof("a post-body reset must not dispatch the same turn locally", async () => {
  const home = await tcpDouble("home", "reset"), local = await tcpDouble("local", "healthy");
  const result = await turn(configuration(home, local), local), seen = observation("post-body-reset", result);
  expect(seen.homeBodies).toBe(1); expect(seen.localBodies).toBe(0); expect(result.status).not.toBe(200);
});

nativeProof("direct native header timeout returns the terminal refusal", async () => {
  const home = await tcpDouble("home", "timeout"), local = await tcpDouble("local", "healthy");
  const result = await turn(configuration(home, local, 300), local, { model: `${remoteId}/${MODEL}` });
  const seen = observation("direct-header-timeout-diagnostic", result);
  console.info("[native-proof] " + JSON.stringify({ stage: "upstream-error", error: result.json.error }));
  expect(seen.homeBodies).toBe(1); expect(seen.localBodies).toBe(0); expect(result.status).toBe(429);
  expect(result.json.error?.code).toBe("upstream_reset_replay_refused");
  expect(result.json.error?.message).toContain("may already have been processed");
});

nativeProof("a post-body native header timeout must not hop locally", async () => {
  const home = await tcpDouble("home", "timeout"), local = await tcpDouble("local", "healthy");
  const result = await turn(configuration(home, local, 300), local), seen = observation("post-body-header-timeout", result);
  expect(seen.homeBodies).toBe(1); expect(seen.localBodies).toBe(0); expect(result.status).not.toBe(200);
});

nativeProof.each(["unauthorized", "quota"] as const)("HTTP %s is distinct from a transport failure", async mode => {
  const home = await tcpDouble("home", mode), local = await tcpDouble("local", "healthy");
  const result = await turn(configuration(home, local), local), seen = observation(mode, result);
  expect(seen.homeBodies).toBe(1); expect(seen.localBodies).toBe(1); expect(result.status).toBe(200);
  expect(seen.attempts[0]?.status).toBe(mode === "unauthorized" ? 401 : 429);
});

nativeProof("a cooled Home returns after its real configured cooldown expires", async () => {
  let home = await tcpDouble("home", "healthy");
  const local = await tcpDouble("local", "healthy"), config = configuration(home, local), port = home.port;
  await home.stop();
  observation("cooldown-first-local", await turn(config, local));
  expect(combos.isComboTargetInCooldown(comboId, { provider: remoteId, model: MODEL })).toBe(true);
  home = await tcpDouble("home", "healthy", port);
  const during = observation("cooldown-still-local", await turn(config, local));
  expect(during.homeBodies).toBe(0); expect(during.localBodies).toBe(2);
  const remaining = combos.remainingComboCooldownMs(comboId);
  expect(Number.isFinite(remaining)).toBe(true);
  await new Promise(resolveWait => setTimeout(resolveWait, (remaining ?? 0) + 60));
  const recovered = observation("cooldown-home-returned", await turn(config, local));
  expect(recovered.homeBodies).toBe(1); expect(recovered.localBodies).toBe(2); expect(recovered.status).toBe(200);
});

nativeProof.each([false, true])("two-turn native tool continuity with previous_response_id (local fallback %s)", async fallback => {
  const home = await tcpDouble("home", "tool"), local = await tcpDouble("local", "tool"), config = configuration(home, local);
  if (fallback) await home.stop();
  const tools = [{ type: "function", name: "fixture_echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }];
  const first = await turn(config, local, { store: true, tools });
  expect(first.status).toBe(200);
  const call = first.json.output.find((item: Record<string, unknown>) => item.type === "function_call");
  expect(call?.call_id).toBeDefined();
  const second = await turn(config, local, { store: true, tools, previous_response_id: first.json.id,
    input: [{ type: "function_call_output", call_id: call.call_id, output: "fixture tool output" }] });
  const seen = observation(fallback ? "two-turn-local" : "two-turn-home", second);
  expect(second.status).toBe(200); expect(seen.homeBodies).toBe(fallback ? 0 : 2); expect(seen.localBodies).toBe(fallback ? 2 : 0);
  const active = fallback ? local : home;
  expect(["previous_response_id", "replayed-prefix"]).toContain(active.calls[1]!.continuity);
  console.info("[native-proof] " + JSON.stringify({ case: fallback ? "two-turn-local-wire" : "two-turn-home-wire", continuity: active.calls[1]!.continuity }));
});

nativeProof.each(["responses", "chat", "messages"] as const)("native %s header deadline bypasses same-key retries and backup keys", async wire => {
  const home = await tcpDouble("home", "timeout", 0, wire), local = await tcpDouble("local", "healthy", 0, wire);
  const config = configuration(home, local, 300, wire);
  const provider = config.providers[remoteId]!;
  provider.retryOn429 = { enabled: true, attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false };
  provider.apiKeyPool = [{ id: "primary", key: HOME_KEY }, { id: "backup", key: BACKUP_KEY }];
  config.protocols = { rollout: { managedMessagesNative: true } };
  configModule.saveConfig(config);
  const result = await turn(config, local, { model: `combo/${comboId}` }, wire);
  const seen = observation(`native-${wire}-deadline-keypool`, result);
  expect(result.status).toBe(429); expect(seen.homeBodies).toBe(1); expect(seen.localBodies).toBe(0);
  expect(home.backupCalls).toBe(0); expect(result.json.error?.code).toBe("upstream_reset_replay_refused");
  expect(result.json.error?.message).toContain("may already have been processed");
  expect(result.policy).toEqual({ replayRefusal: true, nonReplayable: true, retryHeader: "false", retryAfter: null });
});

nativeProof.each(["AbortError", "TimeoutError"])("caller %s after the body remains caller cancellation", async name => {
  const home = await tcpDouble("home", "timeout"), local = await tcpDouble("local", "healthy");
  const caller = new AbortController();
  home.onBody = () => caller.abort(new DOMException("Fixture caller cancelled", name));
  const result = await turn(configuration(home, local, 2_000), local, {}, "responses", caller);
  const seen = observation(`caller-${name}`, result);
  expect(seen.homeBodies).toBe(1); expect(seen.localBodies).toBe(0); expect(result.status).toBe(499);
  expect(result.json.error?.code).not.toBe("upstream_reset_replay_refused");
});

nativeProof.each(["GET", "HEAD"])("safe %s retains its thrown header deadline", async method => {
  const home = await tcpDouble("home", "timeout", 0, "read");
  await expect(core.fetchWithHeaderTimeout(`${home.url}/v1/responses`,
    { method, headers: { authorization: `Bearer ${HOME_KEY}` } }, new AbortController().signal, 300))
    .rejects.toMatchObject({ name: "TimeoutError" });
  expect(home.calls).toHaveLength(1);
  console.info("[native-proof] " + JSON.stringify({ case: `safe-${method}`, homeBodies: home.calls.length, outcome: "TimeoutError" }));
});

nativeProof("replaySafe reset policy cannot retry our POST header deadline", async () => {
  const home = await tcpDouble("home", "timeout"), caller = new AbortController();
  const response = await upstream.fetchWithResetRetry(() => core.fetchWithHeaderTimeout(`${home.url}/v1/responses`,
    { method: "POST", headers: { authorization: `Bearer ${HOME_KEY}`, "content-type": "application/json" }, body: "{}" }, caller.signal, 300),
    { replaySafe: true, attempts: 3, abortSignal: caller.signal });
  expect(home.calls).toHaveLength(1); expect(response.status).toBe(429);
  expect(upstream.isReplayRefusalResponse(response)).toBe(true);
  expect((await response.json()).error.code).toBe("upstream_reset_replay_refused");
  console.info("[native-proof] " + JSON.stringify({ case: "replay-safe-deadline", homeBodies: home.calls.length, status: response.status }));
});

// Run only through the checkout-root wrapper in an allowlisted outer environment with
// --no-env-file --no-install and OCX_NATIVE_PROOF_CREDENTIAL_FREE=1 / OCX_NATIVE_PROOF_ROOT.
