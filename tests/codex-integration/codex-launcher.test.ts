/**
 * `ocx codex [args...]` (src/cli/codex-launcher.ts): the `ocx claude`/`ocx opencode`
 * launcher pattern on Codex's config-owned wiring channel.
 *
 * Covers the decision surface a launch lives on: the shim-grammar fast path, the
 * routing-kind launch plan, the service-token env assembly for a routed exec, and the
 * detached-start environment. Each is pure; process semantics (stdio inherit, exit-code
 * propagation, ENOENT hints) are the shared spawn shape already exercised by
 * tests/claude-integration/claude-cli.test.ts and the opencode launcher tests.
 *
 * The fast-path grammar is pinned against the sets exported by
 * src/codex/shim-templates.ts, because the generated shell wrapper inlines the same
 * decision: both `codex` entry points must autostart (or fast-path) identically.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCodexLaunchEnv,
  CODEX_ROUTING_CUSTOM_LOCAL_NOTICE,
  CODEX_ROUTING_CUSTOM_REMOTE_NOTICE,
  CODEX_ROUTING_NATIVE_NOTICE,
  CODEX_ROUTING_UNKNOWN_NOTICE,
  codexFastPathReason,
  codexLaunchPlan,
  codexNotFoundHint,
  codexProxyStartEnv,
  ensureProxyForCodex,
  resolveCodexLaunchCommand,
} from "../../src/cli/codex-launcher";
import { CODEX_GLOBAL_OPTIONS_WITH_VALUE, CODEX_INTERNAL_COMMANDS } from "../../src/codex/shim-templates";
import { SIBLING_HANDOFF_NONCE_ENV, SIBLING_OF_PORT_ENV } from "../../src/codex/sibling-start";
import type { LiveProxy } from "../../src/server/proxy-liveness";

describe("codex launcher fast path", () => {
  test("help/version and internal subcommands skip the proxy ensure", () => {
    expect(codexFastPathReason(["--version"])).toBe("version");
    expect(codexFastPathReason(["-V"])).toBe("version");
    expect(codexFastPathReason(["--help"])).toBe("help");
    expect(codexFastPathReason(["-h"])).toBe("help");
    expect(codexFastPathReason(["login"])).toBe("internal");
    expect(codexFastPathReason(["doctor", "--json"])).toBe("internal");
  });

  test("global options with values are skipped before the first positional, matching the shim", () => {
    expect(codexFastPathReason(["-m", "opencode-go/x", "login"])).toBe("internal");
    expect(codexFastPathReason(["--model", "opencode-go/x", "doctor"])).toBe("internal");
    expect(codexFastPathReason(["--profile", "p", "--config", "k=v", "--help"])).toBe("help");
    expect(codexFastPathReason(["--config=k=v", "logout"])).toBe("internal");
    expect(codexFastPathReason(["-m", "x", "--version"])).toBe("version");
  });

  test("session-shaped argv autostarts", () => {
    expect(codexFastPathReason([])).toBeNull();
    expect(codexFastPathReason(["resume"])).toBeNull();
    expect(codexFastPathReason(["-m", "opencode-go/x"])).toBeNull();
    expect(codexFastPathReason(["--model=opencode-go/x"])).toBeNull();
    expect(codexFastPathReason(["--dangerously-bypass-approvals-and-sandbox"])).toBeNull();
    expect(codexFastPathReason(["--"])).toBeNull();
    expect(codexFastPathReason(["--", "doctor"])).toBeNull();
  });

  test("stays aligned with the generated shim's internal-command and option sets", () => {
    for (const command of ["login", "logout", "doctor", "mcp", "help", "update", "app-server"]) {
      expect(CODEX_INTERNAL_COMMANDS).toContain(command);
    }
    expect(CODEX_INTERNAL_COMMANDS).not.toContain("resume");
    for (const option of ["-m", "--model", "-c", "--config", "-p", "--profile"]) {
      expect(CODEX_GLOBAL_OPTIONS_WITH_VALUE).toContain(option);
    }
  });
});

describe("codex launcher plan", () => {
  test("opencodex-local routing ensures the proxy and execs", () => {
    expect(codexLaunchPlan("opencodex-local")).toEqual({ kind: "routed" });
  });

  test("native routing passes through untouched and says so", () => {
    const plan = codexLaunchPlan("native");
    expect(plan).toEqual({
      kind: "passthrough",
      ensureProxy: false,
      notice: CODEX_ROUTING_NATIVE_NOTICE,
    });
  });

  test("foreign gateways pass through untouched; that route is not ours to own", () => {
    expect(codexLaunchPlan("custom-local")).toEqual({
      kind: "passthrough",
      ensureProxy: false,
      notice: CODEX_ROUTING_CUSTOM_LOCAL_NOTICE,
    });
    expect(codexLaunchPlan("custom-remote")).toEqual({
      kind: "passthrough",
      ensureProxy: false,
      notice: CODEX_ROUTING_CUSTOM_REMOTE_NOTICE,
    });
  });

  test("unverifiable routing still attempts the proxy ensure", () => {
    expect(codexLaunchPlan("unknown")).toEqual({
      kind: "passthrough",
      ensureProxy: true,
      notice: CODEX_ROUTING_UNKNOWN_NOTICE,
    });
  });
});

describe("codex launch env assembly", () => {
  test("a missing admission token comes from the service token ladder", () => {
    const env = buildCodexLaunchEnv({ PATH: "/usr/bin" }, { serviceToken: () => "tok-from-file" });
    expect(env.OPENCODEX_API_AUTH_TOKEN).toBe("tok-from-file");
  });

  test("a user export always wins; the resolver is not even consulted", () => {
    let consulted = false;
    const env = buildCodexLaunchEnv(
      { OPENCODEX_API_AUTH_TOKEN: "user-token" },
      { serviceToken: () => { consulted = true; return "other"; } },
    );
    expect(env.OPENCODEX_API_AUTH_TOKEN).toBe("user-token");
    expect(consulted).toBe(false);
  });

  test("a blank inherited token counts as absent", () => {
    const env = buildCodexLaunchEnv(
      { OPENCODEX_API_AUTH_TOKEN: "   " },
      { serviceToken: () => "tok-from-file" },
    );
    expect(env.OPENCODEX_API_AUTH_TOKEN).toBe("tok-from-file");
  });

  test("an absent token resolves to nothing and stays absent", () => {
    const env = buildCodexLaunchEnv({ PATH: "/usr/bin" }, { serviceToken: () => null });
    expect(env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
  });
});

describe("codex detached-start env", () => {
  test("carries the service marker and defaults the hardened token file", () => {
    const env = codexProxyStartEnv({ PATH: "/usr/bin" });
    expect(env.OCX_SERVICE).toBe("1");
    expect(env.OCX_API_TOKEN_FILE!.endsWith("service-api-token")).toBe(true);
  });

  test("an inherited admission token avoids the token-file lookup", () => {
    const env = codexProxyStartEnv({ OPENCODEX_API_AUTH_TOKEN: "env-token" });
    expect(env.OCX_API_TOKEN_FILE).toBeUndefined();
    expect(env.OCX_SERVICE).toBe("1");
  });

  test("sibling markers never leak into a detached start child", () => {
    const env = codexProxyStartEnv({
      [SIBLING_HANDOFF_NONCE_ENV]: "n",
      [SIBLING_OF_PORT_ENV]: "10100",
      OCX_SERVICE: "0",
    });
    expect(env[SIBLING_HANDOFF_NONCE_ENV]).toBeUndefined();
    expect(env[SIBLING_OF_PORT_ENV]).toBeUndefined();
    expect(env.OCX_SERVICE).toBe("1");
  });
});

describe("codex launcher proxy ensure", () => {
  test("borrows the claude launcher's freshly-bound retry budget (#764)", async () => {
    const attempts: Array<number | undefined> = [];
    const live: LiveProxy = { pid: 4242, port: 10100, source: "runtime" };
    const result = await ensureProxyForCodex({
      findLiveProxy: async io => {
        attempts.push(io?.attempts);
        return live;
      },
    });
    expect(result).toEqual(live);
    expect(attempts).toEqual([3]);
  });
});

describe("codex launcher not-found hints", () => {
  test("cmd.exe's 9009 on win32 names the install path", () => {
    expect(codexNotFoundHint(9009, null, "win32")).toContain("npm install -g @openai/codex");
  });

  test("POSIX exits and any signal exit are not hints", () => {
    expect(codexNotFoundHint(127, null, "linux")).toBeNull();
    expect(codexNotFoundHint(1, "SIGINT", "win32")).toBeNull();
    expect(codexNotFoundHint(null, null, "linux")).toBeNull();
  });
});

describe("codex launcher shim handoff", () => {
  const env = { PATH: "/usr/bin" };
  const onPath = () => "/home/test/.local/bin/codex";

  test("a recorded autostart shim is skipped in favour of its backing Codex", () => {
    const launch = resolveCodexLaunchCommand(env, {
      findOnPath: onPath,
      inspectShim: () => ({ status: "matched", selectedRole: "wrapper", backingPath: "/opt/codex/bin/codex.real", backingKind: "backup" }),
    });
    expect(launch).toEqual({ command: "/opt/codex/bin/codex.real", env });
  });

  test("an unreadable shim state keeps `codex` but bypasses the shim's ensure", () => {
    const launch = resolveCodexLaunchCommand(env, {
      findOnPath: onPath,
      inspectShim: () => ({ status: "unknown", reason: "binding_unavailable" }),
    });
    expect(launch.command).toBe("codex");
    expect(launch.env.OCX_SHIM_BYPASS).toBe("1");
    expect(env).not.toHaveProperty("OCX_SHIM_BYPASS");
  });

  test("an untracked or backing codex launches unchanged", () => {
    expect(resolveCodexLaunchCommand(env, { findOnPath: onPath, inspectShim: () => ({ status: "not-tracked" }) }))
      .toEqual({ command: "codex", env });
    expect(resolveCodexLaunchCommand(env, {
      findOnPath: onPath,
      inspectShim: () => ({ status: "matched", selectedRole: "backing", backingPath: "/home/test/.local/bin/codex", backingKind: "real" }),
    })).toEqual({ command: "codex", env });
    expect(resolveCodexLaunchCommand(env, { findOnPath: () => null })).toEqual({ command: "codex", env });
  });
});
