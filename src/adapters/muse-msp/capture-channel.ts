import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MuseMspError } from "./connection";
import type { MuseCaptureRendezvous } from "./capture-rendezvous";
import type { CodingAgentMcpTool } from "../coding-agent/mcp-server";

/** Private loopback rendezvous for one isolated host; caller must protect the capability. */
export async function openMuseCaptureChannel(rendezvous: MuseCaptureRendezvous, catalog: readonly CodingAgentMcpTool[] = []): Promise<{
  port: number; token: string; close: () => Promise<void>;
}> {
  const secret = randomBytes(32), token = secret.toString("hex");
  let catalogJson: string;
  try {
    catalogJson = JSON.stringify(catalog);
    if (Buffer.byteLength(catalogJson) > 2 * 1024 * 1024) throw new Error();
  } catch { throw new MuseMspError("invalid_capture_catalog"); }
  const shutdown = new AbortController();
  let active = 0, closed = false;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization;
    const supplied = typeof auth === "string" && /^Bearer [0-9a-f]{64}$/.test(auth) ? Buffer.from(auth.slice(7), "hex") : Buffer.alloc(32);
    const valid = timingSafeEqual(secret, supplied) && typeof auth === "string" && auth.startsWith("Bearer ");
    supplied.fill(0);
    if (closed || !valid || !((req.method === "POST" && req.url === "/capture") || (req.method === "GET" && req.url === "/catalog")) || active >= 16) {
      res.writeHead(403).end(); req.resume(); return;
    }
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }).end(catalogJson); return; }
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    shutdown.signal.addEventListener("abort", abort, { once: true });
    res.on("close", abort);
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 256 * 1024) throw new MuseMspError("invalid_capture_call");
        chunks.push(bytes);
      }
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!call || typeof call !== "object" || typeof call.callId !== "string" || typeof call.name !== "string" ||
          !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new MuseMspError("invalid_capture_call");
      const output = await rendezvous.accept(call, controller.signal);
      if (!controller.signal.aborted) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output }));
    } catch {
      if (!res.destroyed && !res.headersSent) res.writeHead(400).end();
    } finally { active--; shutdown.signal.removeEventListener("abort", abort); res.removeListener("close", abort); }
  };
  const server = createServer((req, res) => { void handle(req, res); });
  server.maxConnections = 32;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address() as AddressInfo;
  return { port: address.port, token, async close() {
    if (closed) return;
    closed = true; shutdown.abort(); secret.fill(0);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  } };
}
