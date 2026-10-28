import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  clientInitiatedLinkReadiness,
  createHomeInitiatedLinkReadiness,
  LINK_READINESS_TTL_MS,
  type LinkReadiness,
} from "../../src/client/link-readiness";
import { probeLinkRelayPreflight, type LinkRelayPreflightResult } from "../../src/client/link-relay-transport";
import type { ClientLinkSupervisorStatus } from "../../src/client/link-tunnel";
import { startMachineListener } from "../../src/client/machine-listener";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { LINK_RELAY_AUTH_PATH, linkRelayProof } from "../../src/link/relay-auth";
import type { TunnelState } from "../../src/link/tunnel-state";
import { validateReadyzBody } from "../../src/server/proxy-liveness";
import type { ManagementAuthState } from "../../src/server/management-auth";
import type { OcxClientConnectionConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_KEY = `ocx_data_${"k".repeat(40)}`;
const LINK_ID = `lnk_${"c".repeat(16)}`;
const KEY_ID = "link-key-1";
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];
let root = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-readiness-"));
  process.env.OPENCODEX_HOME = root;
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai" }));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (root) removeTreeWithRetry(root);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

const tunnel = (state: TunnelState, probe?: "unauthorized" | "home_unreachable" | "home_not_ready"): ClientLinkSupervisorStatus =>
  ({ kind: "tunnel", linkId: LINK_ID, state, pid: 7, ...(probe ? { probe } : {}) });

test("a Child-initiated link is ready only while its tunnel is connected and the Home answers the key", () => {
  const cases: Array<[ClientLinkSupervisorStatus, LinkReadiness]> = [
    [tunnel({ kind: "connected", since: 1 }), { ready: true }],
    [tunnel({ kind: "connected", since: 1 }, "home_not_ready"), { ready: true }],
    [tunnel({ kind: "connected", since: 1 }, "home_unreachable"), { ready: false, reason: "home_unreachable" }],
    [tunnel({ kind: "connected", since: 1 }, "unauthorized"), { ready: false, reason: "home_unauthorized" }],
    [tunnel({ kind: "connecting", since: 1 }), { ready: false, reason: "tunnel_connecting" }],
    [tunnel({ kind: "reconnecting", since: 1, attempt: 2, retryAt: 9, inFlight: false }), { ready: false, reason: "tunnel_connecting" }],
    [tunnel({ kind: "failed", since: 1, reason: "forward", retryAt: 9, inFlight: true }), { ready: false, reason: "tunnel_connecting" }],
    [tunnel({ kind: "failed", since: 1, reason: "forward", retryAt: 9, inFlight: false }), { ready: false, reason: "tunnel_failed" }],
    [tunnel({ kind: "idle" }), { ready: false, reason: "tunnel_idle" }],
    [{ kind: "stopped" }, { ready: false, reason: "tunnel_idle" }],
    [{ kind: "failed", reason: "sidecar_invalid" }, { ready: false, reason: "sidecar_invalid" }],
  ];
  for (const [status, expected] of cases) expect(clientInitiatedLinkReadiness(status)).toEqual(expected);
});

test("a Home-initiated link shares one preflight, reuses its verdict briefly and never waits long for it", async () => {
  const flights: Array<ReturnType<typeof deferred<LinkRelayPreflightResult>>> = [];
  const waits: Array<() => void> = [];
  let now = 1_000;
  let key: string | null = null;
  const readiness = createHomeInitiatedLinkReadiness({
    target: { tunnelPort: 23456, linkId: LINK_ID, apiKeyId: KEY_ID },
    linkKey: () => key,
    now: () => now,
    probe: async target => {
      expect(target).toEqual({ tunnelPort: 23456, linkId: LINK_ID, apiKeyId: KEY_ID, admissionKey: LINK_KEY });
      const flight = deferred<LinkRelayPreflightResult>();
      flights.push(flight);
      return await flight.promise;
    },
    delay: () => new Promise<void>(resolve => { waits.push(resolve); }),
  });
  // Without the committed key nothing is sent.
  expect(await readiness()).toEqual({ ready: false, reason: "link_credential_unavailable" });
  expect(flights).toHaveLength(0);

  key = LINK_KEY;
  const first = readiness();
  const second = readiness();
  await Promise.resolve();
  expect(flights).toHaveLength(1);
  flights[0]!.resolve("ok");
  expect(await first).toEqual({ ready: true });
  expect(await second).toEqual({ ready: true });
  // Cached for the TTL: an unauthenticated caller cannot multiply preflights.
  now += LINK_READINESS_TTL_MS - 1;
  expect(await readiness()).toEqual({ ready: true });
  expect(flights).toHaveLength(1);

  // A slow Home: the caller gets link_unverified once the bounded wait ends, the preflight keeps going.
  now += 1;
  const slow = readiness();
  await Promise.resolve();
  expect(flights).toHaveLength(2);
  waits.at(-1)!();
  expect(await slow).toEqual({ ready: false, reason: "link_unverified" });
  flights[1]!.resolve("unreachable");
  await flights[1]!.promise;
  await Promise.resolve();
  expect(await readiness()).toEqual({ ready: false, reason: "home_unreachable" });
  expect(flights).toHaveLength(2);

  now += LINK_READINESS_TTL_MS;
  const refused = readiness();
  await Promise.resolve();
  flights[2]!.resolve("auth_failed");
  expect(await refused).toEqual({ ready: false, reason: "link_auth_failed" });
});

/** A fake Home link listener that answers only the credential-free preflight. */
function fakeHome(answer: "proof" | "bad-proof" | "missing", seen: Request[]): Server<unknown> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      // A copy taken inside the handler: the live request's headers are not readable once it is answered.
      seen.push(new Request(req.url, { method: req.method, headers: new Headers(req.headers) }));
      const url = new URL(req.url);
      if (answer === "missing" || url.pathname !== LINK_RELAY_AUTH_PATH) return new Response("not found", { status: 404 });
      const nonce = url.searchParams.get("nonce") ?? "";
      const proof = answer === "proof"
        ? linkRelayProof(serviceApiTokenFingerprint(LINK_KEY), "listener", KEY_ID, LINK_ID, nonce)!
        : "0".repeat(64);
      return new Response(null, { status: 204, headers: { "x-opencodex-link-proof": proof } });
    },
  });
  servers.push(server);
  return server;
}

test("the preflight probe proves the Home without sending the link key", async () => {
  for (const [answer, expected] of [["proof", "ok"], ["bad-proof", "auth_failed"], ["missing", "unrecognized"]] as const) {
    const seen: Request[] = [];
    const home = fakeHome(answer, seen);
    const result = await probeLinkRelayPreflight({ tunnelPort: home.port!, linkId: LINK_ID, apiKeyId: KEY_ID, admissionKey: LINK_KEY }, { timeoutMs: 2_000 });
    expect(result).toBe(expected);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.get("authorization")).toBeNull();
    expect(seen[0]!.headers.get("x-opencodex-api-key")).toBeNull();
    expect(seen[0]!.headers.get("x-opencodex-link-probe")).toBe("1");
    expect(seen[0]!.url).not.toContain(LINK_KEY);
  }
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) });
  const port = closed.port!;
  await closed.stop(true);
  expect(await probeLinkRelayPreflight({ tunnelPort: port, linkId: LINK_ID, apiKeyId: KEY_ID, admissionKey: LINK_KEY }, { timeoutMs: 2_000 }))
    .toBe("unreachable");
});

function authState(): ManagementAuthState {
  return { available: true, token: `ocx_admin_${"a".repeat(43)}`, source: "environment", sessions: new Map(), pairingGrants: new Map() };
}

function linkConnection(): OcxClientConnectionConfig {
  return {
    serverUrl: "http://127.0.0.1:23456", managementUrl: "http://127.0.0.1:23456", managementTransport: "direct", transport: "link",
    link: { tunnelPort: 23456, linkId: LINK_ID }, selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: KEY_ID, tokenFingerprint: serviceApiTokenFingerprint(LINK_KEY), protocolVersion: 1, connectedAt: "2026-09-26T00:00:00.000Z",
  };
}

test("a Child's /readyz reports an unusable link as 503 pending with a reason, and /healthz stays live", async () => {
  let verdict: LinkReadiness = { ready: false, reason: "home_unreachable" };
  const server = startMachineListener(0, {
    state: linkConnection(), managementAuthState: authState(), linkKeySource: () => LINK_KEY,
    linkTunnel: { connected: () => ({ kind: "match" }), pending: () => false, waitForConnected: async () => false },
    linkReadiness: async () => verdict,
  });
  servers.push(server);
  expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);

  const down = await fetch(new URL("/readyz", server.url));
  expect(down.status).toBe(503);
  expect(down.headers.get("retry-after")).toBe("1");
  const downBody = await down.json() as Record<string, unknown>;
  expect(downBody).toMatchObject({ service: "opencodex", role: "client", status: "pending", link: { state: "unavailable", reason: "home_unreachable" } });
  // The strict /readyz contract (ocx ready) reads it as ours and not ready.
  expect(validateReadyzBody(downBody, server.port!)).toMatchObject({ ready: false, status: "pending" });

  verdict = { ready: true };
  const up = await fetch(new URL("/readyz", server.url));
  expect(up.status).toBe(200);
  const upBody = await up.json() as Record<string, unknown>;
  expect(upBody).toMatchObject({ status: "ready", link: { state: "available" } });
  expect(validateReadyzBody(upBody, server.port!)).toMatchObject({ ready: true, status: "ready" });
});

test("a ready Child's /readyz names its current tunnel connection, and a pending or unknown one omits it", async () => {
  let verdict: LinkReadiness = { ready: false, reason: "home_unreachable" };
  let generation: string | undefined = "fixture-child:1";
  const server = startMachineListener(0, {
    state: linkConnection(), managementAuthState: authState(), linkKeySource: () => LINK_KEY,
    linkTunnel: { connected: () => ({ kind: "match" }), pending: () => false, waitForConnected: async () => false },
    linkReadiness: async () => verdict,
    linkConnectionGeneration: () => generation,
  });
  servers.push(server);
  const link = async () => ((await (await fetch(new URL("/readyz", server.url))).json()) as { link?: unknown }).link;
  expect(await link()).toEqual({ state: "unavailable", reason: "home_unreachable" });
  verdict = { ready: true };
  expect(await link()).toEqual({ state: "available", connectionGeneration: "fixture-child:1" });
  generation = undefined;
  expect(await link()).toEqual({ state: "available" });
});
