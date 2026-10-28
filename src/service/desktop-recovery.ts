/** A live native producer, never a filename or process name, preserves an unclaimed recovery. */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { isAbsolute, resolve, win32 } from "node:path";
import { getConfigDir } from "../config/paths";
import { recoveryConnectionOwner, recoveryExecuteUntil, recoveryImages, recoveryListenerPorts, recoveryProcesses,
  type RecoveryConnection, type RecoveryImage, type RecoveryProcess } from "./desktop-recovery-process";

const DOMAIN = "ocx-desktop-recovery-v1";
const PROBE_BUDGET_MS = 8_000;
const CONNECTION_BUDGET_MS = 750;
const MAX_RESPONSE_BYTES = 8_512;
/** An `unsupported` unknown is a platform's structural lack of live-image binding, not conflicting evidence. */
export type DesktopRecoveryEvidence = { kind: "none" | "recovering" | "stopped" | "unknown"; unsupported?: boolean };
export interface RecoveryEndpoint { pid: number; port: number }
interface RecoveryAnswer { pid: number; instance: string; state: "recovering" | "stopped" | "unknown"; home: string | null }

/** Rust's Windows canonicalizer uses the verbatim prefix; Node's normalizer does not. */
export function recoveryHomeIdentity(home: string, platform = process.platform): string {
  if (platform !== "win32") return home;
  const normalized = home.startsWith("\\\\?\\UNC\\") ? `\\\\${home.slice(8)}`
    : home.startsWith("\\\\?\\") ? home.slice(4) : home;
  return win32.normalize(normalized).toLowerCase();
}

export function parseRecoveryAnswer(text: string, nonce: string, endpoint: RecoveryEndpoint, instance?: string): RecoveryAnswer {
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES || !text.endsWith("\n")) throw new Error("invalid recovery answer");
  const fields = text.slice(0, -1).split(" ");
  if (fields.length !== 6 || fields[0] !== DOMAIN || fields[1] !== nonce || !/^[0-9a-f]{32}$/.test(fields[2]!)
    || (instance !== undefined && fields[2] !== instance) || fields[3] !== String(endpoint.pid)
    || !["recovering", "stopped", "unknown"].includes(fields[4]!)) throw new Error("invalid recovery binding");
  const state = fields[4] as RecoveryAnswer["state"];
  const encoded = fields[5]!;
  if (state === "unknown" && encoded === "-") return { pid: endpoint.pid, instance: fields[2]!, state, home: null };
  if (!/^(?:[0-9a-f]{2}){1,4096}$/.test(encoded)) throw new Error("invalid recovery scope");
  const home = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "hex"));
  if (!isAbsolute(home) || /[\x00\r\n]/.test(home)) throw new Error("invalid recovery scope");
  return { pid: endpoint.pid, instance: fields[2]!, state, home };
}

interface RecoverySession {
  connection: RecoveryConnection;
  ask(nonce: string): Promise<string>;
  close(): void;
}

function openRecoverySession(endpoint: RecoveryEndpoint, timeoutMs: number): Promise<RecoverySession> {
  return new Promise((resolveSession, rejectSession) => {
    const socket: Socket = connect({ host: "127.0.0.1", port: endpoint.port, localAddress: "127.0.0.1", family: 4 });
    let pending: { resolve(text: string): void; reject(error: Error): void } | undefined;
    let data = Buffer.alloc(0);
    let failed = false;
    const fail = () => {
      failed = true;
      const error = new Error("native recovery connection unavailable");
      pending?.reject(error); pending = undefined; rejectSession(error); socket.destroy();
    };
    const timer = setTimeout(fail, Math.max(1, timeoutMs));
    socket.on("error", fail);
    socket.on("end", fail);
    socket.on("close", () => { clearTimeout(timer); if (pending) fail(); });
    socket.on("data", bytes => {
      const chunk = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
      if (!pending || data.length + chunk.length > MAX_RESPONSE_BYTES) { fail(); return; }
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf(10);
      if (end < 0) return;
      if (end !== data.length - 1) { fail(); return; }
      const request = pending; pending = undefined;
      request.resolve(data.toString("utf8")); data = Buffer.alloc(0);
    });
    socket.once("connect", () => {
      if (socket.localAddress !== "127.0.0.1" || socket.remoteAddress !== "127.0.0.1" || !socket.localPort) { fail(); return; }
      resolveSession({
        connection: { serverPort: endpoint.port, clientPort: socket.localPort },
        ask: nonce => new Promise((yes, no) => {
          if (failed || socket.destroyed || pending) { no(new Error("native recovery connection closed")); return; }
          pending = { resolve: yes, reject: no };
          socket.write(`${DOMAIN} ${nonce}\n`);
        }),
        close: () => { clearTimeout(timer); socket.destroy(); },
      });
    });
  });
}

export interface DesktopRecoveryIo {
  images(): RecoveryImage[];
  processes(images: readonly RecoveryImage[]): RecoveryProcess[];
  listeners(process: RecoveryProcess): number[];
  open(endpoint: RecoveryEndpoint, timeoutMs: number): Promise<RecoverySession>;
  owner(process: RecoveryProcess, connection: RecoveryConnection): string;
  home(): string;
  now(): number;
}

const same = (a: RecoveryProcess, b: RecoveryProcess | undefined) => b !== undefined
  && a.pid === b.pid && a.born === b.born && a.app === b.app && a.image === b.image;

/** Positive evidence is tied to an independently selected image, the same OS process and socket. */
export async function inspectDesktopRecovery(overrides: Partial<DesktopRecoveryIo> = {}): Promise<DesktopRecoveryEvidence> {
  const now = overrides.now ?? performance.now.bind(performance);
  const deadline = now() + PROBE_BUDGET_MS;
  let commandDeadline = deadline;
  const execute = recoveryExecuteUntil(() => commandDeadline, now);
  const io: DesktopRecoveryIo = {
    images: () => recoveryImages(execute), processes: images => recoveryProcesses(images, execute),
    listeners: process => recoveryListenerPorts(process, execute), open: openRecoverySession,
    owner: (process, connection) => recoveryConnectionOwner(process, connection, execute),
    home: () => { try { return realpathSync(getConfigDir()); } catch { return resolve(getConfigDir()); } },
    now, ...overrides,
  };
  try {
    const images = io.images();
    // Untrusted files and endpoint claims are never read, even for a real other-home Desktop.
    if (!images.length) return { kind: "none" };
    const processes = io.processes(images);
    if (!processes.length) return { kind: "none" };
    if (processes.length > 4) return { kind: "unknown" };
    let result: DesktopRecoveryEvidence = { kind: "none" };
    for (const process of processes) {
      const image = images.find(image => image.app === process.app && image.image === process.image);
      if (!image?.trusted) return image?.unsupported === true ? { kind: "unknown", unsupported: true } : { kind: "unknown" };
      let evidence: DesktopRecoveryEvidence = { kind: "unknown" };
      const ports = io.listeners(process);
      if (ports.length > 8 || ports.some(port => !Number.isSafeInteger(port) || port < 1 || port > 65535)) return { kind: "unknown" };
      for (const port of new Set(ports)) {
        const remaining = deadline - io.now();
        if (remaining <= 0) return { kind: "unknown" };
        let session: RecoverySession | undefined;
        try {
          const endpoint = { pid: process.pid, port };
          commandDeadline = Math.min(deadline, io.now() + CONNECTION_BUDGET_MS);
          session = await io.open(endpoint, commandDeadline - io.now());
          // A TCP handshake may finish just before accept() installs the descriptor. Allow
          // two short scheduling turns, never protocol traffic, before requiring its owner.
          let socket: string | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { socket = io.owner(process, session.connection); break; }
            catch (error) {
              if (attempt === 2 || io.now() >= commandDeadline) throw error;
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }
          if (!socket || io.now() >= commandDeadline) throw new Error("native accepted socket unverified");
          const firstNonce = randomBytes(32).toString("hex");
          const first = parseRecoveryAnswer(await session.ask(firstNonce), firstNonce, endpoint);
          if (!same(process, io.processes(images).find(p => p.pid === process.pid))) throw new Error("native instance changed");
          const lastNonce = randomBytes(32).toString("hex");
          const last = parseRecoveryAnswer(await session.ask(lastNonce), lastNonce, endpoint, first.instance);
          if (io.owner(process, session.connection) !== socket
            || !same(process, io.processes(images).find(p => p.pid === process.pid))
            || first.home !== last.home || io.now() >= commandDeadline) throw new Error("native recovery changed");
          evidence = !last.home || last.state === "unknown" ? { kind: "unknown" }
            : recoveryHomeIdentity(last.home) !== recoveryHomeIdentity(io.home()) ? { kind: "none" } : { kind: last.state };
          break;
        } catch { /* An unrelated endpoint cannot prove what the independently observed app wants. */ }
        finally { session?.close(); commandDeadline = deadline; }
      }
      if (evidence.kind === "unknown") return evidence;
      if (evidence.kind !== "none") {
        if (result.kind !== "none" && result.kind !== evidence.kind) return { kind: "unknown" };
        result = evidence;
      }
    }
    return result;
  } catch {
    // Only failed OS/installation observations reach here; locator contents grant no veto.
    return { kind: "unknown" };
  }
}
