/**
 * Stands in for a managed service proxy in the health sentinel process test (#6671).
 *
 * It listens on loopback, records its runtime port the way `ocx start` does, and starts the real
 * sentinel through the real launcher. In `hang` mode it answers the first /healthz as itself and
 * then accepts every later connection without answering — what a proxy whose event loop is stuck
 * looks like from outside. In `exit` mode it keeps answering and exits on its own shortly after.
 * It keeps answering until the sentinel's log says it is watching (armed), so a slow runner that
 * misses a deadline cannot leave the sentinel unarmed when the hang begins.
 */
import net from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startServiceHealthSentinel } from "../../src/service/health-sentinel-launch";

const home = process.env.OPENCODEX_HOME!;
const mode = process.env.SENTINEL_FIXTURE_MODE;
const sentinelLog = join(home, "service-health-sentinel.log");
const armed = () => existsSync(sentinelLog) && readFileSync(sentinelLog, "utf8").includes(`watching pid ${process.pid}`);
const held: net.Socket[] = [];
const server = net.createServer(socket => {
  held.push(socket);
  if (mode === "hang" && armed()) return;
  socket.once("data", () => {
    const body = JSON.stringify({ service: "opencodex", status: "ok", pid: process.pid });
    socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  });
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  writeFileSync(join(home, "runtime-port.json"), JSON.stringify({ pid: process.pid, port, hostname: "127.0.0.1" }));
  const handle = startServiceHealthSentinel({ serviceHealthRecovery: { enabled: true } }, { log: line => console.log(line) });
  writeFileSync(join(home, "sentinel.pid"), String(handle?.pid ?? 0));
  if (mode === "exit") setTimeout(() => process.exit(0), 1_500);
});
setInterval(() => {}, 1_000);
