import { request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { clearableDeadline } from "../lib/abort";
import { LINK_RELAY_SESSION_HEADER, linkRelayProofMatches } from "../link/relay-auth";
import {
  noteHomeConnection, relayChallenge, requestOnConnection, SingleConnectionAgent, type BoundLinkRelayTarget,
} from "./link-relay-transport";
import { LINK_CHILD_WS_LIMITS, linkWebsocketChildReady } from "./link-websocket-limits";

/**
 * The Home leg of a link WebSocket, design T4 3.2 steps 6 to 9: one relay-auth preflight and the
 * upgrade, on one physical connection, never a second.
 *
 * - The preflight is the same credential-free challenge every relayed request starts with. Its own
 *   verified answer decides: a Home that does not name the WebSocket as on (no state pair, a pair whose
 *   proof does not verify, or off) gets no upgrade, and its answer still updates the cached state under
 *   the ordering rule.
 * - The upgrade carries the session nonce and the link key as a Bearer on that same socket, with a fresh
 *   Sec-WebSocket-Key and without Origin, Sec-WebSocket-Extensions or Sec-WebSocket-Protocol.
 * - The 101 must be on the authenticated socket and complete: Upgrade websocket, Connection upgrade, the
 *   right Sec-WebSocket-Accept, no extension and no subprotocol. Anything else destroys the socket.
 *
 * Every failure is a closed word the caller maps to 426; nothing here retries or writes a frame.
 */

export type LinkWebsocketSetupFailure = "disabled" | "credential" | "preflight" | "not_advertised" | "home_refused" | "handshake" | "timeout" | "aborted";

export type LinkWebsocketSetup =
  | { ok: true; socket: Socket; head: Buffer }
  | { ok: false; reason: LinkWebsocketSetupFailure; status?: number };

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Headers of the caller's request that never travel on the Home leg's upgrade. */
const UPGRADE_OMITTED = ["origin", "sec-websocket-extensions", "sec-websocket-protocol", "sec-websocket-key", "sec-websocket-version",
  "connection", "upgrade", "host", "content-length", "transfer-encoding", LINK_RELAY_SESSION_HEADER];

export function websocketAcceptFor(key: string): string {
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}

function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** A 101 that completes this upgrade and nothing more (design 3.2 step 8). */
export function validLinkUpgradeAnswer(response: Pick<IncomingMessage, "statusCode" | "headers">, key: string): boolean {
  const headers = response.headers;
  if (response.statusCode !== 101) return false;
  if (single(headers.upgrade)?.trim().toLowerCase() !== "websocket") return false;
  if (!(single(headers.connection) ?? "").toLowerCase().split(",").some(token => token.trim() === "upgrade")) return false;
  if (single(headers["sec-websocket-accept"]) !== websocketAcceptFor(key)) return false;
  return headers["sec-websocket-extensions"] === undefined && headers["sec-websocket-protocol"] === undefined;
}

function upgradeOnConnection(
  url: URL, headers: Headers, agent: SingleConnectionAgent, socket: Socket, key: string, signal: AbortSignal,
): Promise<LinkWebsocketSetup> {
  return new Promise(resolve => {
    let settled = false;
    // The signal is watched here, never handed to the request: once the socket is ours, nothing may destroy it.
    const onAbort = () => { if (!settled) outgoing.destroy(); };
    const settle = (result: LinkWebsocketSetup): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const failed = (): LinkWebsocketSetup => ({ ok: false, reason: signal.aborted ? "aborted" : "handshake" });
    const outgoing = request(url, { method: "GET", headers: Object.fromEntries(headers), agent });
    signal.addEventListener("abort", onAbort, { once: true });
    outgoing.on("socket", assigned => { if (assigned !== socket) outgoing.destroy(); });
    outgoing.on("upgrade", (response: IncomingMessage, upgraded: Socket, head: Buffer) => {
      if (settled || signal.aborted || upgraded !== socket || !validLinkUpgradeAnswer(response, key)) {
        upgraded.destroy();
        settle(failed());
        return;
      }
      settle({ ok: true, socket: upgraded, head: Buffer.from(head) });
    });
    outgoing.on("response", (response: IncomingMessage) => {
      response.resume();
      // A 101 that the HTTP parser did not take as an upgrade (no Upgrade header) is a broken handshake, not a refusal.
      if (response.statusCode === 101) { socket.destroy(); settle(failed()); return; }
      settle({ ok: false, reason: signal.aborted ? "aborted" : "home_refused", status: response.statusCode });
    });
    outgoing.on("error", () => settle(failed()));
    outgoing.on("close", () => settle(failed()));
    if (signal.aborted) onAbort();
    outgoing.end();
  });
}

export interface LinkWebsocketSetupTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: LinkWebsocketSetupTimers = {
  setTimeout(callback, ms) { const handle = setTimeout(callback, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/**
 * Open the Home leg. `headers` are the caller's forwarded headers with the link key already set as
 * the Bearer (the relay builds them); `signal` is the caller's abort. The Child's release gate is
 * checked here, before any I/O, and the upgrade has its own bound (the setup budget), so neither
 * depends on the caller.
 */
export async function openLinkWebsocket(
  target: BoundLinkRelayTarget, headers: Headers,
  options: { signal: AbortSignal; preflightMs?: number; upgradeMs?: number; timers?: LinkWebsocketSetupTimers; ready?: () => boolean },
): Promise<LinkWebsocketSetup> {
  const { signal } = options;
  if (!(options.ready ?? linkWebsocketChildReady)()) return { ok: false, reason: "disabled" };
  if (!target.linkId || !target.apiKeyId) return { ok: false, reason: "credential" };
  const origin = new URL("http://127.0.0.1:" + target.tunnelPort);
  let challenge: ReturnType<typeof relayChallenge>;
  try { challenge = relayChallenge(target, origin); } catch { return { ok: false, reason: "credential" }; }
  const agent = new SingleConnectionAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const deadline = clearableDeadline(options.preflightMs ?? LINK_CHILD_WS_LIMITS.preflightMs, signal);
  let handedOff = false;
  try {
    let answer: IncomingMessage;
    try {
      answer = await requestOnConnection(challenge.probe, { method: "GET", signal: deadline.signal, headers: challenge.headers }, agent);
    } catch {
      return { ok: false, reason: signal.aborted ? "aborted" : "preflight" };
    }
    const proof = answer.headers["x-opencodex-link-proof"];
    if (answer.statusCode !== 204 || typeof proof !== "string" || !linkRelayProofMatches(proof, challenge.challenge.expected)) {
      return { ok: false, reason: "preflight", status: answer.statusCode };
    }
    const { websocket } = noteHomeConnection(target, challenge.challenge.nonce, answer.headers, challenge.preflight);
    try {
      for await (const chunk of answer) if ((chunk as Buffer).length) return { ok: false, reason: "preflight" };
    } catch {
      return { ok: false, reason: signal.aborted ? "aborted" : "preflight" };
    }
    deadline.clear();
    if (websocket !== "on") return { ok: false, reason: "not_advertised" };
    if (signal.aborted) return { ok: false, reason: "aborted" };
    const socket = agent.socket;
    if (!socket || socket.destroyed) return { ok: false, reason: "preflight" };
    const key = randomBytes(16).toString("base64");
    const upgradeHeaders = new Headers(headers);
    for (const name of UPGRADE_OMITTED) upgradeHeaders.delete(name);
    upgradeHeaders.set("connection", "Upgrade");
    upgradeHeaders.set("upgrade", "websocket");
    upgradeHeaders.set("sec-websocket-version", "13");
    upgradeHeaders.set("sec-websocket-key", key);
    upgradeHeaders.set(LINK_RELAY_SESSION_HEADER, challenge.challenge.nonce);
    // The upgrade's own bound: a Home that proved itself and then never answers cannot hold the connection.
    const timers = options.timers ?? realTimers;
    const upgradeDeadline = new AbortController();
    const timer = timers.setTimeout(() => upgradeDeadline.abort(new DOMException("link websocket upgrade deadline", "TimeoutError")),
      options.upgradeMs ?? LINK_CHILD_WS_LIMITS.setupBudgetMs);
    let result: LinkWebsocketSetup;
    try {
      result = await upgradeOnConnection(new URL("/v1/responses", origin), upgradeHeaders, agent, socket, key, AbortSignal.any([signal, upgradeDeadline.signal]));
    } finally { timers.clearTimeout(timer); }
    if (!result.ok && result.reason === "aborted" && !signal.aborted && upgradeDeadline.signal.aborted) result = { ok: false, reason: "timeout" };
    if (result.ok) {
      handedOff = true;
      // Node drops its own error listener on upgrade: until the caller adds one, an error is recorded, never unhandled.
      const upgraded = result.socket as Socket & { linkError?: unknown };
      upgraded.on("error", error => { upgraded.linkError ??= error; });
      result.socket.setTimeout(0);
      result.socket.setNoDelay(true);
    }
    return result;
  } finally {
    deadline.clear();
    if (!handedOff) await agent.close();
  }
}
