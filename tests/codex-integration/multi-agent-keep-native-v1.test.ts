import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMultiAgentMode,
  catalogEntryIsNativeChatGpt,
  type RawEntry,
} from "../../src/codex/catalog/parsing";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "../../src/codex/catalog/kinds";
import { buildCatalogEntriesFromObservedState } from "../../src/codex/catalog/sync";
import { cmdV2 } from "../../src/cli/v2";
import { loadConfig, saveConfig } from "../../src/config";
import { isMultiAgentV2Enabled } from "../../src/codex/features";
import { handleManagementAPI } from "../../src/server/management-api";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import type { OcxConfig } from "../../src/types";

describe("keepNativeChatGptOnV1", () => {
  test("v2 without the switch stamps every row v2", () => {
    const entries: RawEntry[] = [
      { slug: "gpt-5.6-sol" },
      { slug: "xai/grok-4.6" },
    ];
    applyMultiAgentMode(entries, "v2");
    expect(entries[0]!.multi_agent_version).toBe("v2");
    expect(entries[1]!.multi_agent_version).toBe("v2");
  });

  test("v2 + keepNativeChatGptOnV1 leaves ChatGPT-native on v1 and routed on v2", () => {
    const entries: RawEntry[] = [
      { slug: "gpt-5.6-sol" },
      { slug: "gpt-5.6-terra" },
      { slug: "xai/grok-4.6" },
      { slug: "anthropic/claude-fable-5" },
      { slug: "combo/grok_4.6_fast_cursor_xai_fallback" },
    ];
    applyMultiAgentMode(entries, "v2", false, { keepNativeChatGptOnV1: true });
    expect(entries.find(e => e.slug === "gpt-5.6-sol")!.multi_agent_version).toBe("v1");
    expect(entries.find(e => e.slug === "gpt-5.6-terra")!.multi_agent_version).toBe("v1");
    expect(entries.find(e => e.slug === "xai/grok-4.6")!.multi_agent_version).toBe("v2");
    expect(entries.find(e => e.slug === "anthropic/claude-fable-5")!.multi_agent_version).toBe("v2");
    expect(entries.find(e => e.slug === "combo/grok_4.6_fast_cursor_xai_fallback")!.multi_agent_version).toBe("v2");
  });

  test("the switch does nothing in v1 or default mode", () => {
    const v1: RawEntry[] = [{ slug: "xai/grok-4.6" }];
    applyMultiAgentMode(v1, "v1", false, { keepNativeChatGptOnV1: true });
    expect(v1[0]!.multi_agent_version).toBe("v1");

    const base: RawEntry[] = [{ slug: "xai/grok-4.6", multi_agent_version: "v1" }];
    applyMultiAgentMode(base, "default", false, { keepNativeChatGptOnV1: true });
    expect(base[0]!.multi_agent_version).toBeUndefined();
  });

  test("native alias rows count as native; routed providers do not", () => {
    const routedAlias: RawEntry = { slug: "sol", opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND };
    expect(catalogEntryIsNativeChatGpt(routedAlias)).toBe(false);
    expect(catalogEntryIsNativeChatGpt({
      slug: "sol",
      opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND,
      use_responses_lite: true,
    })).toBe(true);
    expect(catalogEntryIsNativeChatGpt({ slug: "xai/grok-4.6" })).toBe(false);
    expect(catalogEntryIsNativeChatGpt({ slug: "gpt-5.6-sol" })).toBe(true);

    const stamped: RawEntry[] = [
      { slug: "sol", opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND },
      { slug: "gpt-5.6-sol" },
    ];
    applyMultiAgentMode(stamped, "v2", false, { keepNativeChatGptOnV1: true });
    expect(stamped[0]!.multi_agent_version).toBe("v2");
    expect(stamped[1]!.multi_agent_version).toBe("v1");
  });
});

const savedOcxHome = process.env.OPENCODEX_HOME;
const savedCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (savedOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedOcxHome;
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

function isolateHomes(): void {
  process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-keep-native-"));
  process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-keep-native-"));
}

/**
 * The semantic `features <action> <feature>` triple, parsed from the two argv
 * shapes `commandInvocation` produces (src/lib/win-exec.ts:85-95):
 *
 *   POSIX / .exe : ["features", "<action>", "<feature>"]
 *   win32 .cmd   : ["/d", "/s", "/c", '"<target> ^"features^" ^"<action>^" ^"<feature>^""']
 *
 * A Windows npm install exposes `codex` as a `.cmd` shim, and a shell-less
 * `.cmd` spawn is rejected by post-CVE Node/Bun, so the launcher must wrap it —
 * which means `args[1]` is `/s`, not the action. Reading the index directly made
 * these tests assert the OS launcher's argument grammar instead of the state
 * transition they exist to check.
 *
 * SCOPE: this extracts the SEMANTIC ARGUMENTS. It deliberately does not check
 * WHICH executable is being launched — it never sees `file`, and it accepts any
 * `.cmd`/`.bat` target, so `evil.cmd` parses as readily as `codex.cmd`.
 * Executable identity belongs to the launcher contract, which is pinned
 * independently by `tests/codex-v2-gate.test.ts` (`codexFeaturesInvocation`
 * resolving `codex` on POSIX, `.cmd` and `.exe` on win32) and
 * `tests/win-exec.test.ts` (PATH×PATHEXT resolution and escaping). Duplicating
 * that here would couple these state tests to resolution behaviour again, which
 * is the defect this helper exists to remove.
 *
 * Within that scope it THROWS rather than falling back, so a malformed argv or
 * an unrecognized shape fails the test instead of silently matching.
 */
function featureActionOf(args: readonly string[]): string {
  const ACTION = /^(?:enable|disable)$/;
  const FEATURE = /^[a-z0-9_]+$/;

  if (args.length === 3 && args[0] === "features") {
    const [, action, feature] = args;
    if (!ACTION.test(action!) || !FEATURE.test(feature!)) {
      throw new Error(`malformed features argv: ${JSON.stringify(args)}`);
    }
    return `features ${action} ${feature}`;
  }

  if (args.length === 4 && args[0] === "/d" && args[1] === "/s" && args[2] === "/c") {
    const line = args[3]!;
    if (!line.startsWith('"') || !line.endsWith('"')) {
      throw new Error(`unquoted cmd line: ${line}`);
    }
    // Split on unescaped spaces only: escapeCmdCommand rewrites a space inside the
    // target path as "^ ", so "C:\Program Files\..." stays one token. Then strip the
    // argument quoting, which is ^" normally and ^^^" for a node_modules/.bin shim
    // (IS_CMD_SHIM double-escapes, src/lib/win-exec.ts:17,89).
    const inner = line.slice(1, -1);
    const tokens = inner.split(/(?<!\^) /).map(t => t.replace(/\^+"/g, "").replace(/\^ /g, " "));
    const [target, keyword, action, feature, ...rest] = tokens;
    if (
      rest.length > 0
      || !/\.(cmd|bat)$/i.test(target ?? "")
      || keyword !== "features"
      || !ACTION.test(action ?? "")
      || !FEATURE.test(feature ?? "")
    ) {
      throw new Error(`unrecognized cmd invocation: ${inner}`);
    }
    return `features ${action} ${feature}`;
  }

  throw new Error(`unrecognized features invocation: ${JSON.stringify(args)}`);
}

function captureLog(): { logs: string[]; errors: string[]; log: { log: (m?: unknown) => void; error: (m?: unknown) => void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: {
      log: (m?: unknown) => { logs.push(String(m)); },
      error: (m?: unknown) => { errors.push(String(m)); },
    },
  };
}

function getV2(): Request {
  return new Request("http://localhost/api/v2", { headers: { Host: "localhost" } });
}

function putV2(body: unknown): Request {
  return new Request("http://localhost/api/v2", {
    method: "PUT",
    headers: { "content-type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

describe("keep-native-v1 restamp path", () => {
  test("observed catalog rebuild applies the v2-only native/routed split", () => {
    const template = {
      slug: "gpt-5.6-sol",
      display_name: "gpt-5.6-sol",
      description: "Native GPT model",
      priority: 1,
      visibility: "list",
      tool_mode: "code",
    };
    const goModels = [
      { id: "grok-4.6", provider: "xai", owned_by: "xai" },
    ] as never;
    const v2 = buildCatalogEntriesFromObservedState({
      template: template as never,
      gptSlugs: ["gpt-5.6-sol"],
      goModels,
      featured: [],
      wsEnabled: false,
      multiAgentMode: "v2",
      exactComboSlugs: new Set(),
      accountSelectors: [],
      suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(),
      multiAgentV2Enabled: true,
      keepNativeChatGptOnV1: true,
    });
    expect(v2.find(e => e.slug === "gpt-5.6-sol")!.multi_agent_version).toBe("v1");
    expect(v2.find(e => e.slug === "xai/grok-4.6")!.multi_agent_version).toBe("v2");

    const v1 = buildCatalogEntriesFromObservedState({
      template: template as never,
      gptSlugs: ["gpt-5.6-sol"],
      goModels,
      featured: [],
      wsEnabled: false,
      multiAgentMode: "v1",
      exactComboSlugs: new Set(),
      accountSelectors: [],
      suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(),
      multiAgentV2Enabled: false,
      keepNativeChatGptOnV1: true,
    });
    expect(v1.find(e => e.slug === "gpt-5.6-sol")!.multi_agent_version).toBe("v1");
    expect(v1.find(e => e.slug === "xai/grok-4.6")!.multi_agent_version).toBe("v1");
  });
});

describe("ocx v2 keep-native-v1", () => {
  test("featureActionOf parses both launcher shapes and rejects malformed argv", () => {
    // The exact strings commandInvocation emits, captured from a real run against
    // three target shapes: plain path, a path containing a space, and a
    // node_modules/.bin shim (double-escaped).
    expect(featureActionOf(["features", "disable", "multi_agent_v2"]))
      .toBe("features disable multi_agent_v2");
    expect(featureActionOf(["/d", "/s", "/c",
      String.raw`"C:\npm\codex.cmd ^"features^" ^"disable^" ^"multi_agent_v2^""`]))
      .toBe("features disable multi_agent_v2");
    expect(featureActionOf(["/d", "/s", "/c",
      String.raw`"C:\Program^ Files\npm\codex.cmd ^"features^" ^"disable^" ^"multi_agent_v2^""`]))
      .toBe("features disable multi_agent_v2");
    expect(featureActionOf(["/d", "/s", "/c",
      String.raw`"C:\p\node_modules\.bin\codex.cmd ^^^"features^^^" ^^^"enable^^^" ^^^"multi_agent_v2^^^""`]))
      .toBe("features enable multi_agent_v2");

    // A non-batch target must not match merely because the phrase is present.
    // (A .cmd target that is not codex DOES parse — see the helper's SCOPE note:
    //  executable identity is the launcher contract's job, not this helper's.)
    expect(() => featureActionOf(["/d", "/s", "/c",
      String.raw`"echo ^"features^" ^"disable^" ^"multi_agent_v2^""`])).toThrow();
    expect(() => featureActionOf(["features", "disable"])).toThrow();
    expect(() => featureActionOf(["features", "restart", "multi_agent_v2"])).toThrow();
    expect(() => featureActionOf(["/d", "/s", "/c", "features disable multi_agent_v2"])).toThrow();
    expect(() => featureActionOf(["-c", "features disable multi_agent_v2"])).toThrow();
  });

  test("enabling the native-v1 pin disables the global V2 override before catalog sync", async () => {
    isolateHomes();
    saveConfig({ ...loadConfig(), multiAgentMode: "v2" });
    const codexConfig = join(process.env.CODEX_HOME!, "config.toml");
    writeFileSync(codexConfig, "[features.multi_agent_v2]\nenabled = true\n");
    const events: string[] = [];

    const code = await cmdV2(["keep-native-v1", "on"], {
      execFile: (_file, args) => {
        events.push(featureActionOf(args));
        writeFileSync(codexConfig, readFileSync(codexConfig, "utf8").replace("enabled = true", "enabled = false"));
      },
      sync: async () => { events.push("sync"); },
      log: captureLog().log,
    });

    expect(code).toBe(0);
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(false);
    expect(events).toEqual(["features disable multi_agent_v2", "sync"]);
  });

  test("an explicit global V2 enable is rejected while the hybrid native-v1 pin is active", async () => {
    isolateHomes();
    saveConfig({ ...loadConfig(), multiAgentMode: "v2", keepNativeChatGptOnV1: true });
    const codexConfig = join(process.env.CODEX_HOME!, "config.toml");
    writeFileSync(codexConfig, "[features.multi_agent_v2]\nenabled = false\n");
    const { errors, log } = captureLog();
    let toggles = 0;

    expect(await cmdV2(["on"], {
      execFile: () => { toggles++; },
      sync: async () => { throw new Error("must not sync"); },
      log,
    })).toBe(1);
    expect(toggles).toBe(0);
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(false);
    expect(errors.join("\n")).toContain("global multi_agent_v2 overrides the native v1 catalog pin");
  });

  test("mode v2 honors a pre-existing native-v1 pin instead of enabling the global override", async () => {
    isolateHomes();
    saveConfig({ ...loadConfig(), keepNativeChatGptOnV1: true });
    const codexConfig = join(process.env.CODEX_HOME!, "config.toml");
    writeFileSync(codexConfig, "[features.multi_agent_v2]\nenabled = true\n");
    const actions: string[] = [];

    expect(await cmdV2(["mode", "v2"], {
      execFile: (_file, args) => {
        actions.push(featureActionOf(args).split(" ")[1]!);
        writeFileSync(codexConfig, readFileSync(codexConfig, "utf8").replace("enabled = true", "enabled = false"));
      },
      sync: async () => {},
      log: captureLog().log,
    })).toBe(0);
    expect(loadConfig().multiAgentMode).toBe("v2");
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(false);
    expect(actions).toEqual(["disable"]);
  });

  test("on/off persist, always re-sync the catalog, and reject bad args", async () => {
    isolateHomes();
    const { logs, errors, log } = captureLog();
    let syncs = 0;
    const deps = { log, sync: async () => { syncs++; } };

    expect(await cmdV2(["keep-native-v1"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("expected on|off");
    expect(syncs).toBe(0);
    expect(loadConfig().keepNativeChatGptOnV1).toBeUndefined();

    expect(await cmdV2(["keep-native-v1", "maybe"], deps)).toBe(1);
    expect(syncs).toBe(0);

    expect(await cmdV2(["keep-native-v1", "on"], deps)).toBe(0);
    expect(loadConfig().keepNativeChatGptOnV1).toBe(true);
    expect(syncs).toBe(1);
    expect(logs.join("\n")).toContain("keep_native_chatgpt_on_v1: ON");

    expect(await cmdV2(["status"], deps)).toBe(0);
    expect(logs.join("\n")).toContain("keep_native_chatgpt_on_v1: ON — ChatGPT-native rows stay v1 when mode is v2");

    expect(await cmdV2(["keep-native-v1", "on"], deps)).toBe(0);
    expect(syncs).toBe(2);
    expect(logs.join("\n")).toContain("already ON — catalog re-synced");

    expect(await cmdV2(["keep-native-v1", "off"], deps)).toBe(0);
    expect(loadConfig().keepNativeChatGptOnV1).toBeUndefined();
    expect(syncs).toBe(3);
    expect(logs.join("\n")).toContain("keep_native_chatgpt_on_v1: OFF");
  });

  test("a failed catalog resync still returns 1 after persisting the flag", async () => {
    isolateHomes();
    const { errors, log } = captureLog();
    const code = await cmdV2(["keep-native-v1", "on"], {
      log,
      sync: async () => { throw new Error("boom"); },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("catalog resync failed");
    expect(loadConfig().keepNativeChatGptOnV1).toBe(true);
  });
});

describe("/api/v2 keepNativeChatGptOnV1", () => {
  test("GET/PUT persist the flag, warn by mode, and restamp via catalog convergence", async () => {
    isolateHomes();
    const codexConfig = join(process.env.CODEX_HOME!, "config.toml");
    writeFileSync(codexConfig, "[features.multi_agent_v2]\nenabled = false\n");
    const config: OcxConfig = { providers: {}, hostname: "127.0.0.1", port: 10100, defaultProvider: "openai" } as OcxConfig;
    const seen: Array<{ keepNativeChatGptOnV1?: boolean; multiAgentMode?: string }> = [];
    let converges = 0;
    const factory = catalogConvergenceFactory(() => {
      converges++;
      seen.push({
        keepNativeChatGptOnV1: config.keepNativeChatGptOnV1,
        multiAgentMode: config.multiAgentMode,
      });
    });
    const deps = {
      createManagementConvergeCodex: factory,
      toggleCodexMultiAgentV2: (enabled: boolean) => {
        writeFileSync(codexConfig, readFileSync(codexConfig, "utf8").replace(/enabled = (?:true|false)/, `enabled = ${enabled}`));
      },
    };

    const get0 = await handleManagementAPI(getV2(), new URL("http://localhost/api/v2"), config, deps);
    expect(await get0?.json()).toMatchObject({ keepNativeChatGptOnV1: false, multiAgentMode: "default" });

    const inactive = await handleManagementAPI(
      putV2({ keepNativeChatGptOnV1: true }),
      new URL("http://localhost/api/v2"),
      config,
      deps,
    );
    expect(inactive?.status).toBe(200);
    const inactiveBody = await inactive?.json() as { keepNativeChatGptOnV1: boolean; warnings: string[]; catalogRefresh: { status: string } };
    expect(inactiveBody.keepNativeChatGptOnV1).toBe(true);
    expect(inactiveBody.warnings).toContain(
      "keepNativeChatGptOnV1 is stored but inactive until multi-agent mode is v2. Applies to new sessions.",
    );
    expect(inactiveBody.catalogRefresh.status).toBe("committed");
    expect(converges).toBe(1);
    expect(seen[0]).toEqual({ keepNativeChatGptOnV1: true, multiAgentMode: undefined });
    expect(loadConfig().keepNativeChatGptOnV1).toBe(true);

    // Applicability is keyed off the effective mode, not a features.toml flip.
    config.multiAgentMode = "v2";
    writeFileSync(codexConfig, "[features.multi_agent_v2]\nenabled = true\n");
    const v2 = await handleManagementAPI(
      putV2({ keepNativeChatGptOnV1: true }),
      new URL("http://localhost/api/v2"),
      config,
      deps,
    );
    expect(v2?.status).toBe(200);
    const v2Body = await v2?.json() as { keepNativeChatGptOnV1: boolean; multiAgentMode: string; warnings: string[] };
    expect(v2Body).toMatchObject({ enabled: false, keepNativeChatGptOnV1: true, multiAgentMode: "v2" });
    expect(v2Body.warnings).toContain(
      "ChatGPT-native models stay on v1 while other models use v2. Applies to new sessions.",
    );
    expect(converges).toBe(2);
    expect(seen[1]).toEqual({ keepNativeChatGptOnV1: true, multiAgentMode: "v2" });

    const off = await handleManagementAPI(
      putV2({ keepNativeChatGptOnV1: false }),
      new URL("http://localhost/api/v2"),
      config,
      deps,
    );
    expect(await off?.json()).toMatchObject({ keepNativeChatGptOnV1: false });
    expect(converges).toBe(3);
    expect(loadConfig().keepNativeChatGptOnV1).toBeUndefined();

    const get1 = await handleManagementAPI(getV2(), new URL("http://localhost/api/v2"), config, deps);
    expect(await get1?.json()).toMatchObject({ keepNativeChatGptOnV1: false });

    const bad = await handleManagementAPI(
      putV2({ keepNativeChatGptOnV1: "yes" }),
      new URL("http://localhost/api/v2"),
      config,
      deps,
    );
    expect(bad?.status).toBe(400);
    expect(converges).toBe(3);
  });
});
