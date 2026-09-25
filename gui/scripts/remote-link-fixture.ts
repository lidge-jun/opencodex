#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

const portFlag = Bun.argv.indexOf("--port");
const port = portFlag >= 0 ? Number(Bun.argv[portFlag + 1]) : 5199;
const root = join(import.meta.dir, "..", "dist");
const json = (value: unknown, init: ResponseInit = {}) => Response.json(value, { headers: { "cache-control": "no-store", ...init.headers }, ...init });
const status = (fixture: string) => {
  if (fixture === "home-connected") return { role: "home", listener: { state: "listening", port: 44123 }, links: [{ id: "fixture-link-1", alias: "child-workstation", direction: "hub-initiated", state: "connected", since: "2026-09-25T00:00:00.000Z", reason: null, tunnelPort: 43110 }], child: null };
  if (fixture === "fingerprint") return { role: "home", listener: { state: "listening", port: 44123 }, links: [], child: null };
  if (fixture === "add-sheet") return { role: "home", listener: { state: "listening", port: 44123 }, links: [], child: null };
  return { role: "standalone", listener: { state: "off", port: null }, links: [], child: null };
};

function fixtureFor(request: Request, url: URL): string {
  const direct = url.searchParams.get("fixture");
  if (direct) return direct;
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)ocx-fixture=([^;]+)/)?.[1];
  if (cookie) return decodeURIComponent(cookie);
  const referer = request.headers.get("referer");
  try { return referer ? new URL(referer).searchParams.get("fixture") ?? "off" : "off"; } catch { return "off"; }
}

async function staticFile(pathname: string): Promise<Response> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = normalize(join(root, requested.replace(/^\//, "")));
  if (!file.startsWith(root)) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(file);
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
    return new Response(body, { headers: { "content-type": type } });
  } catch {
    return staticFile("/index.html");
  }
}

async function appDocument(request: Request): Promise<Response> {
  const body = await readFile(join(root, "index.html"), "utf8");
  const origin = new URL(request.url).origin;
  const tags = `<meta name="opencodex-runtime-role" content="hub"><meta name="opencodex-session-token" content="ocx_session_fixture"><meta name="opencodex-session-csrf" content="fixture-csrf"><meta name="opencodex-session-origin" content="${origin}"><meta name="opencodex-session-server-origin" content="${origin}">`;
  return new Response(body.replace("</head>", `${tags}</head>`), { headers: { "content-type": "text/html" } });
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const fixture = fixtureFor(request, url);
    if (url.pathname === "/opencodex-session") return new Response(`<meta name="opencodex-session-token" content="ocx_session_fixture"><meta name="opencodex-session-csrf" content="fixture-csrf"><meta name="opencodex-session-origin" content="${url.origin}"><meta name="opencodex-session-server-origin" content="${url.origin}">`, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/remote-workspace" && request.method === "GET") return json({ available: true, devices: [], runtimes: {}, sessions: [] });
    if (url.pathname === "/api/link/status" && request.method === "GET") return json(status(fixture));
    if (url.pathname === "/api/link/candidates" && request.method === "GET") return json({ candidates: [{ alias: "child-workstation", source: "ssh_config" }, { alias: "tailscale-child", source: "tailscale" }] });
    if (url.pathname === "/api/link/probe" && request.method === "POST") return json({ alias: "child-workstation", fingerprint: "SHA256:fixture-host-key", keyType: "ED25519" });
    if (url.pathname === "/api/link/confirm-host" && request.method === "POST") return json({ alias: "child-workstation", fingerprint: "SHA256:fixture-host-key", ocxVersion: "0.0.0-fixture" });
    if (url.pathname === "/api/link/apply" && request.method === "POST") return json({ linkId: "fixture-link-1" }, { status: 202 });
    if (url.pathname.startsWith("/api/link/") && request.method === "DELETE") return json({ linkId: url.pathname.slice("/api/link/".length) });
    if (url.pathname === "/" || url.pathname === "/index.html") return appDocument(request);
    return staticFile(url.pathname);
  },
});

console.log(`Remote link fixture listening on http://127.0.0.1:${server.port}`);
