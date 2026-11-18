import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCrossHomeOwnerDetailed, markCrossHomeSibling } from "../../src/cli/cross-home-owner";
import { loopbackFamilyAvailability, type LoopbackFamilyAvailability } from "../../src/cli/loopback-family";
import { resetSiblingStartForTests, siblingOfLivePort } from "../../src/codex/sibling-start";
import { LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof } from "../../src/lib/local-management-attestation";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { localConnectTimeoutFetch } from "../helpers/local-connect-timeout";
import type { LivenessIo } from "../../src/server/proxy-liveness";

const envKeys = ["OPENCODEX_HOME", "CODEX_HOME", "GROK_HOME", "OCX_OWNER_REGISTRY_DIR"] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const roots: string[] = [];
const port = 10102;
const ownerPid = process.pid + 1;
const secret = "A".repeat(43);

function fixture(managedPort = port) {
  const root = mkdtempSync(join(tmpdir(), "ocx-loopback-family-"));
  roots.push(root);
  const home = join(root, "home");
  for (const key of envKeys) {
    const dir = join(root, key.toLowerCase());
    mkdirSync(dir, { recursive: true });
    process.env[key] = dir;
  }
  mkdirSync(join(home, ".opencodex"), { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME!, "config.toml"),
    `model_provider = "opencodex"\n[model_providers.opencodex]\nbase_url = "http://127.0.0.1:${managedPort}/v1"\n`);
  return { home };
}

afterEach(() => {
  resetSiblingStartForTests();
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

test.each(["EADDRNOTAVAIL", "EAFNOSUPPORT", "EPROTONOSUPPORT"])(
  "%s from an IPv6 bind proves the family unavailable", code => {
    expect(loopbackFamilyAvailability("[::1]", hostname => {
      expect(hostname).toBe("::1");
      throw Object.assign(new Error("unavailable"), { code });
    })).toBe("unavailable");
  },
);

test.each(["EACCES", "EPERM", "EMFILE", "EADDRINUSE", "ETIMEDOUT", "EINVAL", "ENETUNREACH"])(
  "%s from a bind does not prove address absence", code => {
    expect(loopbackFamilyAvailability("[::1]", () => {
      throw Object.assign(new Error("ambiguous"), { code });
    })).toBe("unknown");
  },
);

test("successful availability check closes the ephemeral listener synchronously", () => {
  let closed = 0;
  expect(loopbackFamilyAvailability("127.0.0.1", () => ({ stop() { closed++; } }))).toBe("available");
  expect(closed).toBe(1);
  expect(loopbackFamilyAvailability("example.com", () => { throw new Error("must not bind"); })).toBe("unknown");
});

test("the real kernel bind can check IPv4 loopback availability", () => {
  expect(loopbackFamilyAvailability("127.0.0.1")).toBe("available");
});

function probes(ipv6: LoopbackFamilyAvailability, liveHost?: string) {
  const requests: string[] = [];
  const checked: string[] = [];
  return {
    requests, checked,
    loopbackAvailabilityFn: (hostname: string) => {
      checked.push(hostname);
      return hostname === "[::1]" ? ipv6 : "available" as const;
    },
    io: {
      attempts: 1, timeoutMs: 50,
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push(url.hostname);
        if (url.hostname === liveHost) {
          const headers = new Headers();
          const challenge = new Headers(init?.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
          if (challenge) headers.set(LOCAL_ATTESTATION_PROOF_HEADER,
            createLocalAttestationProof(secret, challenge, ownerPid, port));
          return Response.json({ service: "opencodex", status: "ok", version: "0.0.0", uptime: 1, pid: ownerPid }, { headers });
        }
        // Reproduce the reported connect behavior: the disabled ::1 route times
        // out while IPv4 refuses. Absence is proven by the bind check, not this.
        throw Object.assign(new Error("connect failed"), {
          code: url.hostname === "[::1]" ? "ETIMEDOUT" : "ECONNREFUSED",
        });
      }) as typeof fetch,
    },
  };
}

test("IPv4 refusal plus unavailable IPv6 permits startup without dialing the timeout route", async () => {
  const fx = fixture();
  const probe = probes("unavailable");
  expect(await markCrossHomeSibling({ homeDir: fx.home, ...probe })).toBe(false);
  expect(siblingOfLivePort()).toBeNull();
  expect(probe.requests.length).toBeGreaterThan(0);
  expect(probe.requests.every(host => host === "127.0.0.1")).toBe(true);
  expect(probe.checked).toEqual(["127.0.0.1", "[::1]"]);
});

test.each(["available", "unknown"] as const)("IPv6 %s plus timeout still refuses startup", async availability => {
  const fx = fixture();
  const probe = probes(availability);
  expect((await findCrossHomeOwnerDetailed({ homeDir: fx.home, ...probe })).kind).toBe("indeterminate");
  await expect(markCrossHomeSibling({ homeDir: fx.home, ...probe })).rejects.toThrow("refusing startup");
  expect(probe.requests).toContain("[::1]");
});

test("an unregistered live IPv4 listener still blocks startup when IPv6 is unavailable", async () => {
  const fx = fixture();
  await expect(markCrossHomeSibling({ homeDir: fx.home, ...probes("unavailable", "127.0.0.1") }))
    .rejects.toThrow("refusing startup");
});

test("a network-unreachable bind does not hide an unregistered live IPv6 owner", async () => {
  const fx = fixture();
  const probe = probes("unknown", "[::1]");
  const loopbackAvailabilityFn = (hostname: string) => loopbackFamilyAvailability(hostname, () => {
    if (hostname === "[::1]") throw Object.assign(new Error("route failure"), { code: "ENETUNREACH" });
    return { stop() {} };
  });
  await expect(markCrossHomeSibling({ homeDir: fx.home, ...probe, loopbackAvailabilityFn }))
    .rejects.toThrow("refusing startup");
  expect(probe.requests).toContain("[::1]");
});

test.each(["127.0.0.1", "[::1]"])("an attested live %s owner still makes the start a sibling", async host => {
  const fx = fixture();
  writeFileSync(join(fx.home, ".opencodex", "runtime-port.json"), JSON.stringify({
    pid: ownerPid, port, attestationSecret: secret, hostname: host,
  }));
  expect(await markCrossHomeSibling({ homeDir: fx.home, ...probes("available", host) })).toBe(true);
  expect(siblingOfLivePort()).toBe(port);
});

function windowsDiscovery(homeDir: string, address: string, overrides: LivenessIo = {}) {
  const binds: Array<[string, number]> = [];
  const options = {
    homeDir,
    loopbackAvailabilityFn: () => "available" as const,
    io: {
      platform: "win32", attempts: 2, timeoutMs: 100, sleepFn: async () => {},
      fetchFn: localConnectTimeoutFetch(host => host === address ? "timeout" : "refused"),
      bindProofFn: async (host: string, port: number) => { binds.push([host, port]); return true; },
      ...overrides,
    } satisfies LivenessIo,
  };
  return { options, binds };
}

test.each([["127.0.0.1", "0.0.0.0"], ["::1", "::"]])("a Windows %s timeout can clear the shared-client startup fence", async (address, wildcard) => {
  const { options, binds } = windowsDiscovery(fixture().home, address);
  expect(await markCrossHomeSibling(options)).toBe(false);
  expect(binds).toEqual([[address, port], [wildcard, port]]);
  expect(siblingOfLivePort()).toBeNull();
});

test.each(["127.0.0.1", "0.0.0.0", "error"])("the shared-client fence refuses an unprovable %s bind", async blocked => {
  const binds: string[] = [];
  const { options } = windowsDiscovery(fixture().home, "127.0.0.1", { bindProofFn: async address => {
    binds.push(address);
    if (blocked === "error") throw new Error("unavailable");
    return address !== blocked;
  } });
  await expect(markCrossHomeSibling(options)).rejects.toThrow("refusing startup before any shared-client write");
  expect(binds).toEqual(blocked === "0.0.0.0" ? ["127.0.0.1", "0.0.0.0"] : ["127.0.0.1"]);
  expect(siblingOfLivePort()).toBeNull();
});

test("a live recorded sibling-home process prevents absence even when its endpoint binds", async () => {
  const { home } = fixture();
  writeFileSync(join(home, ".opencodex", "runtime-port.json"), JSON.stringify({ pid: process.pid, port }));
  const { options, binds } = windowsDiscovery(home, "127.0.0.1", { readCommandLineFn: () => "ocx start" });
  await expect(markCrossHomeSibling(options)).rejects.toThrow("refusing startup before any shared-client write");
  expect(binds).toEqual([["127.0.0.1", port], ["0.0.0.0", port]]);
});

test.each(["deadline", "cancel"])("shared-client discovery discards a bind proof after %s", async stop => {
  const controller = new AbortController();
  let clock = 10;
  const binds: Array<[string, number]> = [];
  const { options } = windowsDiscovery(fixture().home, "127.0.0.1", {
    deadlineAt: 60, nowFn: () => clock, signal: controller.signal,
    bindProofFn: async (address, _port, budget) => {
      binds.push([address, budget]);
      if (stop === "cancel") controller.abort();
      else clock = 60;
      return true;
    },
  });
  await expect(markCrossHomeSibling(options)).rejects.toThrow("shared time budget");
  expect(binds).toEqual([["127.0.0.1", 50]]);
});

test("shared-client rediscovery still finds an attested owner that appears after the bind proof", async () => {
  const released = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const latePort = released.port;
  await released.stop(true);
  const { home } = fixture(latePort);
  const { options } = windowsDiscovery(home, "127.0.0.1");
  expect(await markCrossHomeSibling({ ...options, io: { ...options.io, bindProofFn: undefined } })).toBe(false);

  const owner = Bun.serve({ hostname: "127.0.0.1", port: latePort, fetch(request) {
    const challenge = request.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
    const headers = challenge ? { [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(secret, challenge, ownerPid, latePort) } : undefined;
    return Response.json({ service: "opencodex", pid: ownerPid }, { headers });
  } });
  try {
    writeFileSync(join(home, ".opencodex", "runtime-port.json"), JSON.stringify({ pid: ownerPid, port: latePort, attestationSecret: secret }));
    expect(await markCrossHomeSibling({ ...options, io: { ...options.io, fetchFn: undefined, timeoutMs: 1_500 } })).toBe(true);
    expect(siblingOfLivePort()).toBe(latePort);
  } finally { await owner.stop(true); }
});
