import { Agent, request, type ClientRequest, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationChallenge,
  isLocalAttestationSecret,
  verifyLocalAttestationProof,
} from "../lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION } from "../lib/system-restart-contract";
import { isOpencodexHealthz, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import { computeVersionSkew } from "./version-skew";

const FAILURE = "update_restart_stop_failed";
const MAX_RESPONSE_BYTES = 64 * 1024;

/** This agent owns exactly one direct TCP connection, including on Bun's HTTP layer. */
class AttestedAgent extends Agent {
  socket?: Socket;
  private connected = false;

  constructor(private readonly hostname: string, private readonly port: number) {
    super({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1, maxFreeSockets: 1 });
  }

  override createConnection(
    _options: unknown,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Socket | undefined {
    if (this.connected) {
      // Returning no socket with an error also refuses queued reconnect attempts.
      callback?.(new Error(FAILURE), this.socket!);
      return undefined;
    }
    this.connected = true;
    this.socket = connect({ host: this.hostname, port: this.port, autoSelectFamily: false });
    return this.socket;
  }
}

function checkDeadline(deadlineAt: number): void {
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) throw new Error(FAILURE);
}

function readJson(response: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const fail = () => { reject(new Error(FAILURE)); response.destroy(); };
    response.on("error", fail);
    response.on("aborted", fail);
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) { fail(); return; }
      chunks.push(chunk);
    });
    response.on("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!response.complete || value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(FAILURE);
        }
        resolve(value as Record<string, unknown>);
      } catch { reject(new Error(FAILURE)); }
    });
  });
}

type AttestedTarget = { target: LiveProxy & { pid: number }; secret: string; deadlineAt: number };
type JsonReply = { response: IncomingMessage; body: Record<string, unknown> };

class AttestedSession {
  readonly agent: AttestedAgent;
  readonly challenge = createLocalAttestationChallenge();
  private readonly hostname: string;
  private readonly timer: ReturnType<typeof setTimeout>;
  private current?: ClientRequest;

  constructor(private readonly options: AttestedTarget) {
    const { target, secret, deadlineAt } = options;
    checkDeadline(deadlineAt);
    if (target.source !== "runtime" || target.role !== undefined || target.packageTreeFenced
      || !Number.isSafeInteger(target.pid) || target.pid <= 0
      || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
      || !isLocalAttestationSecret(secret)) throw new Error(FAILURE);
    const host = probeHostname(target.hostname);
    this.hostname = host.startsWith("[") ? host.slice(1, -1) : host;
    this.agent = new AttestedAgent(this.hostname, target.port);
    this.timer = setTimeout(() => {
      this.current?.destroy(new Error(FAILURE));
      this.agent.socket?.destroy(new Error(FAILURE));
    }, Math.min(deadlineAt - Date.now(), 2_147_483_647));
  }

  exchange(adminToken?: string): Promise<JsonReply> {
    const stop = adminToken !== undefined;
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: this.hostname, port: this.options.target.port, agent: this.agent,
        method: stop ? "POST" : "GET", path: stop ? "/api/stop" : "/healthz",
        maxHeaderSize: MAX_RESPONSE_BYTES,
        headers: stop ? { "content-length": "0" } : { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: this.challenge },
      });
      this.current = req;
      req.on("error", reject);
      req.on("response", response => {
        readJson(response).then(body => resolve({ response, body }), reject);
      });
      req.once("socket", (socket: Socket) => {
        try {
          checkDeadline(this.options.deadlineAt);
          if (socket !== this.agent.socket || socket.destroyed || !socket.writable
            || (stop && (socket.connecting || socket.readableEnded || socket.writableEnded))) {
            throw new Error(FAILURE);
          }
          // No end/flushHeaders/write, or credential header, before this socket check.
          if (adminToken !== undefined) req.setHeader("X-OpenCodex-API-Key", adminToken);
          req.end();
        } catch { req.destroy(new Error(FAILURE)); }
      });
    });
  }

  validateHealth(health: JsonReply): void {
    const { target, secret, deadlineAt } = this.options;
    const proof = health.response.headers[LOCAL_ATTESTATION_PROOF_HEADER];
    checkDeadline(deadlineAt);
    if (health.response.statusCode !== 200 || !isOpencodexHealthz(health.body)
      || health.body.status !== "ok" || health.body.role !== undefined
      || health.body.pid !== target.pid || health.body.port !== target.port
      || !verifyLocalAttestationProof(secret, this.challenge, target.pid, target.port, typeof proof === "string" ? proof : null)) {
      throw new Error(FAILURE);
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.current?.destroy();
    this.agent.destroy();
    this.agent.socket?.destroy();
  }
}

/** Proof and credential delivery must remain on one established channel; never retry. */
export async function stopAttestedUpdateTarget(options: AttestedTarget & {
  cliVersion: string;
  beforeStop: () => void;
  adminToken: string;
}): Promise<void> {
  let session: AttestedSession | undefined;
  try {
    const { cliVersion, deadlineAt, beforeStop, adminToken } = options;
    if (!adminToken) throw new Error(FAILURE);
    session = new AttestedSession(options);
    const health = await session.exchange();
    session.validateHealth(health);
    if (health.body.restartCapability !== SYSTEM_RESTART_CAPABILITY_VERSION
      || computeVersionSkew(cliVersion, typeof health.body.version === "string" ? health.body.version : undefined).relation !== "cli-newer"
      || /\bclose\b/i.test(health.response.headers.connection ?? "")) throw new Error(FAILURE);
    checkDeadline(deadlineAt);
    beforeStop();
    // Synchronous candidate revalidation and POST enqueue: no intervening await.
    const stopped = await session.exchange(adminToken);
    checkDeadline(deadlineAt);
    if (stopped.response.statusCode !== 200 || stopped.body.success !== true
      || stopped.body.sharedTeardown !== "performed") throw new Error(FAILURE);
  } catch {
    // Never expose parser/network/callback errors (which may contain credentials).
    throw new Error(FAILURE);
  } finally {
    session?.close();
  }
}

/** Observe only the caller's exact newly started runtime; ordinary liveness is not proof. */
export async function observeAttestedUpdateReplacement(options: AttestedTarget & {
  version: string;
}): Promise<LiveProxy> {
  let session: AttestedSession | undefined;
  try {
    session = new AttestedSession(options);
    const health = await session.exchange();
    session.validateHealth(health);
    if (health.body.version !== options.version) throw new Error(FAILURE);
    return { pid: options.target.pid, port: options.target.port, hostname: options.target.hostname,
      source: "runtime", version: options.version };
  } catch {
    throw new Error("update_restart_replacement_observation_failed");
  } finally {
    session?.close();
  }
}
