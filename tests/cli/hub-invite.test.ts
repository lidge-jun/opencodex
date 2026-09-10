import { describe, expect, spyOn, test } from "bun:test";
import {
  appendCorsAllowOriginsCommand,
  configSetHubLines,
  derivedHubDataOrigin,
  hubInviteCommand,
  inviteBoundOriginNotes,
  pairingOriginUsable,
  parseHubInviteArgs,
  parseInviteClients,
  resolveHubDataOrigin,
  runHubCommand,
  selectInviteBrowserOrigin,
} from "../../src/cli/hub";
import type { GuiPairRequestResult } from "../../src/cli/gui-pair-client";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import type { OcxConfig } from "../../src/types";

/**
 * `ocx hub invite` (#4236).
 *
 * The command's whole value is that the line it prints can be pasted on the other machine and
 * work, so these tests pin the two things that decide that: WHICH origins end up in the command,
 * and WHICH configurations are refused before a single-use code is burned on a request the hub
 * would have rejected anyway.
 *
 * The mint itself is not re-tested here -- it is the existing attested `ocx gui pair` route, and
 * `requestPairingGrant` is injected so no proxy, no socket and no real grant is involved.
 */
const GRANT = `ocx_pair_${"A".repeat(43)}`;
const EXPIRES_AT = 1_767_225_600_000;

const LIVE: LiveProxy = { pid: 4242, port: 10100, hostname: "100.64.0.10", source: "runtime" };

function hubConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    hostname: "100.64.0.10",
    runtimeRole: "hub",
    corsAllowOrigins: ["http://localhost:10100"],
    hub: { managementPublicOrigin: "https://hub.tailnet.ts.net" },
    ...overrides,
  } as OcxConfig;
}

async function invite(
  args: string[],
  config: OcxConfig,
  options: { live?: LiveProxy | null; result?: GuiPairRequestResult } = {},
): Promise<{ code: number; out: string[]; err: string[]; boundOrigin: string | null }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  });
  const error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  });
  let boundOrigin: string | null = null;
  try {
    const code = await runHubCommand(args, {
      loadConfig: () => config,
      findLiveProxy: async () => (options.live === undefined ? LIVE : options.live),
      requestPairingGrant: async (_target, browserOrigin) => {
        boundOrigin = browserOrigin;
        return options.result ?? {
          kind: "created",
          grant: GRANT,
          browserOrigin,
          serverOrigin: "https://hub.tailnet.ts.net",
          expiresAt: EXPIRES_AT,
        };
      },
    });
    return { code, out, err, boundOrigin };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("hub invite argument and origin helpers", () => {
  test("parses the documented flags and rejects anything else", () => {
    expect(parseHubInviteArgs([])).toEqual({ json: false });
    expect(parseHubInviteArgs(["--json"])).toEqual({ json: true });
    expect(parseHubInviteArgs(["--data-url", "https://a.test:8443", "--clients", "codex"]))
      .toEqual({ json: false, dataUrl: "https://a.test:8443", clients: "codex" });
    // A repeated flag, a missing value, and an unknown token are all usage errors rather than
    // a silently-dropped argument: the printed command is what the operator will run.
    expect(parseHubInviteArgs(["--json", "--json"])).toBeNull();
    expect(parseHubInviteArgs(["--data-url"])).toBeNull();
    expect(parseHubInviteArgs(["--data-url", "--json"])).toBeNull();
    expect(parseHubInviteArgs(["--origin", "x"])).toBeNull();
  });

  test("clients accepts codex and claude only, and omission means 'do not pass --clients'", () => {
    expect(parseInviteClients(undefined)).toEqual([]);
    expect(parseInviteClients("codex,claude")).toEqual(["codex", "claude"]);
    expect(parseInviteClients("claude")).toEqual(["claude"]);
    expect(parseInviteClients("cursor")).toBeNull();
    expect(parseInviteClients("")).toBeNull();
  });

  test("the transport rule matches the hub's: loopback or HTTPS, nothing else", () => {
    expect(pairingOriginUsable("https://hub.tailnet.ts.net")).toBe(true);
    expect(pairingOriginUsable("http://127.0.0.1:10101")).toBe(true);
    expect(pairingOriginUsable("http://localhost:10101")).toBe(true);
    expect(pairingOriginUsable("http://100.64.0.10:10101")).toBe(false);
  });

  test("the derived data origin is the bind address, with loopback spelled as localhost", () => {
    expect(derivedHubDataOrigin("100.64.0.10", 10100)).toBe("http://100.64.0.10:10100");
    expect(derivedHubDataOrigin("0.0.0.0", 10100)).toBe("http://localhost:10100");
    expect(derivedHubDataOrigin("fd7a::1", 8443)).toBe("http://[fd7a::1]:8443");
  });

  test("the grant binds to the connecting machine's loopback origin, not the hub's", () => {
    // `ocx connect` sends Origin: http://localhost:<its own port> (client/connect.ts
    // localGuiOrigin), so only a loopback entry in the hub's allow-list can ever match.
    expect(selectInviteBrowserOrigin(hubConfig())).toBe("http://localhost:10100");
    expect(selectInviteBrowserOrigin(hubConfig({ corsAllowOrigins: ["http://localhost:9999"] })))
      .toBe("http://localhost:9999");
    expect(selectInviteBrowserOrigin(hubConfig({ corsAllowOrigins: ["https://elsewhere.test"] })))
      .toBeNull();
  });

  test("the data origin refuses a loopback bind and a wildcard bind, and takes an explicit one", () => {
    // `probeHostname` spells 0.0.0.0, ::, and 127.0.0.1 all as loopback, so the derived origin
    // would tell the other machine to dial ITSELF -- and the code is single-use.
    for (const bind of ["127.0.0.1", "localhost", "0.0.0.0", "::", undefined] as const) {
      expect(resolveHubDataOrigin(null, undefined, bind, 10100)).toEqual({
        kind: "loopback-derived",
        dataUrl: "http://localhost:10100",
        bindHostname: bind ?? "127.0.0.1",
      });
    }
    expect(resolveHubDataOrigin(null, undefined, "100.64.0.10", 10100))
      .toEqual({ kind: "usable", dataUrl: "http://100.64.0.10:10100", source: "derived" });
    // An explicit origin is never second-guessed: loopback is legitimate over an SSH tunnel.
    expect(resolveHubDataOrigin("http://localhost:9000", undefined, "127.0.0.1", 10100))
      .toEqual({ kind: "usable", dataUrl: "http://localhost:9000", source: "flag" });
    expect(resolveHubDataOrigin(null, "https://hub.tailnet.ts.net:8443", "127.0.0.1", 10100))
      .toEqual({ kind: "usable", dataUrl: "https://hub.tailnet.ts.net:8443", source: "config" });
    // A malformed persisted value must not silently become the loopback fallback.
    expect(resolveHubDataOrigin(null, "not-an-origin", "100.64.0.10", 10100))
      .toEqual({ kind: "usable", dataUrl: "http://100.64.0.10:10100", source: "derived" });
  });

  test("the surfaced config commands work on a config that has no hub object yet", () => {
    // `ocx config set hub.x` exits with `config parent path not found: hub` when `hub` is
    // absent (setPath in config-command.ts walks existing parents only).
    expect(configSetHubLines({ hub: undefined } as Partial<OcxConfig>, "dataPublicOrigin", "https://d.test"))
      .toEqual(["ocx config set hub '{}'", `ocx config set hub.dataPublicOrigin '"https://d.test"'`]);
    expect(configSetHubLines({ hub: {} } as Partial<OcxConfig>, "managementPublicOrigin", "https://m.test"))
      .toEqual([`ocx config set hub.managementPublicOrigin '"https://m.test"'`]);
  });

  test("the corsAllowOrigins command adds to the list instead of replacing it", () => {
    // `ocx config set corsAllowOrigins '[...]'` overwrites, so a one-element literal would
    // tell an operator with an existing allow-list to delete it.
    expect(appendCorsAllowOriginsCommand({ corsAllowOrigins: ["https://a.test"] }, "http://localhost:10100"))
      .toBe(`ocx config set corsAllowOrigins '["https://a.test","http://localhost:10100"]'`);
    expect(appendCorsAllowOriginsCommand({}, "http://localhost:10100"))
      .toBe(`ocx config set corsAllowOrigins '["http://localhost:10100"]'`);
    // Idempotent: never suggest a duplicate entry.
    expect(appendCorsAllowOriginsCommand({ corsAllowOrigins: ["http://localhost:10100"] }, "http://localhost:10100"))
      .toBe(`ocx config set corsAllowOrigins '["http://localhost:10100"]'`);
  });

  test("the bound browser origin is always stated, and a non-default one names the client's port", () => {
    expect(inviteBoundOriginNotes("http://localhost:10100", {})).toEqual([
      "Bound browser origin: http://localhost:10100 — the connecting machine must present exactly this.",
    ]);
    const notes = inviteBoundOriginNotes("http://localhost:9999", { corsAllowOrigins: ["http://localhost:9999"] });
    expect(notes[0]).toContain("http://localhost:9999");
    expect(notes.join(" ")).toContain("ocx config set port 9999");
    expect(notes.join(" ")).toContain(`'["http://localhost:9999","http://localhost:10100"]'`);
  });

  test("the printed command carries --clients only when the operator asked for it", () => {
    expect(hubInviteCommand(GRANT, "https://d.test:8443", "https://m.test", []))
      .toBe(`echo '${GRANT}' | ocx connect https://d.test:8443 --management-url https://m.test --pairing-code-stdin`);
    expect(hubInviteCommand(GRANT, "https://d.test:8443", "https://m.test", ["codex"]))
      .toContain("--clients codex --pairing-code-stdin");
  });
});

describe("hub invite output", () => {
  test("prints a runnable connect line and keeps the code off stderr", async () => {
    const { code, out, err, boundOrigin } = await invite(["invite"], hubConfig());
    expect(code).toBe(0);
    expect(boundOrigin).toBe("http://localhost:10100");
    expect(out.join("\n")).toContain("# Run on the other machine:");
    expect(out.join("\n")).toContain(
      `echo '${GRANT}' | ocx connect http://100.64.0.10:10100 --management-url https://hub.tailnet.ts.net --pairing-code-stdin`,
    );
    // The warning is advice, not output a script should capture.
    expect(err.join("\n")).toContain("single-use");
    expect(err.join("\n")).not.toContain(GRANT);
  });

  test("the bound browser origin reaches stderr in both modes, with a warning when it differs", async () => {
    const plain = await invite(["invite"], hubConfig());
    expect(plain.err.join("\n")).toContain("Bound browser origin: http://localhost:10100");
    expect(plain.err.join("\n")).not.toContain("ocx config set port");

    const asJson = await invite(["invite", "--json"], hubConfig());
    expect(asJson.err.join("\n")).toContain("Bound browser origin: http://localhost:10100");

    // `selectInviteBrowserOrigin` silently fell back to the first admitted loopback origin, and
    // a remote `ocx connect` only sends http://localhost:<its own port> -- so without this the
    // single-use code was spent with nothing saying why.
    const other = await invite(["invite"], hubConfig({ corsAllowOrigins: ["http://localhost:9999"] }));
    expect(other.code).toBe(0);
    expect(other.boundOrigin).toBe("http://localhost:9999");
    expect(other.err.join("\n")).toContain("Bound browser origin: http://localhost:9999");
    expect(other.err.join("\n")).toContain("ocx config set port 9999");
  });

  test("hub.dataPublicOrigin replaces the derived origin, and --data-url replaces both", async () => {
    const configured = hubConfig({
      hub: { managementPublicOrigin: "https://hub.tailnet.ts.net", dataPublicOrigin: "https://hub.tailnet.ts.net:8443" },
    });
    const fromConfig = await invite(["invite"], configured);
    expect(fromConfig.out.join("\n")).toContain("ocx connect https://hub.tailnet.ts.net:8443 ");

    const overridden = await invite(["invite", "--data-url", "https://front.test"], configured);
    expect(overridden.out.join("\n")).toContain("ocx connect https://front.test ");
  });

  test("--json emits exactly the documented envelope", async () => {
    const { code, out } = await invite(["invite", "--json", "--clients", "codex,claude"], hubConfig());
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({
      code: GRANT,
      expiresAt: new Date(EXPIRES_AT).toISOString(),
      dataUrl: "http://100.64.0.10:10100",
      managementUrl: "https://hub.tailnet.ts.net",
      command: `echo '${GRANT}' | ocx connect http://100.64.0.10:10100 --management-url https://hub.tailnet.ts.net --clients codex,claude --pairing-code-stdin`,
    });
  });
});

describe("hub invite refuses before burning a code", () => {
  test("a non-hub gets one line naming its own role and the command it should run", async () => {
    for (const role of [undefined, "standalone", "client"] as const) {
      const { code, err } = await invite(["invite"], hubConfig({ runtimeRole: role } as Partial<OcxConfig>));
      expect(code).toBe(1);
      expect(err.join(" ")).toContain("runs on a hub");
      expect(err.join(" ")).toContain("ocx connect");
    }
  });

  test("a hub with no management origin is told which field to set, in a runnable form", async () => {
    const { code, err } = await invite(["invite"], hubConfig({ hub: {} }));
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("hub.managementPublicOrigin");
    expect(err.join(" ")).not.toContain("ocx config set hub '{}'");

    // With no `hub` object at all the dotted form exits `config parent path not found: hub`,
    // so the parent-creating line has to come with it.
    const absent = await invite(["invite"], hubConfig({ hub: undefined }));
    expect(absent.code).toBe(1);
    expect(absent.err.join("\n")).toContain("ocx config set hub '{}'");
    expect(absent.err.join("\n")).toContain("ocx config set hub.managementPublicOrigin");
  });

  test("a --management-url that differs from the configured origin is refused, not printed", async () => {
    // The grant's server origin IS hub.managementPublicOrigin, so advertising anything else
    // hands out a code the hub then refuses. Saying so beats printing a dud command.
    const { code, err } = await invite(["invite", "--management-url", "https://other.test"], hubConfig());
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("does not match hub.managementPublicOrigin");

    const matching = await invite(["invite", "--management-url", "https://hub.tailnet.ts.net"], hubConfig());
    expect(matching.code).toBe(0);
  });

  test("a non-loopback plaintext management origin cannot carry a code", async () => {
    const { code, err } = await invite(["invite"], hubConfig({
      hub: { managementPublicOrigin: "http://100.64.0.10:10101" },
    }));
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("plain HTTP");
  });

  test("a hub whose allow-list names no loopback origin is told exactly what to add", async () => {
    const { code, err } = await invite(["invite"], hubConfig({ corsAllowOrigins: [] }));
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("corsAllowOrigins");
    expect(err.join(" ")).toContain("http://localhost:10100");
  });

  test("a loopback-derived data origin is refused before a code is minted", async () => {
    // The incident shape: a hub bound to loopback (or a wildcard) with no hub.dataPublicOrigin
    // printed `ocx connect http://localhost:10100`, which on the other machine means "dial
    // yourself" -- and the code was gone.
    for (const bind of ["127.0.0.1", "0.0.0.0"] as const) {
      const { code, err, boundOrigin } = await invite(
        ["invite"],
        hubConfig({ hostname: bind }),
        { live: { pid: 4242, port: 10100, hostname: bind, source: "runtime" } },
      );
      expect(code).toBe(1);
      expect(boundOrigin).toBeNull(); // nothing was minted
      expect(err.join(" ")).toContain("http://localhost:10100");
      expect(err.join(" ")).toContain("hub.dataPublicOrigin");
      expect(err.join(" ")).toContain("--data-url");
    }
    expect((await invite(["invite"], hubConfig({ hostname: "0.0.0.0" }), {
      live: { pid: 4242, port: 10100, hostname: "0.0.0.0", source: "runtime" },
    })).err.join(" ")).toContain("wildcard");

    // Either explicit origin unblocks it.
    const viaFlag = await invite(["invite", "--data-url", "https://hub.tailnet.ts.net:8443"], hubConfig({ hostname: "127.0.0.1" }), {
      live: { pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" },
    });
    expect(viaFlag.code).toBe(0);
    const viaConfig = await invite(["invite"], hubConfig({
      hostname: "127.0.0.1",
      hub: { managementPublicOrigin: "https://hub.tailnet.ts.net", dataPublicOrigin: "https://hub.tailnet.ts.net:8443" },
    }), { live: { pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" } });
    expect(viaConfig.code).toBe(0);
    expect(viaConfig.out.join("\n")).toContain("ocx connect https://hub.tailnet.ts.net:8443 ");
  });

  test("no running hub, a malformed origin, and a refused mint each exit 1 with a reason", async () => {
    const down = await invite(["invite"], hubConfig(), { live: null });
    expect(down.code).toBe(1);
    expect(down.err.join(" ")).toContain("No running attested OpenCodex hub");

    const bad = await invite(["invite", "--data-url", "https://front.test/path"], hubConfig());
    expect(bad.code).toBe(1);
    expect(bad.err.join(" ")).toContain("--data-url must be a bare http(s) origin");

    const refused = await invite(["invite"], hubConfig(), {
      result: { kind: "unavailable", reason: "attestation" },
    });
    expect(refused.code).toBe(1);
    expect(refused.err.join(" ")).toContain("(attestation)");
  });

  test("an unknown subcommand prints usage rather than guessing invite", async () => {
    for (const args of [[], ["status"], ["invite-machine"]]) {
      const { code, err } = await invite(args, hubConfig());
      expect(code).toBe(1);
      expect(err.join(" ")).toContain("ocx hub invite");
    }
  });
});
