import { describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { observeAttestedUpdateReplacement, stopAttestedUpdateTarget } from "../../src/cli/update-restart-transport";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
  createLocalAttestationSecret,
} from "../../src/lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION } from "../../src/lib/system-restart-contract";

const FAILURE = "update_restart_stop_failed";
const ADMIN = "loopback-test-management-credential";
type Reply = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;

async function fixture(settings: { health?: Reply; stop?: Reply } = {}) {
  const secret = createLocalAttestationSecret();
  const requests: Array<{ method: string; path: string; token?: string; socket: Socket; challenge?: string }> = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  let wire = "";
  let port = 0;
  const server = createServer((req, res) => {
    requests.push({ method: req.method!, path: req.url!, token: req.headers["x-opencodex-api-key"] as string | undefined,
      socket: req.socket, challenge: req.headers[LOCAL_ATTESTATION_CHALLENGE_HEADER] as string | undefined });
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") {
      const challenge = req.headers[LOCAL_ATTESTATION_CHALLENGE_HEADER];
      const proof = createLocalAttestationProof(secret, String(challenge), process.pid, port);
      if (proof) res.setHeader(LOCAL_ATTESTATION_PROOF_HEADER, proof);
      const body = { service: "opencodex", status: "ok", pid: process.pid, port, version: "2.76.0",
        restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION };
      if (settings.health) settings.health(req, res, body);
      else res.end(JSON.stringify(body));
    } else if (req.url === "/api/stop") {
      const body = { success: true, sharedTeardown: "performed" };
      if (settings.stop) settings.stop(req, res, body);
      else res.end(JSON.stringify(body));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  server.on("connection", socket => {
    connections++;
    sockets.add(socket);
    socket.on("data", bytes => { wire += bytes.toString("latin1"); });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ephemeral fixture missing address");
  port = address.port;
  const options = {
    target: { pid: process.pid, port, hostname: "127.0.0.1", source: "runtime" as const },
    secret, cliVersion: "2.77.0", deadlineAt: Date.now() + 2000, beforeStop: () => {}, adminToken: ADMIN,
  };
  return { server, requests, options, sockets, connections: () => connections, wire: () => wire,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

describe("attested update stop transport over real loopback", () => {
  test("proves fresh health then stops over exactly one TCP socket", async () => {
    const f = await fixture();
    try {
      let revalidated = 0;
      f.options.beforeStop = () => {
        expect(f.requests.map(r => r.path)).toEqual(["/healthz"]);
        revalidated++;
      };
      await stopAttestedUpdateTarget(f.options);
      expect(f.requests.map(r => [r.method, r.path])).toEqual([["GET", "/healthz"], ["POST", "/api/stop"]]);
      expect(f.connections()).toBe(1);
      expect(f.requests[0]!.socket).toBe(f.requests[1]!.socket);
      expect(f.requests[0]!.token).toBeUndefined();
      expect(f.requests[0]!.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(f.requests[1]!.token).toBe(ADMIN);
      expect(revalidated).toBe(1);
    } finally { await f.close(); }
  });

  for (const variant of ["missing proof", "wrong secret", "wrong PID", "wrong port", "client", "fenced", "unhealthy", "capability"] as const) {
    test(`${variant} refuses before POST or credential bytes`, async () => {
      const f = await fixture({ health: (_req, res, body) => {
        if (variant === "missing proof") res.removeHeader(LOCAL_ATTESTATION_PROOF_HEADER);
        if (variant === "wrong PID") body.pid = process.pid + 1;
        if (variant === "wrong port") body.port = 1;
        if (variant === "client") body.role = "client";
        if (variant === "fenced") { body.status = "restart_required"; body.error = { code: "package_tree_changed" }; res.statusCode = 503; }
        if (variant === "unhealthy") body.status = "degraded";
        if (variant === "capability") delete body.restartCapability;
        res.end(JSON.stringify(body));
      } });
      try {
        let revalidated = 0;
        if (variant === "wrong secret") f.options.secret = createLocalAttestationSecret();
        f.options.beforeStop = () => { revalidated++; };
        await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
        expect(revalidated).toBe(0);
        expect(f.requests.map(r => r.path)).toEqual(["/healthz"]);
        expect(f.wire()).not.toContain(ADMIN);
      } finally { await f.close(); }
    });
  }

  for (const version of ["2.78.0", "not-semver", "unknown", "0.0.0", "2.77.0", "2.77.0+other"] as const) {
    test(`proxy version ${version} is not admitted as CLI-newer`, async () => {
      const f = await fixture({ health: (_req, res, body) => { body.version = version; res.end(JSON.stringify(body)); } });
      try {
        await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
        expect(f.requests).toHaveLength(1);
        expect(f.wire()).not.toContain(ADMIN);
      } finally { await f.close(); }
    });
  }

  test("Connection close refuses any replacement socket and credential", async () => {
    const f = await fixture({ health: (_req, res, body) => {
      res.setHeader("connection", "close");
      res.end(JSON.stringify(body));
    } });
    try {
      await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
      expect(f.connections()).toBe(1);
      expect(f.requests).toHaveLength(1);
      expect(f.wire()).not.toContain(ADMIN);
    } finally { await f.close(); }
  });

  test("a new listener taking the original port receives no connection or credentials", async () => {
    let replacementConnections = 0;
    let replacementBytes = "";
    const replacement = createServer((_req, res) => { res.end("{}"); });
    replacement.on("connection", socket => {
      replacementConnections++;
      socket.on("data", bytes => { replacementBytes += bytes.toString(); });
    });
    const f = await fixture({ health: (_req, res, body) => {
      // Release the listen port while the established proof connection still exists.
      f.server.close();
      replacement.listen(f.options.target.port, "127.0.0.1", () => {
        res.setHeader("connection", "close");
        res.end(JSON.stringify(body));
      });
    } });
    try {
      await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
      expect(f.requests).toHaveLength(1);
      expect(f.connections()).toBe(1);
      expect(replacementConnections).toBe(0);
      expect(replacementBytes).toBe("");
      expect(f.wire()).not.toContain(ADMIN);
    } finally {
      await f.close();
      await new Promise<void>(resolve => replacement.close(() => resolve()));
    }
  });

  test("a keepalive peer closing after health never opens another connection", async () => {
    const f = await fixture({ health: (_req, res, body) => {
      const socket = res.socket;
      res.end(JSON.stringify(body));
      socket?.end();
    } });
    try {
      await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
      expect(f.connections()).toBe(1);
      expect(f.requests).toHaveLength(1);
      expect(f.wire()).not.toContain(ADMIN);
    } finally { await f.close(); }
  });

  test("fresh sessions use different challenges", async () => {
    const f = await fixture();
    try {
      await stopAttestedUpdateTarget(f.options);
      await stopAttestedUpdateTarget(f.options);
      expect(f.requests[0]!.challenge).not.toBe(f.requests[2]!.challenge);
      expect(f.connections()).toBe(2);
      expect(f.requests[0]!.socket).not.toBe(f.requests[2]!.socket);
    } finally { await f.close(); }
  });

  test("HTTP proxy environment cannot intercept health or stop", async () => {
    const proxy = await fixture();
    const f = await fixture();
    const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
    const saved = names.map(name => process.env[name]);
    try {
      for (const name of names) process.env[name] = name.toLowerCase() === "no_proxy" ? "" : `http://127.0.0.1:${proxy.options.target.port}`;
      await stopAttestedUpdateTarget(f.options);
      expect(f.requests).toHaveLength(2);
      expect(f.connections()).toBe(1);
      expect(proxy.connections()).toBe(0);
      expect(proxy.wire()).toBe("");
    } finally {
      names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
      await f.close();
      await proxy.close();
    }
  });

  test("Bun.serve health and stop reuse the same direct peer", async () => {
    const secret = createLocalAttestationSecret();
    const peers: number[] = [];
    const paths: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, live) {
      paths.push(new URL(req.url).pathname);
      peers.push(live.requestIP(req)!.port);
      if (paths.at(-1) === "/healthz") {
        expect(req.headers.has("X-OpenCodex-API-Key")).toBe(false);
        return Response.json({ service: "opencodex", status: "ok", pid: process.pid, port: live.port,
          version: "2.76.0", restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION }, {
          headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(secret,
            req.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER)!, process.pid, live.port!)! },
        });
      }
      expect(req.headers.get("X-OpenCodex-API-Key")).toBe(ADMIN);
      return Response.json({ success: true, sharedTeardown: "performed" });
    } });
    try {
      await stopAttestedUpdateTarget({ target: { pid: process.pid, port: server.port!, hostname: "127.0.0.1", source: "runtime" },
        secret, cliVersion: "2.77.0", deadlineAt: Date.now() + 2000, beforeStop: () => {}, adminToken: ADMIN });
      expect(paths).toEqual(["/healthz", "/api/stop"]);
      expect(peers[0]).toBe(peers[1]);
    } finally { await server.stop(true); }
  });

  test("synchronous revalidation refuses before POST and sanitizes its error", async () => {
    const f = await fixture();
    try {
      f.options.beforeStop = () => { throw new Error(ADMIN); };
      await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
      expect(f.requests).toHaveLength(1);
      expect(f.wire()).not.toContain(ADMIN);
    } finally { await f.close(); }
  });

  for (const variant of ["refused", "malformed", "false success", "deferred", "not-owned", "missing teardown", "202", "truncated"] as const) {
    test(`${variant} stop response fails without retry`, async () => {
      const f = await fixture({ stop: (_req, res, body) => {
        if (variant === "refused") res.statusCode = 409;
        if (variant === "202") res.statusCode = 202;
        if (variant === "false success") body.success = false;
        if (variant === "deferred" || variant === "not-owned") body.sharedTeardown = variant;
        if (variant === "missing teardown") delete body.sharedTeardown;
        if (variant === "truncated") { res.setHeader("content-length", "1000"); res.end(JSON.stringify(body)); res.socket?.end(); }
        else res.end(variant === "malformed" ? "{bad json" : JSON.stringify(body));
      } });
      try {
        await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
        expect(f.requests.map(r => r.path)).toEqual(["/healthz", "/api/stop"]);
        expect(f.connections()).toBe(1);
      } finally { await f.close(); }
    });
  }

  for (const phase of ["health", "stop"] as const) {
    test(`${phase} body deadline covers unfinished response after headers`, async () => {
      const hung: Reply = (_req, res) => { res.writeHead(200); res.write("{"); };
      const f = await fixture({ [phase]: hung });
      try {
        f.options.deadlineAt = Date.now() + 150;
        await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
        expect(f.connections()).toBe(1);
        expect(f.requests).toHaveLength(phase === "health" ? 1 : 2);
        if (phase === "health") expect(f.wire()).not.toContain(ADMIN);
      } finally { await f.close(); }
    });
    test(`${phase} response exceeds 64 KiB and fails without retry`, async () => {
      const huge: Reply = (_req, res) => { res.end(JSON.stringify({ padding: "x".repeat(65 * 1024) })); };
      const f = await fixture({ [phase]: huge });
      try {
        await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
        expect(f.connections()).toBe(1);
        expect(f.requests).toHaveLength(phase === "health" ? 1 : 2);
        if (phase === "health") expect(f.wire()).not.toContain(ADMIN);
      } finally { await f.close(); }
    });
  }

  test("expired deadline opens no socket", async () => {
    const f = await fixture();
    try {
      f.options.deadlineAt = Date.now() - 1;
      await expect(stopAttestedUpdateTarget(f.options)).rejects.toThrow(FAILURE);
      expect(f.connections()).toBe(0);
    } finally { await f.close(); }
  });
});

describe("attested replacement observation", () => {
  test("returns exact proved replacement identity over one GET without credentials", async () => {
    const f = await fixture();
    try {
      const live = await observeAttestedUpdateReplacement({ ...f.options, version: "2.76.0" });
      expect(live).toEqual({ ...f.options.target, version: "2.76.0" });
      expect(f.requests.map(r => [r.method, r.path])).toEqual([["GET", "/healthz"]]);
      expect(f.connections()).toBe(1);
      expect(f.wire()).not.toContain(ADMIN);
    } finally { await f.close(); }
  });

  for (const variant of ["missing proof", "wrong secret", "version", "PID", "port", "client", "status", "HTTP"] as const) {
    test(`${variant} cannot prove the replacement`, async () => {
      const f = await fixture({ health: (_req, res, body) => {
        if (variant === "missing proof") res.removeHeader(LOCAL_ATTESTATION_PROOF_HEADER);
        if (variant === "version") body.version = "2.77.0";
        if (variant === "PID") body.pid = process.pid + 1;
        if (variant === "port") body.port = 1;
        if (variant === "client") body.role = "client";
        if (variant === "status") body.status = "degraded";
        if (variant === "HTTP") res.statusCode = 503;
        res.end(JSON.stringify(body));
      } });
      try {
        if (variant === "wrong secret") f.options.secret = createLocalAttestationSecret();
        await expect(observeAttestedUpdateReplacement({ ...f.options, version: "2.76.0" }))
          .rejects.toThrow("update_restart_replacement_observation_failed");
        expect(f.requests).toHaveLength(1);
        expect(f.connections()).toBe(1);
        expect(f.wire()).not.toContain(ADMIN);
      } finally { await f.close(); }
    });
  }
});
