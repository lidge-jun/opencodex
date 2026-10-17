import { connect, createServer, type AddressInfo, type Socket } from "node:net";

/** Local CONNECT stand-in; it never resolves or contacts a public hostname. */
export async function cloudTestProxy(options: { targetPort?: number; refuse?: boolean; stall?: boolean } = {}) {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer(client => {
    track(client);
    let head = "";
    client.on("data", function read(chunk) {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      client.removeListener("data", read);
      requests.push(head.split("\r\n")[0]!);
      if (options.stall) return;
      if (options.refuse) { client.end("HTTP/1.1 503 Unavailable\r\n\r\n"); return; }
      if (!options.targetPort) { client.write("HTTP/1.1 200 Connection established\r\n\r\n"); return; }
      client.pause();
      const upstream = track(connect({ host: "127.0.0.1", port: options.targetPort }, () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        client.pipe(upstream).pipe(client);
        client.resume();
      }));
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port, requests,
    get connectionCount() { return sockets.size; },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
