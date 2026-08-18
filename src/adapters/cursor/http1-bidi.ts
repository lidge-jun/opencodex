import { create, toBinary } from "@bufbuild/protobuf";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES } from "../../lib/translator-budget";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { withUpstreamHttpVersionValue } from "../../lib/upstream-http-version";
import { isPreConnectReachabilityError } from "../../lib/upstream-reachability";
import { BidiRequestIdSchema } from "./gen/agent_pb";
import { consumeConnectFrames, encodeConnectFrame } from "./framing";

const CURSOR_RUN_SSE_PATH = "/agent.v1.AgentService/RunSSE";
const CURSOR_BIDI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";
const CURSOR_HTTP1_APPEND_TIMEOUT_MS = 30_000;
const CURSOR_HTTP1_APPEND_RESPONSE_MAX_BYTES = 64 * 1024;
const HEX = "0123456789abcdef";

export interface CursorHttp1BidiCallbacks {
  onCommitted(): void;
  onData(chunk: Uint8Array): void;
  onEnd(): void;
  onError(error: Error): void;
}

export interface CursorHttp1BidiOptions {
  baseUrl: string;
  token: string;
  clientVersion: string;
  sessionId: string;
  requestId: string;
  translatorBudget: TranslatorBudget;
  callbacks: CursorHttp1BidiCallbacks;
  fetch?: typeof globalThis.fetch;
}

interface PendingAppend {
  payload: Uint8Array;
  seqno: bigint;
  rawBytesCharged: boolean;
}

function varintLength(value: bigint): number {
  let length = 1;
  for (let current = value; current >= 0x80n; current >>= 7n) length += 1;
  return length;
}

function writeVarint(target: Uint8Array, offset: number, value: bigint): number {
  let current = value;
  while (current >= 0x80n) {
    target[offset++] = Number(current & 0x7fn) | 0x80;
    current >>= 7n;
  }
  target[offset++] = Number(current);
  return offset;
}

function requestIdMessageBytes(requestId: string): Uint8Array {
  const value = new TextEncoder().encode(requestId);
  const message = new Uint8Array(1 + varintLength(BigInt(value.byteLength)) + value.byteLength);
  let offset = 0;
  message[offset++] = 0x0a; // field 1, string request_id
  offset = writeVarint(message, offset, BigInt(value.byteLength));
  message.set(value, offset);
  return message;
}

/** Exact encoded size of Cursor's aiserver.v1.BidiAppendRequest hex fallback shape. */
export function cursorBidiAppendRequestSize(payloadBytes: number, requestId: string, seqno: bigint): number {
  const hexBytes = payloadBytes * 2;
  const requestIdBytes = requestIdMessageBytes(requestId).byteLength;
  return (hexBytes > 0 ? 1 + varintLength(BigInt(hexBytes)) + hexBytes : 0)
    + 1 + varintLength(BigInt(requestIdBytes)) + requestIdBytes
    + (seqno > 0n ? 1 + varintLength(seqno) : 0);
}

/**
 * Encode the compatibility request used by Cursor when HTTP/2 is disabled.
 * The public client defaults to field 1's hexadecimal data when its binary-append
 * feature gate is unavailable, so OpenCodex uses that backwards-compatible shape.
 */
export function encodeCursorBidiAppendRequest(
  payload: Uint8Array,
  requestId: string,
  seqno: bigint,
): Uint8Array {
  const requestIdBytes = requestIdMessageBytes(requestId);
  const output = new Uint8Array(cursorBidiAppendRequestSize(payload.byteLength, requestId, seqno));
  let offset = 0;
  if (payload.byteLength > 0) {
    const hexBytes = payload.byteLength * 2;
    output[offset++] = 0x0a; // field 1, string data
    offset = writeVarint(output, offset, BigInt(hexBytes));
    for (const byte of payload) {
      output[offset++] = HEX.charCodeAt(byte >>> 4);
      output[offset++] = HEX.charCodeAt(byte & 0x0f);
    }
  }
  output[offset++] = 0x12; // field 2, BidiRequestId request_id
  offset = writeVarint(output, offset, BigInt(requestIdBytes.byteLength));
  output.set(requestIdBytes, offset);
  offset += requestIdBytes.byteLength;
  if (seqno > 0n) {
    output[offset++] = 0x18; // field 3, int64 append_seqno
    offset = writeVarint(output, offset, seqno);
  }
  return output;
}

function cursorHttp1Error(operation: "RunSSE" | "BidiAppend", status: number): Error {
  return new Error(`Cursor HTTP/1.1 ${operation} failed with HTTP ${status || "unknown"}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Bun accepts Uint8Array request bodies; TypeScript's DOM BodyInit omits that runtime shape. */
function bunFetchBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

/**
 * Cursor's HTTP/1.1 compatibility bridge: a server-streaming RunSSE request carries
 * output, while each client message is posted separately through BidiAppend.
 */
export class CursorHttp1BidiConnection {
  private readonly abortController = new AbortController();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly runSseReady: Promise<void>;
  private resolveRunSseReady!: () => void;
  private rejectRunSseReady!: (reason?: unknown) => void;
  private appendChain: Promise<void> = Promise.resolve();
  private nextAppendSeqno = 0n;
  private committed = false;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private terminal = false;
  private closed = false;
  destroyed = false;

  constructor(private readonly options: CursorHttp1BidiOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.runSseReady = new Promise<void>((resolve, reject) => {
      this.resolveRunSseReady = resolve;
      this.rejectRunSseReady = reject;
    });
    // A RunSSE failure can happen before the first append reaches its await; observe it here so
    // the readiness promise never becomes an unhandled rejection.
    void this.runSseReady.catch(() => undefined);
  }

  start(): void {
    void this.runSse().catch(error => {
      this.rejectRunSseReady(error);
      this.fail(asError(error));
    });
  }

  write(frameBytes: Uint8Array): boolean {
    if (this.closed || this.terminal) return false;
    let frame;
    try {
      const decoded = consumeConnectFrames(frameBytes, CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES, 2);
      if (decoded.frames.length !== 1 || decoded.consumedBytes !== frameBytes.byteLength) {
        throw new Error("Cursor HTTP/1.1 append requires exactly one complete Connect frame");
      }
      frame = decoded.frames[0]!;
      if (frame.flags !== 0) throw new Error(`Cursor HTTP/1.1 append does not support Connect flags ${frame.flags}`);
      this.options.translatorBudget.chargeRetained(frame.payload.byteLength, { kind: "request_copies" });
    } catch (error) {
      this.fail(asError(error));
      return false;
    }

    const pending: PendingAppend = {
      payload: frame.payload,
      seqno: this.nextAppendSeqno++,
      rawBytesCharged: true,
    };
    this.appendChain = this.appendChain
      .then(() => this.postAppend(pending))
      .catch(error => this.fail(asError(error)))
      .finally(() => {
        if (!pending.rawBytesCharged) return;
        pending.rawBytesCharged = false;
        this.options.translatorBudget.releaseRetained(pending.payload.byteLength, { kind: "request_copies" });
      });
    return true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resume of waiters) resume();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.destroyed = true;
    this.resume();
    const reason = new DOMException("Cursor HTTP/1.1 connection closed", "AbortError");
    this.rejectRunSseReady(reason);
    this.abortController.abort(reason);
    queueMicrotask(() => this.finish());
  }

  destroy(): void {
    this.close();
  }

  private commonHeaders(contentType: string): Headers {
    return new Headers({
      "content-type": contentType,
      "connect-protocol-version": "1",
      authorization: `Bearer ${this.options.token}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": this.options.clientVersion,
      "x-cursor-client-type": "cli",
      "x-request-id": this.options.requestId,
      "x-session-id": this.options.sessionId,
    });
  }

  private requestUrl(path: string): string {
    const url = new URL(path, this.options.baseUrl);
    if (url.protocol !== "https:") {
      throw new Error("Cursor HTTP/1.1 transport requires an HTTPS base URL");
    }
    return url.toString();
  }

  private http1Init(url: string, init: RequestInit): RequestInit {
    return withUpstreamHttpVersionValue(url, init, "http1.1") ?? init;
  }

  private markCommitted(): void {
    if (this.committed) return;
    this.committed = true;
    this.options.callbacks.onCommitted();
  }

  private async runSse(): Promise<void> {
    const url = this.requestUrl(CURSOR_RUN_SSE_PATH);
    const requestId = toBinary(BidiRequestIdSchema, create(BidiRequestIdSchema, {
      requestId: this.options.requestId,
    }));
    const response = await this.fetchImpl(url, this.http1Init(url, {
      method: "POST",
      headers: this.commonHeaders("application/connect+proto"),
      body: bunFetchBody(encodeConnectFrame(requestId)),
      redirect: "manual",
      signal: this.abortController.signal,
    }));
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      throw cursorHttp1Error("RunSSE", response.status);
    }
    if (!response.body) throw new Error("Cursor HTTP/1.1 RunSSE returned no response body");
    // Cursor has accepted the request id once RunSSE returns successful headers. Do not race the
    // first BidiAppend ahead of that registration.
    this.resolveRunSseReady();
    const reader = response.body.getReader();
    try {
      while (!this.closed && !this.terminal) {
        await this.waitWhilePaused();
        if (this.closed || this.terminal) break;
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) this.options.callbacks.onData(value);
      }
      this.finish();
    } finally {
      try { reader.releaseLock(); } catch { /* a pending abort may still own it */ }
    }
  }

  private async postAppend(pending: PendingAppend): Promise<void> {
    if (this.closed || this.terminal) return;
    await this.runSseReady;
    if (this.closed || this.terminal) return;
    const encodedBytes = cursorBidiAppendRequestSize(
      pending.payload.byteLength,
      this.options.requestId,
      pending.seqno,
    );
    const reservation = this.options.translatorBudget.reserveTransient(encodedBytes, { kind: "request_copies" });
    let body: Uint8Array;
    try {
      body = encodeCursorBidiAppendRequest(pending.payload, this.options.requestId, pending.seqno);
    } catch (error) {
      reservation.release();
      throw error;
    }
    if (pending.rawBytesCharged) {
      pending.rawBytesCharged = false;
      this.options.translatorBudget.releaseRetained(pending.payload.byteLength, { kind: "request_copies" });
    }
    try {
      const url = this.requestUrl(CURSOR_BIDI_APPEND_PATH);
      const timeout = AbortSignal.timeout(CURSOR_HTTP1_APPEND_TIMEOUT_MS);
      const signal = AbortSignal.any([this.abortController.signal, timeout]);
      let response: Response;
      try {
        response = await this.fetchImpl(url, this.http1Init(url, {
          method: "POST",
          headers: this.commonHeaders("application/proto"),
          body: bunFetchBody(body),
          redirect: "manual",
          signal,
        }));
      } catch (error) {
        // A proven DNS/TCP pre-connect failure means no append bytes reached Cursor and replay is
        // safe. Every ambiguous rejection stays conservative: the server may have accepted the
        // append before the response path failed, so suppress replay exactly as the h2 path does.
        if (!isPreConnectReachabilityError(error)) this.markCommitted();
        throw error;
      }
      this.markCommitted();
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw cursorHttp1Error("BidiAppend", response.status);
      }
      const result = await readBoundedResponseBytes(response, {
        maxBytes: CURSOR_HTTP1_APPEND_RESPONSE_MAX_BYTES,
        signal,
      });
      if (result.oversized) throw new Error("Cursor HTTP/1.1 BidiAppend response exceeds 64 KiB");
    } finally {
      reservation.release();
    }
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise(resolve => this.resumeWaiters.push(resolve));
  }

  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.destroyed = true;
    this.resume();
    this.rejectRunSseReady(error);
    if (!this.abortController.signal.aborted) this.abortController.abort(error);
    this.options.callbacks.onError(error);
  }

  private finish(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.destroyed = true;
    this.resume();
    this.options.callbacks.onEnd();
  }
}
