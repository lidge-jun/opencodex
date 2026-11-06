import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { verifiedHomeConnection } from "../../src/client/link-connection";
import { collectLinkConnectionGeneration } from "../../src/cli/status-link";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import { createLinkSupervisor } from "../../src/link/supervisor";
import {
  LINK_RELAY_AUTH_PATH, LINK_RELAY_CONNECTION_HEADER, LINK_RELAY_CONNECTION_PROOF_HEADER,
  linkConnectionProof, linkRelayProof,
} from "../../src/link/relay-auth";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import type { SshChild, SshRunner } from "../../src/link/ssh-runner";

const key = `ocx_data_${"a".repeat(40)}`;
const keyId = "test-link-key";
const fp = serviceApiTokenFingerprint(key);
const target = (port: number, linkId: string) => ({ tunnelPort: port, admissionKey: key, apiKeyId: keyId, linkId });

function homeAnswering(connection: () => string | undefined) {
  const sessions = createLinkRelaySessions({ fingerprints: () => [fp], connectionGeneration: connection });
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => sessions.dispatch(req, server, async () => new Response(null, { status: 204 })) });
}

test("a Home-initiated reconnect is visible to the Child through the Home's signed relay answer", async () => {
  const linkId = "lnk_1111111111111111";
  let current = "fixture-home:1";
  const home = homeAnswering(() => current);
  try {
    expect(verifiedHomeConnection(linkId)).toBeUndefined();
    expect(await probeLinkRelayPreflight(target(home.port!, linkId))).toBe("ok");
    expect(verifiedHomeConnection(linkId)).toBe("fixture-home:1");
    expect(await probeLinkRelayPreflight(target(home.port!, linkId))).toBe("ok");
    expect(verifiedHomeConnection(linkId)).toBe("fixture-home:1");
    current = "fixture-home:2";
    expect(await probeLinkRelayPreflight(target(home.port!, linkId))).toBe("ok");
    expect(verifiedHomeConnection(linkId)).toBe("fixture-home:2");
  } finally { home.stop(true); }
});

test("an older Home that announces no connection leaves the generation unknown", async () => {
  const linkId = "lnk_2222222222222222";
  const home = homeAnswering(() => undefined);
  try {
    expect(await probeLinkRelayPreflight(target(home.port!, linkId))).toBe("ok");
    expect(verifiedHomeConnection(linkId)).toBeUndefined();
  } finally { home.stop(true); }
});

test("a connection generation whose proof does not bind it to this nonce and key is ignored", async () => {
  const linkId = "lnk_3333333333333333";
  const home = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== LINK_RELAY_AUTH_PATH) return new Response(null, { status: 404 });
    const nonce = url.searchParams.get("nonce")!;
    return new Response(null, { status: 204, headers: {
      "x-opencodex-link-proof": linkRelayProof(fp, "listener", keyId, linkId, nonce)!,
      [LINK_RELAY_CONNECTION_HEADER]: "fixture-home:forged",
      // A proof for another generation cannot vouch for this one.
      [LINK_RELAY_CONNECTION_PROOF_HEADER]: linkConnectionProof(fp, keyId, linkId, nonce, "fixture-home:other")!,
    } });
  } });
  try {
    expect(await probeLinkRelayPreflight(target(home.port!, linkId))).toBe("ok");
    expect(verifiedHomeConnection(linkId)).toBeUndefined();
  } finally { home.stop(true); }
});

const HOME_LINK = "lnk_0123456789abcdef";

/** A Home supervisor over scripted ssh children; the first tick spawns the link's tunnel. */
function homeSupervisor() {
  const children: Array<{ resolve: (code: number) => void }> = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) {
      let resolve!: (code: number) => void;
      const exited = new Promise<number>(done => { resolve = done; });
      children.push({ resolve });
      return { pid: 500 + children.length, argv: [...argv], exited, stderr: Promise.resolve(""), kill: () => resolve(143) } satisfies SshChild;
    },
  };
  const timers: Array<() => void> = [];
  const supervisor = createLinkSupervisor({
    readStore: () => ({ version: 1, listenerPort: 19001, links: [{ id: HOME_LINK, alias: "child.example", direction: "hub-initiated",
      hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 19002, apiKeyId: "fixture-key", createdAt: "2026-10-27T00:00:00.000Z" }] }),
    runner, now: () => 5_000, readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
    setTimer: callback => { timers.push(callback); return 1 as unknown as ReturnType<typeof setInterval>; }, clearTimer: () => {},
  });
  return {
    supervisor, children,
    async start() { supervisor.start(); timers[0]?.(); await Promise.resolve(); },
  };
}

test("a Home tunnel restarted for the same link and listener announces a new generation and a steady one keeps it", async () => {
  const { supervisor, children, start } = homeSupervisor();
  try {
    expect(supervisor.connectionGeneration?.(HOME_LINK)).toBeUndefined();
    await start();
    expect(children).toHaveLength(1);
    const first = supervisor.connectionGeneration?.(HOME_LINK);
    expect(first).toEqual(expect.any(String));
    expect(supervisor.connectionGeneration?.(HOME_LINK)).toBe(first);
    expect(await supervisor.reconnect(HOME_LINK)).toBe(true);
    expect(children).toHaveLength(2);
    const second = supervisor.connectionGeneration?.(HOME_LINK);
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect(supervisor.connectionGeneration?.("lnk_fedcba9876543210")).toBeUndefined();
  } finally { await supervisor.stop(); }
});

test("a Home supervisor rebuilt in the same process never repeats a connection generation", async () => {
  const seen: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    const home = homeSupervisor();
    try {
      await home.start();
      expect(home.children).toHaveLength(1);
      seen.push(home.supervisor.connectionGeneration!(HOME_LINK)!);
    } finally { await home.supervisor.stop(); }
  }
  expect(seen[0]).toEqual(expect.any(String));
  expect(seen[1]).not.toBe(seen[0]);
});

test("a runtime restart changes every connection generation", () => {
  const relayAuth = new URL("../../src/link/relay-auth.ts", import.meta.url).href;
  const read = () => {
    const result = spawnSync(process.execPath, ["-e", `const m = await import(${JSON.stringify(relayAuth)}); console.log(m.nextLinkConnectionGeneration());`], { encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  const one = read();
  expect(one).toMatch(/^[0-9a-f-]{36}:1$/);
  expect(read()).not.toBe(one);
});

function readyz(body: Record<string, unknown>, status = 200) {
  return (async () => Response.json({ service: "opencodex", version: "fixture", role: "client", uptime: 1, pid: 4321, port: 10100, protocolVersion: 1, ...body }, { status })) as unknown as typeof fetch;
}

test("status reports the Child runtime's ready connection generation and omits it whenever it is unknown", async () => {
  const live = { pid: 4321, port: 10100, role: "client" };
  expect(await collectLinkConnectionGeneration(live, { fetchImpl: readyz({ status: "ready", link: { state: "available", connectionGeneration: "fixture-child:3" } }) }))
    .toBe("fixture-child:3");
  for (const [fetchImpl, label] of [
    [readyz({ status: "ready", link: { state: "available" } }), "no generation"],
    [readyz({ status: "pending", link: { state: "unavailable", reason: "home_unreachable" } }, 503), "not ready"],
    [readyz({ status: "ready", link: { state: "available", connectionGeneration: "has space" } }), "invalid value"],
    [readyz({ status: "ready", pid: 1, link: { state: "available", connectionGeneration: "fixture-child:3" } }), "another process"],
    [(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch, "unreachable"],
  ] as const) {
    expect({ label, value: await collectLinkConnectionGeneration(live, { fetchImpl }) }).toEqual({ label, value: undefined });
  }
  expect(await collectLinkConnectionGeneration({ ...live, role: "standalone" }, { fetchImpl: readyz({ status: "ready", link: { state: "available", connectionGeneration: "fixture-child:3" } }) }))
    .toBeUndefined();
  expect(await collectLinkConnectionGeneration(null)).toBeUndefined();
});

/** A Home answering with a valid relay proof and, per mode, a bound, missing or mismatched generation. */
function switchableHome(linkId: string) {
  const state = { mode: "bound" as "bound" | "missing" | "invalid", generation: "fixture-home:1" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== LINK_RELAY_AUTH_PATH) return new Response(null, { status: 404 });
    const nonce = url.searchParams.get("nonce")!;
    const headers: Record<string, string> = { "x-opencodex-link-proof": linkRelayProof(fp, "listener", keyId, linkId, nonce)! };
    if (state.mode !== "missing") {
      headers[LINK_RELAY_CONNECTION_HEADER] = state.generation;
      headers[LINK_RELAY_CONNECTION_PROOF_HEADER] = state.mode === "bound"
        ? linkConnectionProof(fp, keyId, linkId, nonce, state.generation)!
        : linkConnectionProof(fp, keyId, linkId, nonce, "fixture-home:other")!;
    }
    return new Response(null, { status: 204, headers });
  } });
  return { server, state };
}

for (const next of ["missing", "invalid"] as const) {
  test(`a known Home generation becomes unknown when the next authenticated answer has a ${next} one`, async () => {
    const linkId = next === "missing" ? "lnk_4444444444444444" : "lnk_5555555555555555";
    const home = switchableHome(linkId);
    try {
      expect(await probeLinkRelayPreflight(target(home.server.port!, linkId))).toBe("ok");
      expect(verifiedHomeConnection(linkId)).toBe("fixture-home:1");
      home.state.mode = next;
      home.state.generation = "fixture-home:2";
      expect(await probeLinkRelayPreflight(target(home.server.port!, linkId))).toBe("ok");
      expect(verifiedHomeConnection(linkId)).toBeUndefined();
      home.state.mode = "bound";
      expect(await probeLinkRelayPreflight(target(home.server.port!, linkId))).toBe("ok");
      expect(verifiedHomeConnection(linkId)).toBe("fixture-home:2");
    } finally { home.server.stop(true); }
  });
}
