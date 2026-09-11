/**
 * The two destination contracts a process on the hub's own machine has (#4236).
 *
 * The defect this closes: eight local integrations hardcoded `http://127.0.0.1:<public port>`,
 * an address that does not exist on a hub whose listener binds a tailnet IP. The fix is NOT one
 * base URL substituted everywhere (maintainer review on #4236) — management discovery and
 * inference are different surfaces with different admission rules, so they get one resolver
 * each and these tests hold them apart.
 *
 * The FIRST round of that fix got inference half-right and these tests pinned the bug as
 * intended: `localInferenceOrigin` returned `127.0.0.1:<public port>` whenever the loopback
 * listener was off, with no bind-address fallback, so the exact topology the issue is about —
 * listener off, `hostname` a tailnet address — still handed all eight sites a dead socket. Both
 * resolvers now have the same three-branch shape, and the inference one additionally reports
 * whether its destination demands a data-plane credential, because "reachable" and "will be
 * admitted" are different questions and a string cannot answer the second.
 *
 * The six configurations below are the review's (a)–(f). Every one of them is a shape a real
 * `config.json` can hold, and each lands in a different branch.
 */
import { describe, expect, test } from "bun:test";
import {
  localAdmissionToken,
  localInferenceDestination,
  localLoopbackInferencePorts,
  localManagementOrigin,
} from "../../src/lib/local-destinations";
import type { OcxConfig } from "../../src/types";

const TAILNET = "100.76.170.81";
const PUBLIC_PORT = 10_100;

function hub(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: PUBLIC_PORT,
    hostname: TAILNET,
    runtimeRole: "hub",
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" } },
    ...extra,
  } as unknown as OcxConfig;
}

/** The review's six configurations, each in the branch it is supposed to reach. */
const CONFIGURATIONS: Array<{
  label: string;
  config: OcxConfig;
  origin: string;
  requiresAdmissionToken: boolean;
  loopbackPorts: number[];
}> = [
  {
    // (a) standalone loopback — the shape that must stay byte-identical to the pre-#4236 string.
    label: "standalone loopback",
    config: hub({ runtimeRole: "standalone", hostname: "127.0.0.1" }),
    origin: "http://127.0.0.1:10100",
    requiresAdmissionToken: false,
    loopbackPorts: [PUBLIC_PORT],
  },
  {
    // (b) companion hub (PR2): the listener's effective port IS the public port.
    label: "companion hub",
    config: hub({ unauthenticatedLoopbackListener: { enabled: true } }),
    origin: "http://127.0.0.1:10100",
    requiresAdmissionToken: false,
    loopbackPorts: [PUBLIC_PORT],
  },
  {
    // (c) ported hub: the only form whose resolved string actually moves.
    label: "ported hub",
    config: hub({ unauthenticatedLoopbackListener: { enabled: true, port: 10_104 } }),
    origin: "http://127.0.0.1:10104",
    requiresAdmissionToken: false,
    loopbackPorts: [10_104],
  },
  {
    // (d) THE DEFECT: listener off, non-loopback bind. Nothing answers on 127.0.0.1 here, so the
    // destination is the bind address and it demands a data-plane credential.
    label: "hub with the listener off and a non-loopback bind",
    config: hub(),
    origin: `http://${TAILNET}:10100`,
    requiresAdmissionToken: true,
    loopbackPorts: [],
  },
  {
    // (e) wildcard bind: loopback DOES answer, but the public listener still demands admission
    // regardless of which address received the request. Reachable ≠ admitted.
    label: "wildcard bind",
    config: hub({ hostname: "0.0.0.0" }),
    origin: "http://127.0.0.1:10100",
    requiresAdmissionToken: true,
    loopbackPorts: [PUBLIC_PORT],
  },
  {
    // (f) client role: the role decides management, never inference. A client's own local data
    // plane is resolved by the same bind-address rule as anything else.
    label: "client role",
    config: hub({ runtimeRole: "client" }),
    origin: `http://${TAILNET}:10100`,
    requiresAdmissionToken: true,
    loopbackPorts: [],
  },
];

describe("localInferenceDestination", () => {
  for (const expected of CONFIGURATIONS) {
    test(`${expected.label} resolves to ${expected.origin}`, () => {
      const actual = localInferenceDestination(expected.config, PUBLIC_PORT);
      expect({ label: expected.label, ...actual }).toEqual({
        label: expected.label,
        origin: expected.origin,
        port: Number(new URL(expected.origin).port),
        requiresAdmissionToken: expected.requiresAdmissionToken,
      });
    });
  }

  test("a credential is demanded exactly when the destination is not a credential-free socket", () => {
    // This is the invariant the struct exists to carry: the only two free sockets are the
    // unauthenticated loopback listener and a genuinely loopback public bind. Asserting it as a
    // set, rather than per-case, is what makes a new branch that forgets the flag fail here.
    const free = CONFIGURATIONS.filter(c => !c.requiresAdmissionToken).map(c => c.label);
    expect(free).toEqual(["standalone loopback", "companion hub", "ported hub"]);
  });

  test("no listener, a disabled listener, and no config at all keep the public port on loopback", () => {
    // The "nothing changes on a plain loopback or standalone install" guarantee: every call
    // site that used to spell `http://127.0.0.1:${port}` gets that exact string back.
    for (const config of [
      undefined,
      {},
      { hostname: "127.0.0.1" },
      { hostname: "localhost" },
      { hostname: "::1" },
      { hostname: "127.0.0.1", unauthenticatedLoopbackListener: { enabled: false } },
    ] as Array<Parameters<typeof localInferenceDestination>[0]>) {
      expect({ config, ...localInferenceDestination(config, PUBLIC_PORT) }).toEqual({
        config,
        origin: "http://127.0.0.1:10100",
        port: PUBLIC_PORT,
        requiresAdmissionToken: false,
      });
    }
  });

  test("a bare IPv6 bind is bracketed, or the composed URL is unparseable", () => {
    const destination = localInferenceDestination({ hostname: "fd7a:115c:a1e0::1" }, PUBLIC_PORT);
    expect(destination.origin).toBe("http://[fd7a:115c:a1e0::1]:10100");
    expect(new URL(destination.origin).hostname).toBe("[fd7a:115c:a1e0::1]");
  });

  test("every all-zero bind spelling is a wildcard, not a hostname to dial", () => {
    // `probeHostname` used to know three spellings while the bind-scope predicate knew all of
    // them, so these composed `http://0.0.0.0.:10100` and `http://*:10100` — URLs that connect
    // to nothing — for configs the server itself treats as wildcard binds.
    for (const hostname of ["0.0.0.0", "0.0.0.0.", "00.0.0.000", "::", "[::]", "::0", "0::", "*", "0"]) {
      const destination = localInferenceDestination({ hostname }, PUBLIC_PORT);
      expect({ hostname, origin: destination.origin, requires: destination.requiresAdmissionToken })
        .toEqual({ hostname, origin: "http://127.0.0.1:10100", requires: true });
    }
  });
});

describe("localLoopbackInferencePorts", () => {
  for (const expected of CONFIGURATIONS) {
    test(`${expected.label} answers on ${JSON.stringify(expected.loopbackPorts)} at 127.0.0.1`, () => {
      expect({ label: expected.label, ports: localLoopbackInferencePorts(expected.config, PUBLIC_PORT) })
        .toEqual({ label: expected.label, ports: expected.loopbackPorts });
    });
  }

  test("a loopback or wildcard bind with a ported listener owns BOTH ports", () => {
    // This is why the set exists: `ocx claude` must not rewrite one of its own destinations
    // into the other and strip the admission token minted for it.
    for (const hostname of ["127.0.0.1", "0.0.0.0"]) {
      expect({ hostname, ports: localLoopbackInferencePorts(
        hub({ hostname, unauthenticatedLoopbackListener: { enabled: true, port: 10_104 } }),
        PUBLIC_PORT,
      ) }).toEqual({ hostname, ports: [PUBLIC_PORT, 10_104] });
    }
  });

  test("a tailnet bind with no listener owns NOTHING on loopback", () => {
    // The set is empty on purpose: a leftover `http://127.0.0.1:10100` from a previous
    // loopback-bound install is a dead socket there, and treating it as ours would preserve it.
    expect(localLoopbackInferencePorts(hub(), PUBLIC_PORT)).toEqual([]);
  });
});

describe("localAdmissionToken", () => {
  const config = hub({
    apiKeys: [{ id: "k1", name: "local", key: "ocx_data_configured", createdAt: "2026-01-01T00:00:00Z" }],
  } as unknown as Partial<OcxConfig>);

  test("the environment token wins, then the configured key", () => {
    expect(localAdmissionToken(config, { OPENCODEX_API_AUTH_TOKEN: " ocx_data_from_env " }))
      .toBe("ocx_data_from_env");
    // An empty token file path is still a lookup that finds nothing, so the configured key wins.
    expect(localAdmissionToken(config, { OCX_API_TOKEN_FILE: "/nonexistent/ocx-token" }))
      .toBe("ocx_data_configured");
    expect(localAdmissionToken(undefined, { OCX_API_TOKEN_FILE: "/nonexistent/ocx-token" }))
      .toBeUndefined();
  });

  test("the admin token is never a candidate", () => {
    // The reviewer constraint on #4236: no exported client configuration may carry management
    // authority. The ladder reads the DATA-plane variable, so an admin token in the environment
    // contributes nothing even when it is the only credential present.
    expect(localAdmissionToken({ apiKeys: [] }, {
      OPENCODEX_ADMIN_AUTH_TOKEN: `ocx_admin_${"t".repeat(43)}`,
      OCX_API_TOKEN_FILE: "/nonexistent/ocx-token",
    })).toBeUndefined();
  });
});

describe("localManagementOrigin", () => {
  test("a hub with an enabled ingress is asked on the ingress port", () => {
    expect(localManagementOrigin(
      hub({ hub: { managementIngress: { enabled: true, port: 10_102 } } }),
      PUBLIC_PORT,
    )).toBe("http://127.0.0.1:10102");
  });

  test("the loopback listener never answers management, so it is never used here", () => {
    // `/api/*` is deliberately absent from that listener's allowlist. Resolving management to
    // it would 404 every discovery call while looking like a reachable local port.
    const origin = localManagementOrigin(
      hub({
        hub: { managementIngress: { enabled: true, port: 10_102 } },
        unauthenticatedLoopbackListener: { enabled: true, port: 10_104 },
      }),
      PUBLIC_PORT,
    );
    expect(origin).toBe("http://127.0.0.1:10102");
    expect(origin).not.toContain("10104");
  });

  test("a disabled or absent ingress falls back to the bind address and public port", () => {
    expect(localManagementOrigin(hub(), PUBLIC_PORT)).toBe(`http://${TAILNET}:10100`);
    expect(localManagementOrigin(hub({ hub: { managementIngress: { enabled: false } } }), PUBLIC_PORT))
      .toBe(`http://${TAILNET}:10100`);
  });

  test("an ingress only counts on a hub, because only a hub binds one", () => {
    for (const runtimeRole of [undefined, "standalone", "client"] as const) {
      const origin = localManagementOrigin(
        hub({ runtimeRole, hostname: "127.0.0.1", hub: { managementIngress: { enabled: true, port: 10_102 } } }),
        PUBLIC_PORT,
      );
      expect({ runtimeRole, origin }).toEqual({ runtimeRole, origin: "http://127.0.0.1:10100" });
    }
  });

  test("both resolvers agree on how a bind address becomes a dialable authority", () => {
    // Management has always had the bind-address fallback; inference now has the same one. The
    // two must not disagree about a wildcard, a trailing dot, or a bare IPv6 literal, or `ocx
    // claude` would discover state on one host and send inference to another.
    const cases: Array<[string | undefined, string]> = [
      [undefined, "http://127.0.0.1:10100"],
      ["127.0.0.1", "http://127.0.0.1:10100"],
      ["0.0.0.0", "http://127.0.0.1:10100"],
      ["0.0.0.0.", "http://127.0.0.1:10100"],
      ["::", "http://127.0.0.1:10100"],
      ["::0", "http://127.0.0.1:10100"],
      ["*", "http://127.0.0.1:10100"],
      // A bare IPv6 literal has to be bracketed or the URL is unparseable.
      ["fd7a:115c:a1e0::1", "http://[fd7a:115c:a1e0::1]:10100"],
      [TAILNET, `http://${TAILNET}:10100`],
    ];
    for (const [hostname, expected] of cases) {
      const config = hub({ runtimeRole: "standalone", ...(hostname === undefined ? {} : { hostname }) });
      if (hostname === undefined) delete (config as { hostname?: string }).hostname;
      expect({ hostname, origin: localManagementOrigin(config, PUBLIC_PORT) }).toEqual({ hostname, origin: expected });
      // `localhost` and `::1` are the one documented divergence: inference pins the literal
      // 127.0.0.1 to keep the legacy string byte-identical, so they are excluded above.
      expect({ hostname, origin: localInferenceDestination(config, PUBLIC_PORT).origin })
        .toEqual({ hostname, origin: expected });
    }
  });
});
