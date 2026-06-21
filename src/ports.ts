import { createServer } from "node:net";

export async function isPortAvailable(port: number, hostname = "127.0.0.1"): Promise<boolean> {
  return await new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host: hostname });
  });
}

export async function findAvailablePort(preferredPort: number, hostname = "127.0.0.1"): Promise<number> {
  if (await isPortAvailable(preferredPort, hostname)) return preferredPort;
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("failed to allocate an available port"));
      });
    });
    server.listen({ port: 0, host: hostname });
  });
}

