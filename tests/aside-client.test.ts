import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientPathError,
  EXPORT_CLIENTS,
  LOOPBACK_API_KEY_PLACEHOLDER,
  OPENCODE_PROVIDER_ID,
  asideAccountDir,
  asideConfigPath,
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  type ExportContext,
  type PiGeneratedConfig,
} from "../src/clients/config-export";
import { INTEGRATION_CLIENTS, resolveIntegrationPaths, unresolvedPathHintFor } from "../src/integrations/registry";
import { readIntegrationState } from "../src/integrations/state";
import { createIntegrationStateStore } from "../src/integrations/store";
import { defaultIntegrationIO } from "../src/integrations/config-io";
import { applyIntegration } from "../src/integrations/writer";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const CONFIG = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

function context(): ExportContext {
  return {
    baseUrl: "http://127.0.0.1:10100/v1",
    config: CONFIG,
    models: [
      { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000, inputModalities: ["text", "image"] },
      { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000, reasoningEfforts: ["low", "medium", "high"] },
      { namespaced: "mystery/model", provider: "mystery", id: "model" },
    ],
  };
}

let home: string;

function writeManifest(body: string, accountRoot = true): void {
  const root = join(home, ".aside");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "accounts.json"), body);
  if (accountRoot) mkdirSync(join(root, "u", "0"), { recursive: true });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-aside-"));
});

afterEach(() => {
  removeTreeWithRetry(home);
});

describe("Aside client config", () => {
  /*
   * The shape below is not invented: it was read off a real
   * ~/.aside/u/0/models.json that a user had wired to opencodex BY HAND before
   * this client existed. Four provider keys, the openai-completions dialect,
   * the loopback placeholder, and per-model input/contextWindow/maxTokens with
   * a pi-style thinkingLevelMap.
   *
   * Deliberately NOT asserted as equality against the pi document: Aside reuses
   * buildPiClientConfig, so such a test would compare a function to itself and
   * prove nothing. Key ORDER also differs from the hand-written file, which is
   * fine because Aside parses this file rather than diffing it. What must hold
   * is the key SET and the field vocabulary.
   */
  test("matches the provider shape observed in a real Aside catalog", () => {
    const document = buildClientConfig("aside", context()) as PiGeneratedConfig;
    expect(Object.keys(document)).toEqual(["providers"]);
    expect(Object.keys(document.providers)).toEqual([OPENCODE_PROVIDER_ID]);

    const provider = document.providers[OPENCODE_PROVIDER_ID]!;
    expect(new Set(Object.keys(provider))).toEqual(new Set(["baseUrl", "apiKey", "api", "models"]));
    expect(provider.baseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe(LOOPBACK_API_KEY_PLACEHOLDER);

    const reasoning = provider.models.find(model => model.id === "openai/gpt-5.6-sol")!;
    expect(reasoning.reasoning).toBe(true);
    expect(Object.keys(reasoning.thinkingLevelMap!)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoning.thinkingLevelMap!.high).toBe("high");
    // A level the ladder does not declare stays hidden rather than being offered.
    expect(reasoning.thinkingLevelMap!.max).toBeNull();
    expect(reasoning.contextWindow).toBe(922_000);

    // No authoritative window means no context-derived fields at all.
    const unknown = provider.models.find(model => model.id === "mystery/model")!;
    expect(unknown.contextWindow).toBeUndefined();
    expect(unknown.maxTokens).toBeUndefined();
  });

  test("native JSON round-trips and never carries a credential", () => {
    const sentinel = ["sk", "live", "aside", "sentinel"].join("-");
    const withKey = { ...CONFIG, apiKeys: [{ key: sentinel }] } as OcxConfig;
    const built = buildClientConfigText("aside", { ...context(), config: withKey });
    expect(built.format).toBe("json");
    expect(JSON.parse(built.text)).toEqual(built.document as never);
    expect(built.text).not.toContain(sentinel);
    expect(built.text).toContain(LOOPBACK_API_KEY_PLACEHOLDER);
  });

  test("the contribution owns providers.opencodex under Aside's own id", () => {
    const contribution = buildClientContribution("aside", context());
    // Reusing Pi's builder must not leak Pi's id into the ownership record, or a
    // disable would attribute one client's block to another.
    expect(contribution.clientId).toBe("aside");
    expect(contribution.fragments.map(fragment => fragment.path)).toEqual([["providers", OPENCODE_PROVIDER_ID]]);
  });

  test("resolves the catalog of whichever account the manifest calls current", () => {
    writeManifest(JSON.stringify({ currentAccountId: 0 }));
    expect(asideConfigPath({}, home)).toBe(join(home, ".aside", "u", "0", "models.json"));

    const other = mkdtempSync(join(tmpdir(), "ocx-aside-alt-"));
    mkdirSync(join(other, ".aside"), { recursive: true });
    writeFileSync(join(other, ".aside", "accounts.json"), JSON.stringify({ currentAccountId: 1 }));
    expect(asideConfigPath({}, other)).toBe(join(other, ".aside", "u", "1", "models.json"));
    removeTreeWithRetry(other);
  });

  /*
   * The whole reason this resolver throws. A machine can hold several accounts,
   * so defaulting to 0 when the manifest cannot be read would name a real file
   * belonging to a DIFFERENT account, pass the installed-directory check, and
   * write into somebody else's catalog.
   */
  test("refuses to guess an account when the manifest cannot answer", () => {
    expect(() => asideConfigPath({}, home)).toThrow(ClientPathError);

    writeManifest("{ not json");
    expect(() => asideConfigPath({}, home)).toThrow(ClientPathError);

    writeManifest(JSON.stringify({ currentAccountId: "0" }));
    expect(() => asideConfigPath({}, home)).toThrow(ClientPathError);

    writeManifest(JSON.stringify({ currentAccountId: -1 }));
    expect(() => asideConfigPath({}, home)).toThrow(ClientPathError);

    writeManifest(JSON.stringify({ accounts: [{ id: 0 }] }));
    expect(() => asideConfigPath({}, home)).toThrow(ClientPathError);
  });

  /*
   * An operation needs BOTH paths, and both come from the account id in the
   * manifest. Resolving them independently means a switch landing between the
   * two calls lets an operation verify one account's install and then write a
   * different account's catalog.
   *
   * Caching cannot fix that: any cache keyed on the manifest re-reads exactly
   * when the manifest changes, which is the case that needs the consistency. So
   * the pair is resolved once, and this asserts the derived paths agree.
   */
  test("both paths come from one account read, so they cannot disagree", () => {
    writeManifest(JSON.stringify({ currentAccountId: 0 }));
    const paths = resolveIntegrationPaths("aside", {}, home);
    expect(paths.detectDir).toBe(join(home, ".aside", "u", "0"));
    expect(paths.configPath).toBe(join(paths.detectDir, "models.json"));

    // A real switch is observed on the next resolution, as a whole.
    writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({ currentAccountId: 1 }));
    const after = resolveIntegrationPaths("aside", {}, home);
    expect(after.detectDir).toBe(join(home, ".aside", "u", "1"));
    expect(after.configPath).toBe(join(after.detectDir, "models.json"));
  });

  test("clients whose paths are pure still resolve through the same seam", () => {
    const paths = resolveIntegrationPaths("prime", {}, "/home/u");
    expect(paths.configPath).toBe(join("/home/u", ".prime", "agent", "models.json"));
    expect(paths.detectDir).toBe(join("/home/u", ".prime", "agent"));
  });

  /*
   * The direct writer path, which is the one that stayed broken after the seam
   * landed. applyIntegration is public and callers may omit resolvedPaths, so
   * preflight used to resolve configPath while the installation check resolved
   * detectDir separately. An account switch landing between the two produced a
   * successful apply that verified one account and wrote the other's catalog.
   *
   * The IO seam is where the switch is injected, because that is the moment
   * between the two resolutions in the original ordering.
   */
  test("a direct apply checks the install of the very account it writes", () => {
    writeManifest(JSON.stringify({ currentAccountId: 0 }));
    const manifest = join(home, ".aside", "accounts.json");
    writeFileSync(join(home, ".aside", "u", "0", "models.json"), "{}\n");
    mkdirSync(join(home, ".aside", "u", "1"), { recursive: true });

    const store = createIntegrationStateStore(mkdtempSync(join(tmpdir(), "ocx-aside-store-")));
    const io = defaultIntegrationIO(store);
    const statted: string[] = [];
    const switching = {
      ...io,
      statKind: (path: string) => {
        statted.push(path);
        // Aside switches accounts exactly where the second resolution used to be.
        writeFileSync(manifest, JSON.stringify({ currentAccountId: 1 }));
        return io.statKind(path);
      },
    };

    const applied = applyIntegration({
      clientId: "aside", models: [], config: CONFIG, port: 10100,
      env: {}, home, store, io: switching,
    });
    expect(applied.ok).toBe(true);

    /*
     * The property that was violated: the account directory whose existence
     * authorized the write must be the account the write landed in. With the two
     * paths resolved separately, the install check statted u/1 while the catalog
     * was written to u/0 -- an apply authorized by an account it never touched.
     */
    const accountDirs = statted.filter(path => /[\\/]u[\\/]\d+$/.test(path));
    expect(accountDirs.length).toBeGreaterThan(0);
    const authorized = new Set(accountDirs);

    const owning = ([0, 1] as const).filter(account => {
      const catalog = join(home, ".aside", "u", String(account), "models.json");
      if (!existsSync(catalog)) return false;
      const parsed = JSON.parse(readFileSync(catalog, "utf8")) as { providers?: Record<string, unknown> };
      return parsed.providers?.opencodex !== undefined;
    });
    expect(owning).toHaveLength(1);
    expect(authorized.has(join(home, ".aside", "u", String(owning[0])))).toBe(true);
  });

  test("detects installation by the account directory, not the CLI directory", () => {
    // The CLI writes ~/.aside/cli for its own update check before any account
    // exists, so the outer directory is not an install signal.
    mkdirSync(join(home, ".aside", "cli"), { recursive: true });
    expect(() => INTEGRATION_CLIENTS.aside.detectDir({}, home)).toThrow(ClientPathError);

    writeManifest(JSON.stringify({ currentAccountId: 0 }));
    expect(INTEGRATION_CLIENTS.aside.detectDir({}, home)).toBe(join(home, ".aside", "u", "0"));
  });

  test("ships as a loopback-only integration with no env var to export", () => {
    const spec = EXPORT_CLIENTS.aside;
    // The observed provider block has four keys and none is `headers`, so the
    // dedicated admission header has nowhere to live on a remote bind.
    expect(spec.loopbackOnly).toBe(true);
    expect(spec.apiKeyEnv).toBe("");
    // Not a bare models.json: pi's and prime's downloads would collide with it.
    expect(spec.filename).toBe("aside-models.json");
  });

  /*
   * An unsigned-in Aside is not a broken Aside.
   *
   * Mutation must still refuse: there is no account to write. But the read-only
   * state surface used to answer that refusal with `state: "unsafe"` and
   * `configPath: ""`, which paints the red Cannot-verify badge and names no
   * file. Absent `accounts.json` is the ordinary state of an Aside installed and
   * never launched, so the read reports not-installed and names where the
   * catalog would go.
   */
  test("a never-signed-in Aside reads as not installed, not as unverifiable", () => {
    mkdirSync(join(home, ".aside", "cli"), { recursive: true });

    // Mutation still refuses, because there is no account directory to write.
    expect(() => resolveIntegrationPaths("aside", {}, home)).toThrow(ClientPathError);

    // The read-only surface names the account root instead of nothing.
    const hint = unresolvedPathHintFor("aside", {}, home);
    expect(hint).toBe(join(home, ".aside", "u"));
    // Deliberately NOT a writable catalog path: no account, no models.json.
    expect(hint.endsWith("models.json")).toBe(false);

    const status = readIntegrationState({
      clientId: "aside",
      models: context().models,
      config: CONFIG,
      port: 10100,
      env: {},
      home,
    });
    expect(status.state).toBe("absent");
    expect(status.installed).toBe(false);
    expect(status.configPath).toBe(hint);
    expect(status.reason).toBe("unresolvable-path");
  });

  test("a client with no hint still reports unverifiable, because there is nothing to name", () => {
    // OpenClaw's relative-selector refusal is a misconfiguration, not a
    // not-yet-signed-in state, so the danger badge stays correct for it.
    expect(unresolvedPathHintFor("openclaw", {}, home)).toBe("");
    const status = readIntegrationState({
      clientId: "openclaw",
      models: context().models,
      config: CONFIG,
      port: 10100,
      env: { OPENCLAW_CONFIG_PATH: "relative/config.json" },
      home,
    });
    expect(status.state).toBe("unsafe");
    expect(status.configPath).toBe("");
    expect(status.reason).toBe("unresolvable-path");
  });

  /*
   * The hint lookup absorbs a path REFUSAL and nothing else.
   *
   * An unqualified catch there would read the same for a resolver that threw a
   * TypeError from a typo or an EACCES from a filesystem probe: the badge would
   * quietly say not-installed while the real cause went unreported. This drives
   * a non-ClientPathError through the same seam and requires it to escape.
   */
  test("a hint resolver that throws a programming error is not silently degraded", () => {
    const spec = INTEGRATION_CLIENTS.aside as { unresolvedPathHint?: (env?: NodeJS.ProcessEnv, home?: string) => string };
    const original = spec.unresolvedPathHint;
    try {
      spec.unresolvedPathHint = () => { throw new TypeError("join received undefined"); };
      expect(() => unresolvedPathHintFor("aside", {}, home)).toThrow(TypeError);

      // A path refusal is still absorbed, which is the whole point of the seam.
      spec.unresolvedPathHint = () => { throw new ClientPathError("no account yet"); };
      expect(unresolvedPathHintFor("aside", {}, home)).toBe("");
    } finally {
      spec.unresolvedPathHint = original;
    }
  });
});
