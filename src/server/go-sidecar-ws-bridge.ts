/** Loopback WebSocket client for ticket #28's Go frame bridge. */
import { randomBytes } from "node:crypto";
import net from "node:net";

const MAX_FRAME_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
export const GO_WS_BRIDGE_ENV = "OPENCODEX_GO_WS_BRIDGE";
export function goWsBridgeEnabled(): boolean { return process.env[GO_WS_BRIDGE_ENV] === "1"; }

function clientFrame(payload: Buffer): Buffer {
  const mask = randomBytes(4); const n = payload.byteLength;
  const head = n < 126 ? Buffer.from([0x81, 0x80 | n]) : n <= 0xffff
    ? Buffer.from([0x81, 0xfe, n >> 8, n & 0xff])
    : Buffer.from([0x81, 0xff, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const body = Buffer.from(payload); for (let i = 0; i < body.byteLength; i++) body[i] ^= mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

/** Forward each server text frame as it arrives; do not buffer a Responses turn. */
export async function forwardGoWebSocketFrames(
  baseUrl: string,
  requestToken: string,
  frame: Record<string, unknown>,
  admission: unknown,
  onFrame: (text: string) => void,
): Promise<void> {
  const url = new URL("/v1/responses/ws-bridge", baseUrl); const payload = Buffer.from(JSON.stringify({ frame, admission }));
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error("WebSocket bridge request is too large");
  return await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) }); const key = randomBytes(16).toString("base64"); let buffer = Buffer.alloc(0); let upgraded = false;
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(TIMEOUT_MS, () => fail(new Error("Go WebSocket bridge timed out"))); socket.once("error", fail);
    socket.on("connect", () => socket.write("GET " + url.pathname + " HTTP/1.1\r\nHost: " + url.host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\nX-Ocx-Go-Sidecar-Request: " + requestToken + "\r\n\r\n"));
    socket.on("data", chunk => { buffer = Buffer.concat([buffer, Buffer.from(chunk)]); if (!upgraded) { const boundary = buffer.indexOf("\r\n\r\n"); if (boundary < 0) return; if (!buffer.subarray(0, boundary).toString("latin1").startsWith("HTTP/1.1 101")) return fail(new Error("Go WebSocket bridge rejected upgrade")); upgraded = true; buffer = buffer.subarray(boundary + 4); socket.write(clientFrame(payload)); }
      while (buffer.byteLength >= 2) { const opcode = buffer[0]! & 0x0f; let n = buffer[1]! & 0x7f; let offset = 2; if (n === 126) { if (buffer.byteLength < 4) return; n = buffer.readUInt16BE(2); offset = 4; } else if (n === 127) { if (buffer.byteLength < 10) return; const wide = buffer.readBigUInt64BE(2); if (wide > BigInt(MAX_FRAME_BYTES)) return fail(new Error("Go WebSocket bridge frame is too large")); n = Number(wide); offset = 10; } if (n > MAX_FRAME_BYTES) return fail(new Error("Go WebSocket bridge frame is too large")); if (buffer.byteLength < offset + n) return; const body = buffer.subarray(offset, offset + n); buffer = buffer.subarray(offset + n); if (opcode === 1) onFrame(body.toString()); if (opcode === 8) { socket.end(); resolve(); return; } }
    }); socket.once("end", () => resolve());
  });
}
