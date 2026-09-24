/**
 * HTTP/1.1 TLS terminator for claude.ai. Only the bounded bootstrap response is
 * held; all other HTTP bodies and upgraded sockets relay as streams.
 */
import { createServer, request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import type { PemKeyPair } from "./local-ca";
import {
  BOOTSTRAP_MAX_ENCODED_BYTES, isPickerBootstrapRequest, narrowBootstrapAcceptEncoding,
  rewriteBootstrapBody, rewrittenHeaders,
} from "./picker-bootstrap";
import type { PickerModelEntry } from "./picker-bootstrap";

export interface PickerListenerOptions {
  leaf: PemKeyPair;
  models: () => readonly PickerModelEntry[];
  upstream?: { host: string; port: number; servername: string; ca?: string };
  /** Test seam: encoded bootstrap cap; production uses BOOTSTRAP_MAX_ENCODED_BYTES. */
  maxEncodedBytes?: number;
  log?: (line: string) => void;
}
export interface PickerListenerHandle { port: number; close(): Promise<void> }

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function filteredHeaders(raw: readonly string[], omit: ReadonlySet<string> = new Set()): string[] {
  const named = new Set<string>();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "connection") {
      for (const name of raw[i + 1]!.split(",")) named.add(name.trim().toLowerCase());
    }
  }
  const result: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (!HOP_HEADERS.has(name) && !named.has(name) && !omit.has(name)) {
      result.push(raw[i]!, raw[i + 1]!);
    }
  }
  return result;
}

function hasJsonContentType(raw: readonly string[]): boolean {
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "content-type") {
      return /^(?:application\/json|[^;\s]+\+json)(?:\s*;|\s*$)/i.test(raw[i + 1]!);
    }
  }
  return false;
}

function contentEncoding(raw: readonly string[]): string | undefined {
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "content-encoding") return raw[i + 1]!;
  }
  return undefined;
}

export async function startPickerListener(options: PickerListenerOptions): Promise<PickerListenerHandle> {
  const upstream = options.upstream ?? { host: "claude.ai", port: 443, servername: "claude.ai" };
  const cap = options.maxEncodedBytes ?? BOOTSTRAP_MAX_ENCODED_BYTES;
  const upgrades = new Set<Duplex>();
  const server = createServer({ cert: options.leaf.certPem, key: options.leaf.keyPem, ALPNProtocols: ["http/1.1"] });

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "https://claude.ai").pathname;
    const bootstrap = isPickerBootstrapRequest(method, pathname);
    const category = bootstrap ? "bootstrap" : "other";
    let logged = false;
    const log = (status: number) => {
      if (!logged) options.log?.(`picker ${method} ${category} ${status}`);
      logged = true;
    };
    const fail = () => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(502, { "Content-Length": "0" }); res.end(); log(502); }
    };
    const omit = bootstrap ? new Set(["accept-encoding"]) : new Set<string>();
    const headers = filteredHeaders(req.rawHeaders, omit);
    if (bootstrap) headers.push("Accept-Encoding", narrowBootstrapAcceptEncoding());
    const upReq = httpsRequest({
      host: upstream.host, port: upstream.port, servername: upstream.servername,
      ca: upstream.ca, rejectUnauthorized: true, agent: false,
      method, path: req.url, headers,
    }, upRes => {
      const status = upRes.statusCode ?? 502;
      const originalHeaders = filteredHeaders(upRes.rawHeaders);
      const sendHead = (raw: string[]) => {
        if (res.headersSent) return;
        res.writeHead(status, upRes.statusMessage, raw);
        log(status);
      };
      upRes.on("error", fail);
      if (!bootstrap || status !== 200 || !hasJsonContentType(upRes.rawHeaders)) {
        sendHead(originalHeaders);
        upRes.pipe(res);
        return;
      }
      const held: Buffer[] = [];
      let size = 0;
      let handedOff = false;
      const onData = (chunk: Buffer) => {
        if (size + chunk.length > cap) {
          upRes.pause();
          upRes.off("data", onData);
          handedOff = true;
          sendHead(originalHeaders);
          for (const part of held) res.write(part);
          res.write(chunk);
          upRes.pipe(res);
          return;
        }
        held.push(chunk);
        size += chunk.length;
      };
      upRes.on("data", onData);
      upRes.once("end", () => {
        if (handedOff) return;
        const original = Buffer.concat(held, size);
        let outcome = "unchanged";
        const rewritten = rewriteBootstrapBody(original, contentEncoding(upRes.rawHeaders), options.models(), result => {
          outcome = result.kind === "rewritten" ? `rewritten(+${result.added})` : `unchanged:${result.reason}`;
        });
        sendHead(rewritten === null ? originalHeaders : rewrittenHeaders(originalHeaders, rewritten.length));
        options.log?.(`picker ${method} bootstrap ${outcome}`);
        res.end(rewritten ?? original);
      });
    });
    upReq.on("error", fail);
    req.on("error", () => upReq.destroy());
    res.on("close", () => { if (!res.writableEnded) upReq.destroy(); });
    req.pipe(upReq);
  });

  server.on("upgrade", (req, client, head) => {
    const method = req.method ?? "GET";
    const target = tlsConnect({
      host: upstream.host, port: upstream.port, servername: upstream.servername,
      ca: upstream.ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"],
    });
    upgrades.add(client);
    upgrades.add(target);
    let established = false;
    let upgradeLogged = false;
    let responseStart = "";
    const logUpgrade = (status: number) => {
      if (upgradeLogged) return;
      upgradeLogged = true;
      options.log?.(`picker ${method} other ${status}`);
    };
    const onResponseData = (chunk: Buffer) => {
      responseStart += chunk.toString("latin1");
      const end = responseStart.indexOf("\r\n");
      if (end >= 0) {
        target.off("data", onResponseData);
        const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(responseStart.slice(0, end));
        logUpgrade(status ? Number(status[1]) : 502);
      } else if (responseStart.length > 128) {
        target.off("data", onResponseData);
        logUpgrade(502);
      }
    };
    const fail = () => {
      if (!established && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      else client.destroy();
      target.destroy();
      logUpgrade(502);
    };
    target.on("data", onResponseData);
    target.once("secureConnect", () => {
      established = true;
      target.write(`${method} ${req.url ?? "/"} HTTP/1.1\r\n`);
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        if (/^proxy-(?:authorization|connection)$/i.test(req.rawHeaders[i]!)) continue;
        target.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      target.write("\r\n");
      if (head.length) target.write(head);
      client.pipe(target).pipe(client);
    });
    target.once("error", fail);
    client.once("error", () => target.destroy());
    target.once("close", () => { upgrades.delete(target); if (!upgradeLogged) logUpgrade(502); client.destroy(); });
    client.once("close", () => { upgrades.delete(client); target.destroy(); });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("picker listener has no port");
  return {
    port: address.port,
    async close() {
      for (const socket of upgrades) socket.destroy();
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
