import { spawnSync } from "node:child_process";

/**
 * Is something still answering `/healthz` as an opencodex proxy on this endpoint?
 *
 * Absent PID and runtime-port files are weak evidence that the proxy is gone: a crashed
 * but still-listening process, or one supervised outside our records, leaves no files and
 * keeps the port. Replacing package files under it leaves a server running a mix of old
 * and new modules, which is the hazard `ocx update` stops the proxy to avoid (#3008).
 *
 * Synchronous and dependency-free because it runs inside the plain-Node launcher's
 * `runNpmSelfUpdate`, which is not async and cannot import the TypeScript liveness module.
 * A separate Node child does the fetch so the caller keeps its straight-line control flow.
 *
 * Fails OPEN — an unreachable endpoint, a timeout, or an unparseable body all read as "not
 * live". A probe that cannot answer must not block an update on its own uncertainty; the
 * PID and runtime-file gates above it are still in force.
 */
export function proxyStillAnswering(port, hostname = "127.0.0.1", timeoutMs = 1500) {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return false;
  // `node:http` rather than `fetch`: the child inherits a parent whose event loop is
  // blocked on `spawnSync`, and an aborted-before-dispatch fetch reports the same "not
  // live" as a genuinely dead port. A request emitted on the socket cannot be confused
  // with one that never left.
  const script = [
    "const http = require('node:http');",
    "const [host, port, timeout] = process.argv.slice(1);",
    "const req = http.get({ host, port: Number(port), path: '/healthz', timeout: Number(timeout) }, res => {",
    "  let body = '';",
    "  res.setEncoding('utf8');",
    "  res.on('data', chunk => { body += chunk; });",
    "  res.on('end', () => {",
    "    try {",
    "      const parsed = JSON.parse(body);",
    "      if (res.statusCode === 200 && parsed && typeof parsed === 'object' && 'pid' in parsed) process.stdout.write('LIVE');",
    "    } catch { /* not an opencodex healthz body */ }",
    "  });",
    "});",
    "req.on('timeout', () => req.destroy());",
    "req.on('error', () => {});",
  ].join("\n");
  try {
    const probe = spawnSync(
      process.execPath,
      ["-e", script, hostname, String(port), String(timeoutMs)],
      { encoding: "utf8", timeout: timeoutMs + 1500, windowsHide: true },
    );
    return (probe.stdout ?? "").includes("LIVE");
  } catch {
    return false;
  }
}
