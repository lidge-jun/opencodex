import http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { OcxProviderConfig } from "../../types";
import { CONNECT_FLAG_END_STREAM, decodeAvailableConnectFrames, encodeConnectFrame } from "./framing";
import { encodeCursorRunRequest } from "./protobuf-request";
import { createCursorProtobufEventState, mapCursorProtobufServerMessage, mapSyntheticMcpExecToToolEvents } from "./protobuf-events";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ClientHeartbeatSchema,
  type AgentServerMessage,
} from "./gen/agent_pb";
import { handleCursorNativeExec, handleCursorNativeKv, syntheticResponsesToolAck, type CursorNativeExecContext } from "./native-exec";
import { resolveMcpServers } from "./mcp-config";
import { CursorMcpManager } from "./mcp-manager";
import { buildMcpToolDefinitions, mcpDepsFromManager } from "./native-exec-mcp";
import { desktopDepsFromConfig } from "./native-exec-desktop";
import { buildCursorToolDefinitions, cursorToolWireName } from "./tool-definitions";
import type { CursorNativeToolDeps } from "./native-exec-tools";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "./types";
import type { CursorTransport, CursorTransportFactoryInput } from "./transport";

const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";
const HEARTBEAT_MS = 5_000;
const CURSOR_FIRST_FRAME_TIMEOUT_MS = 30_000;

export class CursorMissingCredentialError extends Error {
  readonly code = "cursor_missing_credential";

  constructor() {
    super("Cursor live transport requires a Cursor access token in provider.apiKey, Authorization, or OPENCODEX_CURSOR_TEST_TOKEN.");
    this.name = "CursorMissingCredentialError";
  }
}

export function resolveCursorToken(provider: OcxProviderConfig, headers?: Headers): string {
  const providerKey = provider.apiKey?.trim();
  if (providerKey) return providerKey;

  const forwarded = headers?.get("authorization") ?? headers?.get("Authorization");
  if (forwarded?.toLowerCase().startsWith("bearer ")) return forwarded.slice("bearer ".length).trim();

  const envToken = process.env.OPENCODEX_CURSOR_TEST_TOKEN?.trim();
  if (envToken) return envToken;
  throw new CursorMissingCredentialError();
}

/**
 * Classify a Connect end-stream (trailer) frame. Cursor terminates EVERY stream with this
 * frame; success is signalled by the ABSENCE of an `error` field (typically `{}`), not by the
 * absence of the frame. Returns null on success, an Error only on a real Connect error.
 * Mirrors jawcode `parseConnectEndStream` (see devlog 350.98). Exported for unit testing.
 */
export function parseConnectEndStreamError(payload: Uint8Array): Error | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as { error?: { code?: string; message?: string } };
    if (parsed?.error) {
      return new Error(`Cursor Connect error ${parsed.error.code ?? "unknown"}: ${parsed.error.message ?? "Unknown error"}`);
    }
    return null;
  } catch {
    return new Error("Cursor Connect end-stream error");
  }
}

function encodeClientMessage(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]): Uint8Array {
  return encodeConnectFrame(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, message)));
}

class LiveCursorTransport implements CursorTransport {
  private session?: http2.ClientHttp2Session;
  private stream?: http2.ClientHttp2Stream;
  private heartbeat?: ReturnType<typeof setInterval>;
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private committed = false;
  private readonly token: string;
  private readonly mcpManager?: CursorMcpManager;
  private readonly desktopDeps: CursorNativeToolDeps;
  private execContext: CursorNativeExecContext = {};
  private mcpPrepared?: Promise<void>;

  constructor(private readonly input: CursorTransportFactoryInput) {
    this.token = resolveCursorToken(input.provider, input.headers);
    // Desktop (computer-use / record-screen) executors are available even with no MCP servers.
    this.desktopDeps = desktopDepsFromConfig(input.provider.desktopExecutor);
    this.execContext = { ...this.desktopDeps };
    const servers = resolveMcpServers(input.provider);
    if (servers.length > 0) {
      this.mcpManager = new CursorMcpManager(servers, {
        log: message => console.warn(message),
      });
    }
  }

  /**
   * Connect MCP servers and compute the tool definitions advertised to the Cursor server.
   * MUST complete before the first `requestContextArgs` (the server only calls MCP tools it was
   * told about), so `run()` awaits this before opening the stream. Best-effort: any failure
   * leaves an empty tool list and MCP disabled for the stream, never blocking the conversation.
   */
  private prepareMcp(): Promise<void> {
    if (!this.mcpManager) return Promise.resolve();
    if (!this.mcpPrepared) {
      this.mcpPrepared = (async () => {
        try {
          const mcpToolDefs = await buildMcpToolDefinitions(this.mcpManager!);
          this.execContext = { ...this.desktopDeps, ...mcpDepsFromManager(this.mcpManager!), mcpToolDefs };
        } catch (err) {
          console.warn(`[cursor-mcp] preparation failed, MCP disabled for this stream: ${err instanceof Error ? err.message : String(err)}`);
          this.execContext = { ...this.desktopDeps };
        }
      })();
    }
    return this.mcpPrepared;
  }

  toJSON(): Record<string, string> {
    return { type: "LiveCursorTransport", credential: "redacted" };
  }

  async *run(request: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorServerMessage> {
    const queue: CursorServerMessage[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    let state = createCursorProtobufEventState();
    const wake = () => {
      const fn = notify;
      notify = undefined;
      fn?.();
    };

    const push = (message: CursorServerMessage) => {
      queue.push(message);
      wake();
    };

    // Advertise MCP tools before the stream opens — the server only calls tools it was told about.
    await this.prepareMcp();
    const clientToolDefs = buildCursorToolDefinitions(request.tools, request.toolChoice);
    this.execContext = { ...this.execContext, clientToolDefs };
    const toolSchemas = new Map<string, unknown>();
    for (const tool of request.tools ?? []) {
      if (tool.parameters) toolSchemas.set(cursorToolWireName(tool), tool.parameters);
    }
    state = createCursorProtobufEventState({
      clientToolNames: clientToolDefs.map(tool => tool.toolName || tool.name),
      parallelToolCalls: request.parallelToolCalls,
      toolSchemas,
    });

    this.open(request, signal, state, push, err => {
      failure = err;
      wake();
    }, () => {
      done = true;
      wake();
    });

    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        const message = queue.shift();
        if (message) yield message;
      }
      if (failure) throw failure;
      if (done) break;
      await new Promise<void>(resolve => {
        notify = resolve;
      });
    }
    if (failure) throw failure;
  }

  writeClient(_message: CursorClientMessage): void {}

  requestCommitted(): boolean {
    return this.committed;
  }

  private clearFirstFrameTimer(): void {
    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = undefined;
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.clearFirstFrameTimer();
    this.stream?.close();
    this.session?.close();
    void this.mcpManager?.dispose();
  }

  private open(
    request: CursorRunRequest,
    signal: AbortSignal | undefined,
    state: ReturnType<typeof createCursorProtobufEventState>,
    push: (message: CursorServerMessage) => void,
    fail: (error: Error) => void,
    finish: () => void,
  ): void {
    this.session = http2.connect(this.input.provider.baseUrl || "https://api2.cursor.sh");
    // The run request is buffered until the HTTP/2 session connects. Failures before `connect`
    // (DNS, ECONNREFUSED, TLS, connect timeout) mean the server never received the request, so they
    // are safe to retry. Once connected, bytes flush to the server and the turn must not be replayed.
    this.session.on("connect", () => { this.committed = true; });
    this.stream = this.session.request({
      ":method": "POST",
      ":path": CURSOR_RUN_PATH,
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      te: "trailers",
      authorization: `Bearer ${this.token}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": CURSOR_CLIENT_VERSION,
      "x-cursor-client-type": "cli",
      "x-request-id": crypto.randomUUID(),
    });

    // Single owner of the pre-first-frame deadline. Cleared by the first server frame/end-stream and
    // by every terminal path (trailers, error, end, abort, close) so it can never leak.
    const failAndClear = (error: Error) => {
      this.clearFirstFrameTimer();
      fail(error);
    };
    const session = this.session;
    const stream = this.stream;
    this.firstFrameTimer = setTimeout(() => {
      this.firstFrameTimer = undefined;
      try { stream.close(); } catch { /* already closing */ }
      try { session.close(); } catch { /* already closing */ }
      fail(new Error("Cursor transport timed out before first response"));
    }, this.input.firstFrameTimeoutMs ?? CURSOR_FIRST_FRAME_TIMEOUT_MS);

    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
    this.stream.on("data", chunk => {
      this.clearFirstFrameTimer();
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      pending = concatBytes(pending, bytes);
      try {
        const decoded = decodeAvailableConnectFrames(pending);
        pending = decoded.remainder;
        const frames = decoded.frames;
        for (const frame of frames) {
          if ((frame.flags & CONNECT_FLAG_END_STREAM) === CONNECT_FLAG_END_STREAM) {
            const endError = parseConnectEndStreamError(frame.payload);
            if (endError) failAndClear(endError);
            continue;
          }
          void this.handleServerMessage(fromBinary(AgentServerMessageSchema, frame.payload), state, push).catch(err => {
            failAndClear(err instanceof Error ? err : new Error(String(err)));
          });
        }
      } catch (err) {
        failAndClear(err instanceof Error ? err : new Error(String(err)));
      }
    });
    this.stream.on("trailers", trailers => {
      const status = trailers["grpc-status"];
      if (status && status !== "0") failAndClear(new Error(`Cursor gRPC error ${status}`));
    });
    this.stream.on("error", err => failAndClear(err instanceof Error ? err : new Error(String(err))));
    this.stream.on("end", () => { this.clearFirstFrameTimer(); finish(); });

    signal?.addEventListener("abort", () => {
      this.close();
      failAndClear(new Error("Cursor request was aborted"));
    }, { once: true });

    this.stream.write(encodeConnectFrame(encodeCursorRunRequest(request)));
    this.heartbeat = setInterval(() => {
      this.stream?.write(encodeClientMessage({
        message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
      }));
    }, HEARTBEAT_MS);
  }

  private async handleServerMessage(
    message: AgentServerMessage,
    state: ReturnType<typeof createCursorProtobufEventState>,
    push: (message: CursorServerMessage) => void,
  ): Promise<void> {
    if (!this.stream) return;
    if (message.message.case === "kvServerMessage") {
      this.stream.write(encodeConnectFrame(handleCursorNativeKv(message.message.value)));
      return;
    }
    if (message.message.case === "execServerMessage") {
      const execMsg = message.message.value;
      if (execMsg.message.case === "mcpArgs") {
        const clientToolEvents = mapSyntheticMcpExecToToolEvents(execMsg.message.value, `exec_${execMsg.id}`, {
          // Allow no-arg client tool calls through the native-exec channel: the mapper still returns
          // [] for non-Responses providers, so real Cursor native exec keeps falling through below.
          // Without this, a legitimate no-arg Responses tool would hit native-exec.ts and be rejected.
          allowEmptyArgs: true,
          state,
        });
        if (clientToolEvents.length > 0) {
          for (const event of clientToolEvents) push(event);
          if (clientToolEvents.some(event => event.type === "error")) {
            // The error event is the terminal signal; pushing `done` too would make the bridge emit
            // both response.failed and response.completed. Just close the stream.
            this.close();
            return;
          }
          this.stream.write(encodeConnectFrame(syntheticResponsesToolAck(execMsg)));
          return;
        }
      }
      const replies = await handleCursorNativeExec(message.message.value, this.execContext);
      for (const reply of replies) this.stream.write(encodeConnectFrame(reply));
      return;
    }
    const mapped = mapCursorProtobufServerMessage(message, state);
    if (mapped.length > 0) {
      for (const event of mapped) push(event);
      return;
    }
    // The frame produced no outward Responses event (e.g. toolCallStarted / partialToolCall args
    // buffering, toolCallDelta, tokenDelta, or a checkpoint update). Tool-call protocol events are
    // deferred to completion for atomic, parallel-safe emission, so a turn that silently assembles
    // several tool calls can otherwise exceed the bridge's stall watchdog (upstream_stall_timeout).
    // Emit a liveness heartbeat for these progress frames so the watchdog sees the upstream is alive.
    // Never after a terminal (done/truncation): a stray post-terminal frame must stay fully inert.
    if (!state.terminated && isCursorProgressFrame(message)) push({ type: "heartbeat" });
  }
}

/**
 * True when a server frame represents real upstream progress that produced no outward Responses
 * event (so the bridge's stall watchdog would otherwise see silence). Covers tool-call assembly,
 * token/checkpoint accounting — the frames `mapCursorProtobufServerMessage` intentionally swallows.
 */
function isCursorProgressFrame(message: AgentServerMessage): boolean {
  if (message.message.case === "conversationCheckpointUpdate") return true;
  if (message.message.case !== "interactionUpdate") return false;
  switch (message.message.value.message.case) {
    case "toolCallStarted":
    case "partialToolCall":
    case "toolCallDelta":
    case "tokenDelta":
      return true;
    default:
      return false;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function createLiveCursorTransport(input: CursorTransportFactoryInput): CursorTransport {
  return new LiveCursorTransport(input);
}
