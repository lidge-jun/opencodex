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
  buildCodexLaunchEnv as buildEnv,
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
import { maybeAutoRestoreCodexShim } from "../../src/cli/codex-shim-autorestore";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";

// These env-assembly tests supply destination authority explicitly; real config authority
// (including the positive managed block) is covered in codex-launcher-security.test.ts.
const buildCodexLaunchEnv: typeof buildEnv = (base, deps) => buildEnv({ CODEX_HOME: repoRoot(), ...base }, {
  credentialDestination: () => true, ...deps,
});

function withTokenFiles(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "ocx-codex-launch-token-"));
  const prior = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try { run(home); }
  finally {
    if (prior === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prior;
    removeTreeWithRetry(home);
  }
}

test("codex launch defers shim handling to its routing plan without root repair", () => {
  for (const args of [["codex", "--version"], ["codex", "login"], ["codex", "resume"]]) {
    let restored = false;
    maybeAutoRestoreCodexShim("codex", args, {
      env: {},
      warn: () => {},
      readConfig: () => { throw new Error("launcher preflight must not read config"); },
      restore: () => { restored = true; return { status: "disabled" }; },
    });
    expect(restored).toBe(false);
  }
});

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
  test("forwarded config and profile overrides never authorize a newly loaded token", () => {
    for (const args of [
      ["-c", 'model_providers.opencodex.base_url="https://foreign.example/v1"', "hello"],
      ['-cmodel_provider="foreign"', "hello"], ["--config", 'model_provider="foreign"'],
      ['--config=model_provider="foreign"'], ["-p", "foreign"], ["-pforeign"],
      ["--profile", "foreign"], ["--profile=foreign"],
    ]) {
      let consulted = false;
      expect(buildCodexLaunchEnv({}, {
        routingKind: "opencodex-local", args,
        serviceToken: () => { consulted = true; return "ocx_fixture_service_token"; },
      })).toEqual({ CODEX_HOME: repoRoot() });
      expect(consulted).toBe(false);
      const inherited = { CODEX_HOME: repoRoot(), OPENCODEX_API_AUTH_TOKEN: "ocx_fixture_user_export" };
      expect(buildCodexLaunchEnv(inherited, { routingKind: "opencodex-local", args })).toEqual(inherited);
    }
  });

  test("an inherited token-file override cannot select the admin credential", () => {
    withTokenFiles(home => {
      const admin = `ocx_admin_${"a".repeat(43)}`;
      writeFileSync(join(home, "admin-api-token"), admin);
      writeFileSync(join(home, "service-api-token"), "ocx_fixture_service_token");
      const env = buildCodexLaunchEnv({ OCX_API_TOKEN_FILE: join(home, "admin-api-token") });
      expect(env.OPENCODEX_API_AUTH_TOKEN).toBe("ocx_fixture_service_token");
    });
  });

  test("a service file containing a management credential is never injected", () => {
    withTokenFiles(home => {
      for (const admin of [`ocx_admin_${"a".repeat(43)}`, "ocx_fixture_custom_admin"]) {
        writeFileSync(join(home, "service-api-token"), admin);
        const env = buildCodexLaunchEnv({ OPENCODEX_ADMIN_AUTH_TOKEN: admin });
        expect(env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      }
    });
  });

  test("unknown and foreign routing never read or inject the service token", () => {
    for (const routingKind of ["unknown", "custom-local", "custom-remote", "native"] as const) {
      let consulted = false;
      const base = { CODEX_HOME: repoRoot(), PATH: "/usr/bin" };
      const env = buildCodexLaunchEnv(base, {
        routingKind,
        serviceToken: () => { consulted = true; return "ocx_fixture_service_token"; },
      });
      expect(env).toEqual(base);
      expect(consulted).toBe(false);
    }
  });

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

  test("an unknown shim state uses the verified selected path with bypass", () => {
    const launch = resolveCodexLaunchCommand(env, {
      findOnPath: onPath,
      inspectShim: () => ({ status: "unknown", reason: "binding_unavailable" }),
      verifyBypass: () => true,
    });
    expect(launch.command).toBe(onPath());
    expect(launch.env.OCX_SHIM_BYPASS).toBe("1");
    expect(env).not.toHaveProperty("OCX_SHIM_BYPASS");
  });

  test("a PATH lookup error fails closed before any child handoff", () => {
    let inspected = false;
    expect(() => resolveCodexLaunchCommand(env, {
      findOnPath: () => { throw new Error("PATH lookup unavailable"); },
      inspectShim: () => { inspected = true; return { status: "not-tracked" }; },
    })).toThrow("cannot verify Codex shim bypass");
    expect(inspected).toBe(false);
    expect(env).not.toHaveProperty("OCX_SHIM_BYPASS");
  });

  test("a throwing shim inspector requires a verified bypass", () => {
    let verified = false;
    const launch = resolveCodexLaunchCommand(env, {
      findOnPath: onPath,
      inspectShim: () => { throw new Error("fixture inspection failure"); },
      verifyBypass: (selected, inherited) => {
        expect(selected).toBe(onPath()); expect(inherited).toBe(env);
        verified = true; return true;
      },
    });
    expect(verified).toBe(true);
    expect(launch).toEqual({ command: onPath(), env: { ...env, OCX_SHIM_BYPASS: "1" } });
    expect(env).not.toHaveProperty("OCX_SHIM_BYPASS");
  });

  test("an unverifiable bypass after a shim filesystem error fails closed without changing the input environment", () => {
    const base = { ...env, OPENCODEX_API_AUTH_TOKEN: "ocx_fixture_inherited_token", OCX_SHIM_BYPASS: "" };
    let verified = false;
    expect(() => resolveCodexLaunchCommand(base, {
      findOnPath: onPath,
      inspectShim: () => { throw Object.assign(new Error("shim state read failed"), { code: "EIO" }); },
      verifyBypass: () => { verified = true; return false; },
    })).toThrow("cannot verify Codex shim bypass");
    expect(verified).toBe(true);
    expect(base.OCX_SHIM_BYPASS).toBe("");
  });

  test("an untracked or backing codex launches unchanged", () => {
    expect(resolveCodexLaunchCommand(env, { findOnPath: onPath, inspectShim: () => ({ status: "not-tracked" }) }))
      .toEqual({ command: onPath(), env });
    expect(resolveCodexLaunchCommand(env, {
      findOnPath: onPath,
      inspectShim: () => ({ status: "matched", selectedRole: "backing", backingPath: "/home/test/.local/bin/codex", backingKind: "real" }),
    })).toEqual({ command: onPath(), env });
    expect(() => resolveCodexLaunchCommand(env, { findOnPath: () => null })).toThrow("npm install -g @openai/codex");
  });
});
