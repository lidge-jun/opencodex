import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { createServer as createTcp, connect, type Socket, type Server } from "node:net";
import type { PemKeyPair } from "../../src/claude/intercept/local-ca";
export async function listenFixture(server: Server, host = "127.0.0.1") {
  const sockets = new Set<Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  return { port: (server.address() as { port: number }).port,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export async function forwardProxy(kind: "http" | "https" | "socks5", targetPort: number, leaf: PemKeyPair, credentials = {username: "fixture", password: "secret"},
  /** Regression seam: hold the upstream connect callback, as a loaded event loop does. */
  options: { targetConnectDelayMs?: number } = {}) {
  const sockets = new Set<Socket>(), seen: { authority: string; auth: string }[] = [];
  const pipe = (client: Socket, head = Buffer.alloc(0)) => {
    const target = connect({ host: "127.0.0.1", port: targetPort }); sockets.add(target);
    target.on("error", () => client.destroy()); client.on("error", () => target.destroy());
    target.on("close", () => { sockets.delete(target); client.destroy(); }); client.on("close", () => target.destroy());
    const relay = () => { if (head.length) target.write(head); client.pipe(target).pipe(client); };
    target.once("connect", () => { if (options.targetConnectDelayMs) setTimeout(relay, options.targetConnectDelayMs); else relay(); });
  };
  const server = kind === "socks5" ? createTcp(client => {
    let held = Buffer.alloc(0), stage = 0, auth = "";
    const onData = (chunk: Buffer) => {
      held = Buffer.concat([held, chunk]);
      for (;;) {
        if (stage === 0) {
          if (held.length < 2 || held.length < 2 + held[1]!) return;
          const end = 2 + held[1]!; const supportsAuth = held.subarray(2, end).includes(2);
          held = held.subarray(end); client.write(Buffer.from([5, supportsAuth ? 2 : 255])); stage = 1;
        } else if (stage === 1) {
          if (held.length < 2 || held.length < 3 + held[1]!) return;
          const n = held[1]!, m = held[2 + n]!; if (held.length < 3 + n + m) return;
          const username = held.subarray(2, 2 + n).toString(), password = held.subarray(3 + n, 3 + n + m).toString();
          auth = `${username}:${password}`;
          held = held.subarray(3 + n + m); client.write(Buffer.from([1, username === credentials.username && password === credentials.password ? 0 : 1])); stage = 2;
        } else {
          if (held.length < 5 || held.length < 7 + held[4]!) return;
          const n = held[4]!, authority = held.subarray(5, 5 + n).toString() + ":" + held.readUInt16BE(5 + n);
          // Removing the last listener does not pause a flowing socket: the client's TLS
          // ClientHello can arrive before the upstream connects and would be dropped, stalling the
          // dial until its 10 s deadline (macOS run 39215956943). Hold it until pipe() resumes.
          seen.push({ authority, auth }); held = held.subarray(7 + n); client.off("data", onData); client.pause();
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); pipe(client, held); return;
        }
      }
    };
    client.on("data", onData);
  }) : kind === "https" ? createHttps({ cert: leaf.certPem, key: leaf.keyPem }) : createHttp();
  if (kind !== "socks5") server.on("connect", (req, client, head) => {
    const auth = String(req.headers["proxy-authorization"] ?? ""); seen.push({ authority: req.url ?? "", auth });
    if (auth !== "Basic " + Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")) { client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return; }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); pipe(client as Socket, head);
  });
  const listening = await listenFixture(server, kind === "https" ? "localhost" : "127.0.0.1");
  return { ...listening, seen, url: `${kind}://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@${kind === "https" ? "localhost" : "127.0.0.1"}:${listening.port}`,
    async close() { for (const socket of sockets) socket.destroy(); await listening.close(); } };
}
