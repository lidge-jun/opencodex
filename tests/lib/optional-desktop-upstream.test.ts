import { expect, test } from "bun:test";
import { createServer as createHttps } from "node:https";
import { createServer as createTcp } from "node:net";
import { dialDesktopUpstream } from "../../src/lib/desktop-upstream-tunnel";
import { desktopProxyFor } from "../../src/lib/desktop-proxy-route";
import { createCertificateAuthority, issueServerLeaf } from "../../src/claude/intercept/local-ca";
import { forwardProxy, listenFixture } from "../helpers/desktop-egress-fixture";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("desktop HTTP and WS choose explicit NO_PROXY, supported proxies, or a closed failure", () => {
  const url = new URL("https://chatgpt.com/");
  expect(desktopProxyFor(url, {})).toBe(false);
  expect(desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444" })).toBe("http://127.0.0.1:4444");
  expect(desktopProxyFor(url, { ALL_PROXY: "http://127.0.0.1:4444" })).toBe("http://127.0.0.1:4444");
  expect(desktopProxyFor(url, { all_proxy: "https://127.0.0.1:4444" })).toBe("https://127.0.0.1:4444");
  expect(desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444", ALL_PROXY: "http://127.0.0.1:5555" })).toBe("http://127.0.0.1:4444");
  expect(() => desktopProxyFor(url, { HTTPS_PROXY: "bad", ALL_PROXY: "http://127.0.0.1:5555" })).toThrow("proxy_invalid");
  expect(desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444", NO_PROXY: "chatgpt.com" })).toBe(false);
  expect(desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444", ALL_PROXY: "socks5://127.0.0.1:5555" })).toBe("socks5://127.0.0.1:5555");
  expect(() => desktopProxyFor(url, { HTTPS_PROXY: "ftp://127.0.0.1:4444" })).toThrow("proxy_invalid");
  expect(() => desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444/path" })).toThrow("proxy_invalid");
});

for (const kind of ["http", "https", "socks5"] as const) test(`verified TLS through authenticated ${kind} proxy preserves raw request and response`, async () => {
  const ca = createCertificateAuthority({ commonName: "egress-fixture", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "egress-fixture", ["chatgpt.com"]), proxyLeaf = issueServerLeaf(ca, "egress-fixture", ["localhost"]);
  let cookie: string | undefined, leaked: string | undefined;
  const upstream = createHttps({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    cookie = req.headers.cookie; leaked = req.headers["proxy-authorization"] as string | undefined;
    res.end("fixture-response");
  });
  const origin = await listenFixture(upstream), proxy = await forwardProxy(kind, origin.port, proxyLeaf);
  let socket: Awaited<ReturnType<typeof dialDesktopUpstream>> | undefined;
  try {
    socket = await dialDesktopUpstream({ proxy: proxy.url, ca: ca.certPem, proxyCa: ca.certPem, target: { host: "chatgpt.com", port: 443 } });
    const response = new Promise<string>((resolve, reject) => {
      let text = ""; socket!.on("data", bytes => { text += bytes.toString(); }); socket!.once("end", () => resolve(text)); socket!.once("error", reject);
    });
    socket.write("GET /fixture HTTP/1.1\r\nHost: chatgpt.com\r\nCookie: fixture=session\r\nConnection: close\r\n\r\n");
    expect(await response).toContain("fixture-response"); expect(cookie).toBe("fixture=session"); expect(leaked).toBeUndefined();
    expect(proxy.seen).toHaveLength(1); expect(proxy.seen[0]!.authority).toBe("chatgpt.com:443");
    expect(proxy.seen[0]!.auth).toBe(kind === "socks5" ? "fixture:secret" : "Basic " + Buffer.from("fixture:secret").toString("base64"));
  } finally { socket?.destroy(); await proxy.close(); await origin.close(); }
}, 15000);

for (const kind of ["http", "https", "socks5", "http-all", "https-all"] as const) test(`desktop HTTP fetch uses the same authenticated ${kind} egress and validates upstream TLS`, async () => {
  const ca = createCertificateAuthority({ commonName: "fetch-egress-fixture", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "fetch-egress-fixture", ["chatgpt.com"]), proxyLeaf = issueServerLeaf(ca, "fetch-egress-fixture", ["localhost"]);
  let actual: Buffer | undefined;
  const upstream = createHttps({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      actual = Buffer.concat(chunks); res.end("fixture-fetch-response");
    });
  });
  const transport = kind === "http-all" ? "http" : kind === "https-all" ? "https" : kind;
  const origin = await listenFixture(upstream), proxy = await forwardProxy(transport, origin.port, proxyLeaf);
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-fetch-")), certificate = join(root, "fixture-ca.pem");
  writeFileSync(certificate, ca.certPem);
  const child = Bun.spawn([process.execPath, repoPath("tests/helpers/desktop-egress-worker.ts")], {
    cwd: repoRoot(), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate, HTTPS_PROXY: kind.endsWith("-all") ? "" : proxy.url, https_proxy: "", HTTP_PROXY: "", http_proxy: "", ALL_PROXY: kind.endsWith("-all") ? proxy.url : "", all_proxy: "", NO_PROXY: "", no_proxy: "" },
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [exitCode, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" });
    expect(JSON.parse(output)).toEqual({ status: 200, body: "fixture-fetch-response" });
    expect(actual).toEqual(Buffer.from([0, 255, 42])); expect(proxy.seen).toHaveLength(1);
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } await proxy.close(); await origin.close(); removeTreeWithRetry(root); }
}, 15000);

test("untrusted proxy TLS is refused without reaching the target", async () => {
  const ca = createCertificateAuthority({ commonName: "untrusted-proxy", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "untrusted-proxy", ["localhost"]);
  const proxy = await forwardProxy("https", 1, leaf);
  try { await expect(dialDesktopUpstream({ proxy: proxy.url, timeoutMs: 1000 })).rejects.toThrow("desktop_upstream_connection_failed"); expect(proxy.seen).toHaveLength(0); }
  finally { await proxy.close(); }
});

test("trusted certificates with wrong proxy or upstream hostnames are still refused", async () => {
  const ca = createCertificateAuthority({ commonName: "wrong-host-fixture", validityDays: 1 });
  const wrongProxy = await forwardProxy("https", 1, issueServerLeaf(ca, "wrong-host-fixture", ["chatgpt.com"]));
  try {
    await expect(dialDesktopUpstream({ proxy: wrongProxy.url, proxyCa: ca.certPem, timeoutMs: 1000 })).rejects.toThrow("desktop_upstream_connection_failed");
    expect(wrongProxy.seen).toHaveLength(0);
  } finally { await wrongProxy.close(); }
  const wrongLeaf = issueServerLeaf(ca, "wrong-host-fixture", ["localhost"]);
  const upstream = await listenFixture(createHttps({ cert: wrongLeaf.certPem, key: wrongLeaf.keyPem }));
  const proxy = await forwardProxy("http", upstream.port, wrongLeaf);
  try { await expect(dialDesktopUpstream({ proxy: proxy.url, ca: ca.certPem, timeoutMs: 1000 })).rejects.toThrow("desktop_upstream_connection_failed"); }
  finally { await proxy.close(); await upstream.close(); }
});

for (const failure of ["eof", "oversized", "timeout", "abort"] as const) test(`proxy ${failure} failure settles and closes the owned connection`, async () => {
  let closed!: () => void, accepted!: () => void;
  const closedEvent = new Promise<void>(resolve => { closed = resolve; }), acceptedEvent = new Promise<void>(resolve => { accepted = resolve; });
  const server = createTcp(socket => {
    socket.once("close", closed); socket.once("data", () => {
      accepted();
      if (failure === "eof") socket.end();
      if (failure === "oversized") socket.write(Buffer.alloc(65537, 65));
    });
  });
  const proxy = await listenFixture(server), abort = new AbortController();
  try {
    const dial = dialDesktopUpstream({ proxy: `http://127.0.0.1:${proxy.port}`, timeoutMs: failure === "abort" ? 2000 : 500, signal: abort.signal });
    const settled = dial.then(() => null, error => error as Error);
    await acceptedEvent; if (failure === "abort") abort.abort();
    const at = Date.now(), result = await settled;
    expect(result?.message).toBe("desktop_upstream_connection_failed");
    if (failure === "abort") expect(Date.now() - at).toBeLessThan(500);
    await closedEvent;
  } finally { await proxy.close(); }
}, 3000);
