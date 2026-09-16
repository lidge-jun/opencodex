/**
 * Realtime voice sideband, one stage at a time (issue #4721).
 *
 * The field report for realtime voice v3 arrives as a single "voice is broken" symptom that is
 * really three: an immediate 502 on call-create, a ten-second start timeout, and a call whose
 * audio works while no transcript or tool call ever appears. Those have different causes and a
 * test that drives the whole call at once cannot tell them apart.
 *
 * So each stage of the sideband - join, session configuration, audio, transcription, tool
 * events, shutdown - gets its own fixture file and its own test against the real relay. A
 * failure names the stage, which is the whole point: it separates "the proxy corrupts or drops
 * this class of frame" from "the proxy never carried this class of frame at all".
 *
 * The fixtures are synthetic. They are hand-written from public Realtime event names and carry
 * no captured session, account identifier, credential, or request body; the last test in this
 * file asserts that, because the privacy:scan gate only sees a file once it is tracked.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clearAccountNeedsReauth, clearAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { MAX_WS_FRAME_BYTES, openLiveSidebandUpstream, startServer } from "../../src/server";
import { LIVE_FRAME_LOG_ENV } from "../../src/server/live";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath } from "../helpers/repo-root";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = join(import.meta.dir, ".tmp-server-live-realtime-fixtures");
let isolatedCodexHome: IsolatedCodexHome | null = null;
const DIRECT_CHATGPT_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });

const FIXTURE_DIR = "realtime-voice-sideband";
const STAGE_FILES = [
  "audio.json",
  "connect.json",
  "session.json",
  "shutdown.json",
  "tools.json",
  "transcript.json",
] as const;

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-live-realtime-fixtures-");
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");
});

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

function forwardConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

function loadStage(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath(FIXTURE_DIR, file), "utf8")) as Record<string, unknown>;
}

/** Fixture frames are compared as the exact bytes the relay is expected to carry. */
function encodeFrames(frames: unknown): string[] {
  return ((frames as unknown[] | undefined) ?? []).map(frame => JSON.stringify(frame));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

interface StageRun {
  callId: string;
  clientHeaders?: Record<string, string>;
  /** Frames the upstream sends the instant it accepts the upgrade, before the client attaches. */
  preamble?: string[];
  clientFrames?: string[];
  /** Frames the upstream sends once every client frame has arrived. */
  upstreamFrames?: string[];
  /** Frames the client sends only after the upstream ones land, for server-initiated exchanges. */
  clientFollowUpFrames?: string[];
  close?: { by: "client" | "upstream"; code: number; reason: string };
}

interface StageResult {
  upstreamPath: string;
  upstreamHeaders: Headers;
  upstreamReceived: string[];
  clientReceived: string[];
  upstreamClose?: { code: number; reason: string };
  clientClose?: { code: number; reason: string };
}

/**
 * Drive one sideband stage end to end: a real opencodex server, a real client WebSocket, and a
 * local upstream standing in for the Realtime API. Only api.openai.com sideband targets are
 * redirected, so the proxy still builds the upstream URL itself.
 */
async function relaySidebandStage(run: StageRun): Promise<StageResult> {
  const result: StageResult = {
    upstreamPath: "",
    upstreamHeaders: new Headers(),
    upstreamReceived: [],
    clientReceived: [],
  };
  const preamble = run.preamble ?? [];
  const clientFrames = run.clientFrames ?? [];
  const upstreamFrames = run.upstreamFrames ?? [];
  const clientFollowUpFrames = run.clientFollowUpFrames ?? [];
  const closesUpstreamSide = run.close?.by === "upstream";

  const upstream = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        result.upstreamPath = url.pathname;
        result.upstreamHeaders = new Headers(req.headers);
        if (server.upgrade(req, { data: {} })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_WS_FRAME_BYTES,
      open(ws) {
        for (const frame of preamble) ws.send(frame);
        if (clientFrames.length > 0) return;
        for (const frame of upstreamFrames) ws.send(frame);
        if (closesUpstreamSide && run.close) ws.close(run.close.code, run.close.reason);
      },
      message(ws, message) {
        result.upstreamReceived.push(typeof message === "string" ? message : message.toString("utf8"));
        if (result.upstreamReceived.length !== clientFrames.length) return;
        for (const frame of upstreamFrames) ws.send(frame);
        if (closesUpstreamSide && run.close) ws.close(run.close.code, run.close.reason);
      },
      close(_ws, code, reason) {
        result.upstreamClose = { code, reason };
      },
    },
  });

  saveConfig(forwardConfig());

  const RealWebSocket = globalThis.WebSocket;
  const upstreamPort = upstream.port;
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const parsed = new URL(String(url));
      const target =
        parsed.hostname === "api.openai.com" && parsed.pathname.startsWith("/v1/live/")
          ? "ws://127.0.0.1:" + upstreamPort + parsed.pathname + parsed.search
          : String(url);
      super(target, protocols as string[]);
    }
  } as typeof WebSocket;

  const server = startServer(0);
  try {
    const wsUrl = new URL("/v1/live/" + run.callId, server.url);
    wsUrl.protocol = "ws:";
    const client = new RealWebSocket(wsUrl.toString(), {
      headers: {
        authorization: "Bearer " + DIRECT_CHATGPT_TOKEN,
        "chatgpt-account-id": "acct-123",
        ...(run.clientHeaders ?? {}),
      },
    } as unknown as string[]);

    let clientFailed = false;
    client.addEventListener("message", event => {
      result.clientReceived.push(String(event.data));
    });
    client.addEventListener("close", event => {
      result.clientClose = { code: event.code, reason: event.reason };
    });
    client.addEventListener("error", () => {
      clientFailed = true;
    });

    await waitFor(
      () => clientFailed || client.readyState === RealWebSocket.OPEN,
      "the client sideband socket to open on stage " + run.callId,
    );
    if (clientFailed) throw new Error("client websocket error on stage " + run.callId);

    for (const frame of clientFrames) client.send(frame);

    const expectedFromUpstream = preamble.length + upstreamFrames.length;
    if (expectedFromUpstream > 0) {
      await waitFor(
        () => result.clientReceived.length >= expectedFromUpstream,
        "upstream frames on stage " + run.callId,
      );
    }
    if (clientFrames.length > 0) {
      await waitFor(
        () => result.upstreamReceived.length >= clientFrames.length,
        "client frames on stage " + run.callId,
      );
    }

    if (clientFollowUpFrames.length > 0) {
      for (const frame of clientFollowUpFrames) client.send(frame);
      await waitFor(
        () => result.upstreamReceived.length >= clientFrames.length + clientFollowUpFrames.length,
        "client follow-up frames on stage " + run.callId,
      );
    }

    if (run.close?.by === "client") {
      client.close(run.close.code, run.close.reason);
      await waitFor(() => result.upstreamClose !== undefined, "the upstream close on stage " + run.callId);
    } else if (run.close?.by === "upstream") {
      await waitFor(() => result.clientClose !== undefined, "the client close on stage " + run.callId);
    } else {
      client.close();
    }
  } finally {
    globalThis.WebSocket = RealWebSocket;
    await server.stop(true);
    await upstream.stop(true);
  }
  return result;
}

test("stage connect: the sideband join reaches the upstream with the client's protocol negotiation intact", async () => {
  const stage = loadStage("connect.json");
  const stageJoin = stage.join as {
    path: string;
    relayedHeaders: Record<string, string>;
    withheldHeaders: Record<string, string>;
  };
  const expectUpstream = stage.expectUpstream as { path: string };

  const result = await relaySidebandStage({
    callId: stage.callId as string,
    clientHeaders: { ...stageJoin.relayedHeaders, ...stageJoin.withheldHeaders },
    clientFrames: [JSON.stringify({ type: "input_audio.append", audio: "AAE=" })],
    upstreamFrames: [JSON.stringify({ type: "session.started", session: { id: "sess_fixture_connect" } })],
  });

  expect(result.upstreamPath).toBe(expectUpstream.path);
  // Protocol negotiation belongs to the client: relay what it sent, verbatim, and invent nothing.
  for (const [name, value] of Object.entries(stageJoin.relayedHeaders)) {
    expect([name, result.upstreamHeaders.get(name)]).toEqual([name, value]);
  }
  // Everything else the caller attached stays on this side of the proxy.
  for (const name of Object.keys(stageJoin.withheldHeaders)) {
    expect([name, result.upstreamHeaders.get(name)]).toEqual([name, null]);
  }
}, { timeout: 20_000 });

test("stage session: the session preamble reaches a client that was not connected yet", async () => {
  const stage = loadStage("session.json");
  const preamble = encodeFrames(stage.preamble);
  const clientFrames = encodeFrames(stage.clientFrames);
  const upstreamFrames = encodeFrames(stage.upstreamFrames);

  const result = await relaySidebandStage({
    callId: stage.callId as string,
    preamble,
    clientFrames,
    upstreamFrames,
  });

  // Everything here lands before the client socket exists, because a v3 WebRTC sideband sends no
  // client session.update at all. Dropping that capture is how a session that never learns it
  // started ends up as audio with no session state.
  expect(result.clientReceived).toEqual([...preamble, ...upstreamFrames]);
  expect(result.upstreamReceived).toEqual(clientFrames);
  expect(result.clientReceived.join("\n")).toContain("session.started");
}, { timeout: 20_000 });

test("stage audio: audio buffer and audio response frames cross the relay unchanged", async () => {
  const stage = loadStage("audio.json");
  const clientFrames = encodeFrames(stage.clientFrames);
  const upstreamFrames = encodeFrames(stage.upstreamFrames);

  const result = await relaySidebandStage({
    callId: stage.callId as string,
    clientFrames,
    upstreamFrames,
  });

  expect(result.upstreamReceived).toEqual(clientFrames);
  expect(result.clientReceived).toEqual(upstreamFrames);
  expect(result.upstreamReceived.join("\n")).toContain("input_audio.append");
  expect(result.clientReceived.join("\n")).toContain("output_audio.delta");
}, { timeout: 20_000 });

test("stage transcript: transcription frames reach the client, multibyte text included", async () => {
  const stage = loadStage("transcript.json");
  const clientFrames = encodeFrames(stage.clientFrames);
  const upstreamFrames = encodeFrames(stage.upstreamFrames);

  const result = await relaySidebandStage({
    callId: stage.callId as string,
    clientFrames,
    upstreamFrames,
  });

  expect(result.clientReceived).toEqual(upstreamFrames);
  // The reported symptom is audio without transcripts, so name those events directly: a
  // byte-equal list is still vacuous if the fixture stopped carrying them.
  const delivered = result.clientReceived.join("\n");
  expect(delivered).toContain("input_transcript.added");
  expect(delivered).toContain("output_transcript.added");
  expect(delivered).toContain("turn.done");
  expect(delivered).toContain("고정된 픽스처 파일을 나열합니다");
}, { timeout: 20_000 });

test("stage tools: a delegated request reaches the client and its result reaches the model", async () => {
  const stage = loadStage("tools.json");
  const clientFrames = encodeFrames(stage.clientFrames);
  const upstreamFrames = encodeFrames(stage.upstreamFrames);
  const clientFollowUpFrames = encodeFrames(stage.clientFollowUpFrames);

  const result = await relaySidebandStage({
    callId: stage.callId as string,
    clientFrames,
    upstreamFrames,
    clientFollowUpFrames,
  });

  expect(result.clientReceived).toEqual(upstreamFrames);
  expect(result.upstreamReceived).toEqual([...clientFrames, ...clientFollowUpFrames]);
  // The delegated request has to arrive AND its result has to get back, in that order.
  expect(result.clientReceived.join("\n")).toContain("delegation.created");
  expect(result.upstreamReceived.join("\n")).toContain("delegation.context.append");
}, { timeout: 20_000 });

test("stage shutdown: either side ending the call is reported to the other with its own code and reason", async () => {
  const stage = loadStage("shutdown.json");
  const cases = stage.cases as Array<{
    name: string;
    callId: string;
    initiator: "client" | "upstream";
    code: number;
    reason: string;
    observedBy: "client" | "upstream";
    clientFrames: unknown[];
  }>;

  for (const item of cases) {
    const result = await relaySidebandStage({
      callId: item.callId,
      clientFrames: encodeFrames(item.clientFrames),
      close: { by: item.initiator, code: item.code, reason: item.reason },
    });
    const observed = item.observedBy === "client" ? result.clientClose : result.upstreamClose;
    expect([item.name, observed?.code]).toEqual([item.name, item.code]);
    expect([item.name, observed?.reason]).toEqual([item.name, item.reason]);
  }
}, { timeout: 30_000 });

test("the realtime voice fixtures stay de-identified and fully registered", () => {
  const present = readdirSync(fixturePath(FIXTURE_DIR)).sort();
  // An unregistered fixture is an unverified fixture: every file here is driven by a test above.
  expect(present).toEqual([...STAGE_FILES].sort());

  const forbidden: Array<{ label: string; pattern: RegExp }> = [
    { label: "a macOS home path", pattern: /\/Users\/[A-Za-z0-9_-]+\// },
    { label: "an email address", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
    { label: "a bearer value", pattern: /Bearer\s+\S/i },
    {
      label: "an API key or JWT",
      pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/,
    },
    {
      label: "an authorization or account field",
      pattern: /"(?:authorization|chatgpt-account-id|api[-_]?key|access_token|client_secret)"\s*:/i,
    },
  ];

  for (const file of STAGE_FILES) {
    const raw = readFileSync(fixturePath(FIXTURE_DIR, file), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect([file, parsed.deidentified]).toEqual([file, true]);
    expect([file, typeof parsed.provenance]).toEqual([file, "string"]);
    for (const { label, pattern } of forbidden) {
      expect([file, label, pattern.test(raw)]).toEqual([file, label, false]);
    }
  }
});

test("sideband lifecycle records separate a refused join from a relay that ran", async () => {
  const logPath = join(TEST_DIR, "live-lifecycle.jsonl");
  const previousFrameLog = process.env[LIVE_FRAME_LOG_ENV];
  process.env[LIVE_FRAME_LOG_ENV] = logPath;
  try {
    // A join whose upstream never opens. This is the case a frame-only log could not record at
    // all, which is why an empty file read the same as a working call that carried nothing.
    const refused = await openLiveSidebandUpstream(
      "wss://api.openai.com/v1/live/rtc_fixture_refused",
      {},
      () => {
        throw new Error("upstream refused the sideband join");
      },
    );
    expect(refused.ok).toBe(false);

    const stage = loadStage("audio.json");
    const clientFrames = encodeFrames(stage.clientFrames);
    await relaySidebandStage({
      callId: stage.callId as string,
      clientFrames,
      upstreamFrames: encodeFrames(stage.upstreamFrames),
    });
    await waitFor(
      () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("relay-closed"),
      "the sideband lifecycle log",
    );

    const raw = readFileSync(logPath, "utf8");
    const records = raw.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const stages = records.filter(record => typeof record.stage === "string").map(record => record.stage);
    // The three reported symptoms are only distinguishable if these are distinct records.
    expect(stages).toContain("upstream-failed");
    expect(stages).toContain("upstream-open");
    expect(stages).toContain("relay-attached");
    expect(stages).toContain("relay-closed");
    // Only the refusal carries a status, because only the refusal handed the caller one.
    expect(records.find(record => record.stage === "upstream-failed"))
      .toMatchObject({ status: 502, code: "upstream_error" });

    // Same privacy rule as the frame records: stage and status, never content.
    const allowed = new Set(["ts", "stage", "status", "code", "dir", "kind", "bytes", "fffd"]);
    for (const record of records) {
      for (const key of Object.keys(record)) expect([key, allowed.has(key)]).toEqual([key, true]);
    }
    for (const frame of clientFrames) expect(raw).not.toContain(frame);
    expect(raw).not.toContain("output_audio.delta");
    expect(raw).not.toContain("rtc_fixture");
  } finally {
    if (previousFrameLog === undefined) delete process.env[LIVE_FRAME_LOG_ENV];
    else process.env[LIVE_FRAME_LOG_ENV] = previousFrameLog;
  }
}, { timeout: 30_000 });
