import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import net from "node:net";
import { stopRequestFetch } from "../../src/cli/stop-restore";
import { ProxyOwnershipRefusedError, stopProxy, stopProxyGracefully } from "../../src/lib/process-control";

// Exercise the exact transport selected by handleStop, including its forced-stop consumer.
for (const framing of ["truncated", "stalled"]) {
  test(`R7 CLI transport retains observed 409 with ${framing} body and never kills`, async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => {
        const response = "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{}";
        if (framing === "truncated") socket.end(response);
        else socket.write(response);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let kills = 0;
    const signal = spyOn(process, "kill").mockImplementation((_pid, kind) => {
      if (kind !== 0) { kills++; throw new Error("unexpected forced signal"); }
      return true;
    });
    const taskkill = spyOn(childProcess, "execFileSync").mockImplementation(() => {
      kills++; throw new Error("unexpected taskkill");
    });
    try {
      const io = { runtimeEndpoint: { hostname: "127.0.0.1", port: (server.address() as net.AddressInfo).port },
        env: {}, exitTimeoutMs: 150, fetchFn: stopRequestFetch(),
        waitExit: () => { throw new Error("must never wait after refusal"); } };
      expect(await stopProxyGracefully(4242, io)).toBe("refused");
      await expect(stopProxy(4242, io)).rejects.toBeInstanceOf(ProxyOwnershipRefusedError);
      expect(kills).toBe(0);
    } finally {
      signal.mockRestore(); taskkill.mockRestore();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
