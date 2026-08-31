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
 * Returns `"live" | "dead" | "unknown"`, and the caller treats `unknown` as a reason to
 * stop. Fail-open was wrong here: a listener that accepts connections but withholds
 * `/healthz`, or a probe that times out, is exactly the state where replacing package
 * files is most dangerous, and "we could not tell" is not evidence the proxy is gone.
 * Only a refused connection or a definitive non-OpenCodex answer earns `"dead"`.
 */
export function probeProxyLiveness(port, hostname = "127.0.0.1", timeoutMs = 1500) {
  // An unusable port is not an ambiguous probe: there is nothing to ask.
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return "dead";
  // Normalize HERE rather than at each call site. Leaving it to the callers put the fix in
  // one lane and not the other, and a bracketed IPv6 literal handed to node:http answers
  // nothing - which the tri-state correctly reports as "unknown" and the updater correctly
  // treats as a reason to abort, turning a healthy stop into a refused update.
  let host = typeof hostname === "string" && hostname.trim() !== "" ? hostname.trim() : "127.0.0.1";
  // A wildcard bind answers on loopback; `node:http` cannot dial the wildcard itself.
  if (host === "0.0.0.0" || host === "*") host = "127.0.0.1";
  if (host === "::" ) host = "::1";
  // `[::1]` is a URL spelling; the socket layer wants the bare address.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
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
    "      // Mirrors isOpencodexHealthz in src/server/proxy-liveness.ts. A foreign server",
    "      // that happens to expose /healthz must not be read as our proxy, and a",
    "      // pre-identity build of ours must not be read as foreign.",
    "      const isOpencodex = parsed && typeof parsed === 'object'",
    "        && (parsed.service === 'opencodex'",
    "          || (parsed.service === undefined",
    "            && parsed.status === 'ok'",
    "            && typeof parsed.version === 'string'",
    "            && typeof parsed.uptime === 'number'));",
    "      // Only a clean 200 decides anything. Any other status means the endpoint is",
    "      // answering but not telling us what it is, which is not evidence of absence.",
    "      if (res.statusCode !== 200) process.stdout.write('UNKNOWN');",
    "      else process.stdout.write(isOpencodex ? 'LIVE' : 'DEAD');",
    "    } catch { process.stdout.write('UNKNOWN'); }",
    "  });",
    "});",
    "req.on('timeout', () => { process.stdout.write('UNKNOWN'); req.destroy(); });",
    "// ECONNREFUSED is the one error that proves nothing is listening. Everything else -",
    "// reset, unreachable host, TLS confusion - leaves the question open.",
    "req.on('error', err => process.stdout.write(err && err.code === 'ECONNREFUSED' ? 'DEAD' : 'UNKNOWN'));",
  ].join("\n");
  try {
    const probe = spawnSync(
      process.execPath,
      ["-e", script, host, String(port), String(timeoutMs)],
      { encoding: "utf8", timeout: timeoutMs + 1500, windowsHide: true },
    );
    const out = probe.stdout ?? "";
    if (out.includes("LIVE")) return "live";
    if (out.includes("DEAD")) return "dead";
    // A child that produced nothing, was killed by its own timeout, or failed to spawn
    // leaves the question open rather than answering it.
    return "unknown";
  } catch {
    return "unknown";
  }
}
