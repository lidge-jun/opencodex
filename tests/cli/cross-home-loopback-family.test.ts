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

const envKeys = ["OPENCODEX_HOME", "CODEX_HOME", "GROK_HOME", "OCX_OWNER_REGISTRY_DIR"] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const roots: string[] = [];
const port = 10102;
const ownerPid = process.pid + 1;
const secret = "A".repeat(43);

function fixture() {
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
    `model_provider = "opencodex"\n[model_providers.opencodex]\nbase_url = "http://127.0.0.1:${port}/v1"\n`);
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
