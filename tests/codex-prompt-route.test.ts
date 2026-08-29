/**
 * Route-level contract for /api/codex-prompt (devlog 020 + 021).
 *
 * Every case injects fixture paths through `ManagementApiDeps.codexPromptPaths`, so
 * no test may resolve the real CODEX_HOME. A decoy directory with sentinel files
 * rides along and is asserted byte-identical after every verb: proving the
 * fixture changed does not prove nothing else did.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { LAYER_INVENTORY, readPromptLayers } from "../src/codex/prompt-layers";
import {
  promptTextProbeSpawnAttemptsForTests,
  resetPromptTextProbeForTests,
  setPromptTextProbeCommandForTests,
} from "../src/codex/prompt-text-probe";
import type { ManagementPrincipal } from "../src/server/management-auth";
import type { OcxConfig } from "../src/types";

const MARKER = "# Auto-injected by opencodex";
const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
const roots: string[] = [];

interface Fixture {
  configPath: string;
  storePath: string;
  baseVariantDir: string;
  decoyConfig: string;
  decoyStore: string;
  decoyHome: string;
}

function fixture(configBytes?: string, storeBytes?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ocx-prompt-route-"));
  const decoy = mkdtempSync(join(tmpdir(), "ocx-prompt-decoy-"));
  roots.push(root, decoy);
  const configPath = join(root, "config.toml");
  const storePath = join(root, "opencodex-prompt.json");
  if (configBytes !== undefined) writeFileSync(configPath, configBytes, "utf8");
  if (storeBytes !== undefined) writeFileSync(storePath, storeBytes, "utf8");
  const decoyConfig = join(decoy, "config.toml");
  const decoyStore = join(decoy, "opencodex-prompt.json");
  writeFileSync(decoyConfig, "model = \"sentinel\"\n", "utf8");
  writeFileSync(decoyStore, "{\"layers\":[]}", "utf8");
  return {
    configPath,
    storePath,
    // Injected like the other two, so no route test can reach a developer's real
    // variant directory.
    baseVariantDir: join(root, "opencodex-prompt-base"),
    decoyConfig,
    decoyStore,
    decoyHome: decoy,
  };
}

function storeJson(layers: unknown[]): string {
  return JSON.stringify({ layers });
}

function ownedConfig(projection: string): string {
  return MARKER + "\ndeveloper_instructions = \"" + projection + "\"\n";
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

async function waitUntil(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await Bun.sleep(10);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sentinels must survive every verb. The decoy is installed as CODEX_HOME for the
 * duration of each request, so this is not a vacuous check: a regression that
 * dropped `codexPromptPaths` would fall back to CODEX_HOME and land here, on a
 * temp directory, instead of on the developer's real ~/.codex.
 */
function expectDecoyUntouched(fx: Fixture): void {
  expect(read(fx.decoyConfig)).toBe("model = \"sentinel\"\n");
  expect(read(fx.decoyStore)).toBe("{\"layers\":[]}");
}

async function call(
  method: string,
  pathname: string,
  fx: Fixture,
  body?: unknown,
  principal: ManagementPrincipal | undefined = "gui-session",
): Promise<{ status: number; body: any; routed: boolean }> {
  const url = new URL("http://127.0.0.1:10100" + pathname);
  const headers: Record<string, string> = { host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // The decoy is CODEX_HOME for the duration of the call. Without this the
  // sentinel assertion proves nothing: a route that ignored the injected paths
  // would write to the developer's real home and both sentinels would still
  // match. With it, that same regression lands on the decoy and is caught.
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = fx.decoyHome;
  let res: Response | null;
  try {
    res = await handleManagementAPI(req, url, config, {
      codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath, baseVariantDir: fx.baseVariantDir },
    }, principal);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
  if (!res) return { status: 404, body: null, routed: false };
  const raw = await res.text();
  const parsed: unknown = raw ? JSON.parse(raw) : null;
  expectDecoyUntouched(fx);
  return { status: res.status, body: parsed, routed: true };
}

async function revision(fx: Fixture): Promise<string> {
  const res = await call("GET", "/api/codex-prompt", fx);
  return res.body.revision as string;
}

afterEach(async () => {
  await resetPromptTextProbeForTests();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("GET /api/codex-prompt", () => {
  test("1. returns the snapshot with the full inventory", async () => {
    const fx = fixture("include_apps_instructions = false\n");
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.status).toBe(200);
    expect(res.body.inventory).toHaveLength(LAYER_INVENTORY.length);
    expect(res.body.inventory.map((d: any) => d.id)).toEqual(LAYER_INVENTORY.map(d => d.id));
    expect(res.body.configPath).toBe(fx.configPath);
    expect(res.body.extensionLayersEnumerable).toBe(false);
    const apps = res.body.toggles.find((t: any) => t.id === "apps");
    expect(apps.userFileValue).toBe(false);
  });

  test("2. a missing config is a first run, not an error", async () => {
    const fx = fixture();
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.status).toBe(200);
    expect(res.body.configExists).toBe(false);
    expect(res.body.readable).toBe(true);
    for (const t of res.body.toggles) expect(t.userFileValue).toBeNull();
  });

  test("17. every drift state is reported, and GET writes nothing", async () => {
    // owned-malformed: marker-adjacent but reshaped.
    const fx = fixture(MARKER + "\ndeveloper_instructions = 'single quoted'\n");
    const before = read(fx.configPath);
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.body.drift).toBe("owned-malformed");
    expect(read(fx.configPath)).toBe(before);
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("17b. store-missing is reported without repairing it", async () => {
    const fx = fixture(ownedConfig("Be brief."));
    const before = read(fx.configPath);
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.body.drift).toBe("store-missing");
    expect(read(fx.configPath)).toBe(before);
  });
});

describe("PUT /api/codex-prompt/toggle", () => {
  test("3. flips a value and echoes the new snapshot", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: rev });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(read(fx.configPath)).toContain("include_apps_instructions = false");
    const apps = res.body.snapshot.toggles.find((t: any) => t.id === "apps");
    expect(apps.userFileValue).toBe(false);
  });

  test("4. an unknown id is refused", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "no-such-layer", enabled: false, revision: rev });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unknown_layer");
  });

  test("5. every non-config-toggle inventory id is refused, and nothing is written", async () => {
    // Ask item 9 at the API boundary. Table-driven over LAYER_INVENTORY, so a new
    // upstream layer is covered the day WP1 lists it.
    const locked = LAYER_INVENTORY.filter(d => d.class !== "config-toggle");
    expect(locked.length).toBeGreaterThan(0);
    for (const descriptor of locked) {
      const fx = fixture("");
      const rev = await revision(fx);
      const before = read(fx.configPath);
      const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: descriptor.id, enabled: false, revision: rev });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("layer_not_toggleable");
      expect(res.body.layerClass).toBe(descriptor.class);
      expect(read(fx.configPath)).toBe(before);
    }
  });

  test("6. every inventory id has one class, and every config-toggle has a key", async () => {
    // The partition guard: without it the inventory can drift into a state where
    // a row is neither switchable nor explained.
    const ids = new Set<string>();
    for (const d of LAYER_INVENTORY) {
      expect(ids.has(d.id)).toBe(false);
      ids.add(d.id);
      expect(["base", "config-toggle", "feature-gated", "runtime-conditional", "extension-unknown"]).toContain(d.class);
      if (d.class === "config-toggle") expect(typeof d.key).toBe("string");
      if (d.class === "base" || d.class === "runtime-conditional") expect(d.key).toBeNull();
    }
  });

  test("23. plugins is runtime-conditional and cannot be toggled", async () => {
    // Named regression for devlog 021 §2: 020's example called this feature-gated.
    const plugins = LAYER_INVENTORY.find(d => d.id === "plugins")!;
    expect(plugins.class).toBe("runtime-conditional");
    expect(plugins.key).toBeNull();
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "plugins", enabled: false, revision: rev });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("layer_not_toggleable");
  });

  test("9a. a stale revision is refused", async () => {
    const fx = fixture("");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: "sha256:stale" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
  });

  test("10b. toggles still work when developer_instructions is unowned", async () => {
    const fx = fixture("developer_instructions = \"external\"\n");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: rev });
    expect(res.status).toBe(200);
    expect(read(fx.configPath)).toContain("developer_instructions = \"external\"");
  });
});

describe("PUT /api/codex-prompt/custom", () => {
  const good = { id: "abc123", title: "House rules", body: "Be brief.", enabled: true };

  test("7. round-trips order", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: rev,
      layers: [good, { id: "def456", title: "Second", body: "Then this.", enabled: true }],
    });
    expect(res.status).toBe(200);
    expect(res.body.snapshot.custom.map((l: any) => l.id)).toEqual(["abc123", "def456"]);
    expect(read(fx.configPath)).toContain("Be brief.\\n\\nThen this.");
  });

  test("8. each validation rule is enforced", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const cases: Array<[unknown, string]> = [
      ["not-an-array", "invalid_body"],
      [Array.from({ length: 33 }, (_, i) => ({ ...good, id: String(i).padStart(6, "a").slice(0, 6) })), "too_many_layers"],
      [[{ ...good, id: "BAD" }], "invalid_layer_id"],
      [[good, good], "duplicate_layer_id"],
      [[{ ...good, title: "" }], "invalid_title"],
      [[{ ...good, title: "x".repeat(81) }], "invalid_title"],
      [[{ ...good, title: "one\ntwo" }], "invalid_title"],
      [[{ ...good, body: "x".repeat(64 * 1024 + 1) }], "body_too_large"],
      [[{ ...good, enabled: "yes" }], "invalid_body"],
    ];
    for (const [layers, code] of cases) {
      const res = await call("PUT", "/api/codex-prompt/custom", fx, { revision: rev, layers });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    }
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("8b. a composed prompt over the cap is refused", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const body = "y".repeat(60 * 1024);
    const layers = ["aaaaaa", "bbbbbb", "cccccc"].map(id => ({ id, title: "big", body, enabled: true }));
    const res = await call("PUT", "/api/codex-prompt/custom", fx, { revision: rev, layers });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("composed_too_large");
  });

  test("19. a control character is rejected with its position", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: rev,
      layers: [{ ...good, body: "ok\u0007bad" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_characters");
    expect(res.body.position).toBe(2);
  });

  test("10. an unowned developer_instructions is refused", async () => {
    const fx = fixture("developer_instructions = \"hand written\"\n");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/custom", fx, { revision: rev, layers: [good] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("developer_instructions_not_owned");
    expect(read(fx.configPath)).toContain("hand written");
  });

  test("9b. a stale revision is refused on custom too", async () => {
    const fx = fixture("");
    const res = await call("PUT", "/api/codex-prompt/custom", fx, { revision: "sha256:stale", layers: [good] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
  });

  test("18. tabs and CRLF normalize rather than fail", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: rev,
      layers: [{ ...good, body: "a\tb\r\nc" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.snapshot.custom[0].body).toBe("a    b\nc");
  });
});

describe("POST /api/codex-prompt/adopt", () => {
  test("14. preview returns the raw line and writes nothing", async () => {
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    const before = read(fx.configPath);
    const res = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: false });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.preview.decodedBody).toBe("Answer in Korean.");
    expect(read(fx.configPath)).toBe(before);
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("15. adopt without confirm writes nothing", async () => {
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    await call("POST", "/api/codex-prompt/adopt", fx, {});
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("15b. a confirmed adopt imports the value as one layer", async () => {
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    const rev = await revision(fx);
    const res = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: true, revision: rev });
    expect(res.status).toBe(200);
    expect(res.body.snapshot.custom).toHaveLength(1);
    expect(res.body.snapshot.custom[0].body).toBe("Answer in Korean.");
    expect(res.body.snapshot.developerInstructionsOwned).toBe(true);
  });

  test("16. an unsupported form is refused with path and line", async () => {
    const fx = fixture("model = \"gpt-5\"\ndeveloper_instructions = '''multi\nline'''\n");
    const res = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: true, revision: await revision(fx) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("adopt_unsupported_form");
    expect(res.body.path).toBe(fx.configPath);
    expect(res.body.line).toBe(2);
  });
});

describe("POST /api/codex-prompt/repair", () => {
  test("18b. requires a matching revision", async () => {
    const fx = fixture(ownedConfig("Be brief."), storeJson([
      { id: "aaaaaa", title: "Old", body: "Something else.", enabled: true },
    ]));
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: "sha256:stale" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
  });

  test("20a. projection-stale re-projects from the store", async () => {
    const fx = fixture(ownedConfig("Be brief."), storeJson([
      { id: "aaaaaa", title: "Old", body: "Something else.", enabled: true },
    ]));
    const get = await call("GET", "/api/codex-prompt", fx);
    expect(get.body.drift).toBe("projection-stale");
    const preview = await call("POST", "/api/codex-prompt/repair", fx, { confirm: false });
    expect(preview.body.preview.projection).toBe("Something else.");
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: get.body.revision });
    expect(res.status).toBe(200);
    expect(res.body.snapshot.drift).toBeNull();
    expect(read(fx.configPath)).toContain("Something else.");
  });

  test("20b. store-missing previews a salvage naming its backup directory", async () => {
    const fx = fixture(ownedConfig("Be brief."));
    const preview = await call("POST", "/api/codex-prompt/repair", fx, { confirm: false });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.body).toBe("Be brief.");
    expect(preview.body.preview.unrecoverable.length).toBeGreaterThan(0);
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("20c. a stale salvage is refused before any backup file is created", async () => {
    // devlog 021 §8.1: salvageProjection writes its backup BEFORE the transaction
    // validates the revision, so the route pre-checks it.
    const fx = fixture(ownedConfig("Be brief."));
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: "sha256:stale" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
    const dirFiles = readdirSync(join(fx.storePath, "..")).filter(f => f.includes("salvage"));
    expect(dirFiles).toHaveLength(0);
  });

  test("21a. journal-present is refused as repair_unsupported", async () => {
    const fx = fixture(ownedConfig("Be brief."), storeJson([]));
    writeFileSync(fx.storePath.replace(/\.json$/, "") + ".journal", "{}", "utf8");
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: await revision(fx) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("repair_unsupported");
    expect(res.body.drift).toBe("journal-present");
  });

  test("21b. owned-malformed refuses mode replace and offers adopt", async () => {
    const fx = fixture(MARKER + "\ndeveloper_instructions = 'reshaped'\n");
    const replace = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, mode: "replace", revision: await revision(fx) });
    expect(replace.status).toBe(409);
    expect(replace.body.code).toBe("repair_unsupported");
    const adopt = await call("POST", "/api/codex-prompt/repair", fx, { confirm: false });
    expect(adopt.status).toBe(409);
    expect(adopt.body.code).toBe("adopt_unsupported_form");
  });

  test("repairing a clean file is refused", async () => {
    const fx = fixture("");
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: await revision(fx) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("nothing_to_repair");
  });
});

describe("dispatch and safety", () => {
  test("13. an unhandled path returns null so the chain continues", async () => {
    const fx = fixture("");
    const res = await call("GET", "/api/codex-prompt/nope", fx);
    expect(res.routed).toBe(false);
  });

  test("20. every mapped write error carries a client-facing status", async () => {
    // A TypeScript union does not exist at runtime, so exhaustiveness is a
    // typecheck property of Record<WriteError, number>. This asserts the values.
    const { WRITE_ERROR_STATUS_FOR_TESTS } = await import("../src/server/management/codex-prompt-routes");
    const statuses = Object.values(WRITE_ERROR_STATUS_FOR_TESTS);
    expect(statuses.length).toBeGreaterThanOrEqual(10);
    for (const status of statuses) expect(status).toBeGreaterThanOrEqual(400);
    // write_failed is the one 5xx: the filesystem refused a write that passed every
    // precondition, so the caller did nothing wrong and retrying it unchanged will
    // fail identically. Every OTHER error stays 4xx.
    for (const [error, status] of Object.entries(WRITE_ERROR_STATUS_FOR_TESTS)) {
      if (error === "write_failed") expect(status).toBe(500);
      else expect(status).toBeLessThan(500);
    }
  });

  test("22. the injected paths are honored on every verb", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: rev });
    const after = readPromptLayers({ configPath: fx.configPath, storePath: fx.storePath });
    expect(after.toggles.find(t => t.id === "apps")!.userFileValue).toBe(false);
    await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: after.revision,
      layers: [{ id: "abc123", title: "T", body: "B", enabled: true }],
    });
    expect(read(fx.storePath)).toContain("abc123");
    expectDecoyUntouched(fx);
  });

  test("12. no response serializes a token, key, or account identifier", async () => {
    const fx = fixture("include_apps_instructions = false\n");
    const res = await call("GET", "/api/codex-prompt", fx);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/sk-|Bearer |access_token|account_id|refresh_token/);
  });
});

describe("020 coverage completions", () => {
  test("11. an unreadable config refuses every mutation by name", async () => {
    // chmod 000 is not honored for root, and Windows ignores the mode entirely.
    // A directory in place of the file is unreadable on every platform we ship.
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-unreadable-"));
    const decoy = mkdtempSync(join(tmpdir(), "ocx-prompt-decoy-"));
    roots.push(root, decoy);
    const configPath = join(root, "config.toml");
    mkdirSync(configPath);
    const fx: Fixture = {
      configPath,
      storePath: join(root, "opencodex-prompt.json"),
      decoyConfig: join(decoy, "config.toml"),
      decoyStore: join(decoy, "opencodex-prompt.json"),
      decoyHome: decoy,
    };
    writeFileSync(fx.decoyConfig, "model = \"sentinel\"\n", "utf8");
    writeFileSync(fx.decoyStore, "{\"layers\":[]}", "utf8");

    const get = await call("GET", "/api/codex-prompt", fx);
    expect(get.body.readable).toBe(false);

    const toggle = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: false, revision: get.body.revision,
    });
    expect(toggle.status).toBe(409);
    expect(toggle.body.code).toBe("config_unreadable");

    const custom = await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: get.body.revision,
      layers: [{ id: "abc123", title: "T", body: "B", enabled: true }],
    });
    expect(custom.status).toBe(409);
    expect(custom.body.code).toBe("config_unreadable");

    const adopt = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: true, revision: get.body.revision });
    expect(adopt.status).toBe(409);
    expect(adopt.body.code).toBe("config_unreadable");

    const repair = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: get.body.revision });
    expect(repair.status).toBe(409);
    expect(repair.body.code).toBe("config_unreadable");
  });

  test("12b. a hostile Origin is rejected before the route runs", async () => {
    const fx = fixture("");
    // The revision must be VALID. With a stale one this test passes even when
    // origin enforcement is gone: the route runs, returns 409 stale_revision, and
    // a >= 400 assertion is satisfied by the wrong rejection entirely.
    const rev = await revision(fx);
    const url = new URL("http://127.0.0.1:10100/api/codex-prompt/toggle");
    const req = new Request(url, {
      method: "PUT",
      headers: {
        host: "127.0.0.1:10100",
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "apps", enabled: false, revision: rev }),
    });
    const res = await handleManagementAPI(req, url, config, {
      codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath, baseVariantDir: fx.baseVariantDir },
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    // The toggle would otherwise have succeeded: this exact request with no
    // Origin header writes the key. That is what makes the rejection meaningful.
    expect(read(fx.configPath)).toBe("");
    const allowed = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: rev });
    expect(allowed.status).toBe(200);
  });

  test("9c. adopt refuses a stale revision", async () => {
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    const res = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: true, revision: "sha256:stale" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("17c. journal-present is reported by GET, which writes nothing", async () => {
    const fx = fixture(ownedConfig("Be brief."), storeJson([]));
    const journal = fx.storePath.replace(/\.json$/, "") + ".journal";
    writeFileSync(journal, "{}", "utf8");
    const before = read(fx.configPath);
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.body.drift).toBe("journal-present");
    expect(read(fx.configPath)).toBe(before);
    expect(read(journal)).toBe("{}");
  });

  test("20d. each write error keeps its exact status, not merely a 4xx", async () => {
    // A range assertion would still pass if unknown_layer silently became a 409.
    const { WRITE_ERROR_STATUS_FOR_TESTS } = await import("../src/server/management/codex-prompt-routes");
    expect(WRITE_ERROR_STATUS_FOR_TESTS).toEqual({
      config_unreadable: 409,
      stale_revision: 409,
      developer_instructions_not_owned: 409,
      unknown_layer: 400,
      store_unreadable: 409,
      invalid_characters: 400,
      write_superseded: 409,
      write_failed: 500,
      recovery_required: 409,
      locked: 409,
    });
  });

  test("malformed JSON is a 400, never an empty object", async () => {
    // Swallowing a parse error into {} made an invalid adopt return a successful
    // PREVIEW and an invalid custom return stale_revision.
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    for (const path of ["/api/codex-prompt/toggle", "/api/codex-prompt/custom"]) {
      const url = new URL("http://127.0.0.1:10100" + path);
      const req = new Request(url, {
        method: "PUT",
        headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
        body: "{not json",
      });
      const res = await handleManagementAPI(req, url, config, {
        codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath, baseVariantDir: fx.baseVariantDir },
      }, "gui-session");
      expect(res!.status).toBe(400);
    }
    const url = new URL("http://127.0.0.1:10100/api/codex-prompt/adopt");
    const req = new Request(url, {
      method: "POST",
      headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handleManagementAPI(req, url, config, {
      codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath, baseVariantDir: fx.baseVariantDir },
    }, "gui-session");
    expect(res!.status).toBe(400);
  });

  test("the base-variant routes refuse what only the server can refuse", async () => {
    // Each of these is a rule the GUI also enforces, which is exactly why the route has
    // to enforce it independently: a route that trusts its client is not a boundary.
    const fx = fixture("model = \"x\"\n");
    const before = read(fx.configPath);
    const rev0 = await revision(fx);

    // `external` is a state the API REPORTS; asking for it would mean writing a path we
    // do not own.
    const external = await call("PUT", "/api/codex-prompt/base/select", fx, { kind: "external", revision: rev0 });
    expect(external.status).toBe(400);
    expect(external.body.code).toBe("invalid_body");

    // The default has no stored body, so neither verb has a target.
    const editDefault = await call("PUT", "/api/codex-prompt/base", fx, {
      id: "default", title: "x", body: "y", revision: rev0,
    });
    expect(editDefault.status).toBe(400);
    expect(editDefault.body.code).toBe("unknown_layer");

    // An unknown variant would leave the key naming a file Codex cannot read.
    const unknown = await call("PUT", "/api/codex-prompt/base/select", fx, {
      kind: "variant", id: "zzzzzz", revision: rev0,
    });
    // 400, the status unknown_layer already carries everywhere else in this route: the
    // caller named something that does not exist, which is a bad request rather than a
    // conflict with the file's current state.
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("unknown_layer");

    // Every refusal above left the file byte-identical.
    expect(read(fx.configPath)).toBe(before);
  });

  test("a variant round-trips through the routes and the default clears the key", async () => {
    const fx = fixture("model = \"x\"\n");

    const created = await call("PUT", "/api/codex-prompt/base", fx, {
      id: null, title: "Terse", body: "Be brief.", revision: await revision(fx),
    });
    expect(created.status).toBe(200);

    const listed = await call("GET", "/api/codex-prompt", fx);
    expect(listed.body.baseVariants).toHaveLength(1);
    expect(listed.body.baseVariants[0].title).toBe("Terse");
    expect(listed.body.baseSelection).toEqual({ kind: "default" });
    expect(listed.body.maxBaseVariants).toBeGreaterThan(0);
    const id = listed.body.baseVariants[0].id as string;

    const selected = await call("PUT", "/api/codex-prompt/base/select", fx, {
      kind: "variant", id, revision: await revision(fx),
    });
    expect(selected.status).toBe(200);
    expect((await call("GET", "/api/codex-prompt", fx)).body.baseSelection).toEqual({ kind: "variant", id });
    expect(read(fx.configPath)!).toContain("model_instructions_file");

    const back = await call("PUT", "/api/codex-prompt/base/select", fx, {
      kind: "default", revision: await revision(fx),
    });
    expect(back.status).toBe(200);
    // Removed rather than emptied, and the user's own key is untouched.
    expect(read(fx.configPath)!).not.toContain("model_instructions_file");
    expect(read(fx.configPath)!).toContain("model = \"x\"");
  });

  test("a hand-set model_instructions_file is reported as external, never as default", async () => {
    // The plan-audit blocker, at the API boundary: the GUI can only be honest here if
    // the DTO is.
    const fx = fixture("model_instructions_file = \"/etc/somebody-elses.md\"\n");
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.body.baseSelection).toEqual({ kind: "external", path: "/etc/somebody-elses.md" });

    // And the route will not silently retarget it.
    const created = await call("PUT", "/api/codex-prompt/base", fx, {
      id: null, title: "Mine", body: "b", revision: await revision(fx),
    });
    expect(created.status).toBe(200);
    const id = (await call("GET", "/api/codex-prompt", fx)).body.baseVariants[0].id as string;
    const hijack = await call("PUT", "/api/codex-prompt/base/select", fx, {
      kind: "variant", id, revision: await revision(fx),
    });
    expect(hijack.status).toBe(409);
    expect(hijack.body.code).toBe("developer_instructions_not_owned");
  });

  test("an admin token can read the prompt stack but not rewrite it", async () => {
    // The gate accepts the raw admin token before it consults the session table
    // (management-auth.ts:462), and that token sits readable in ~/.opencodex. This
    // endpoint writes the file that decides what the model reads, so the two
    // credentials must not be interchangeable here.
    //
    // Reads stay open: describing the stack changes nothing, and the CLI parity
    // path depends on it.
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    const readAsAdmin = await call("GET", "/api/codex-prompt", fx, undefined, "admin-token");
    expect(readAsAdmin.status).toBe(200);
    const rev = readAsAdmin.body.revision as string;
    const before = read(fx.configPath);

    // Every mutating verb, so a future route added to this file is covered by the
    // same rule rather than needing its own test.
    const writes: [string, string, unknown][] = [
      ["PUT", "/api/codex-prompt/toggle", { id: "permissions", enabled: false, revision: rev }],
      ["PUT", "/api/codex-prompt/custom", { layers: [], revision: rev }],
      ["POST", "/api/codex-prompt/adopt", { confirm: true, revision: rev }],
      ["POST", "/api/codex-prompt/repair", { mode: "adopt", revision: rev }],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(method, path, fx, body, "admin-token");
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("dashboard_session_required");
    }
    // The refusal is not merely a status: nothing was written on the way to it.
    expect(read(fx.configPath)).toBe(before);
  });

  test("adopt refuses an oversized value, through BOTH import paths", async () => {
    // The owned-malformed repair branch reaches adoptDeveloperInstructions exactly
    // as /adopt does. Without a test on that branch, deleting its cap call is
    // invisible - which is how the bypass got in.
    const big = "z".repeat(64 * 1024 + 10);

    const viaAdopt = fixture("developer_instructions = \"" + big + "\"\n");
    const adopt = await call("POST", "/api/codex-prompt/adopt", viaAdopt, {
      confirm: true, revision: await revision(viaAdopt),
    });
    expect(adopt.status).toBe(400);
    expect(adopt.body.code).toBe("body_too_large");
    expect(existsSync(viaAdopt.storePath)).toBe(false);

    // Marker-adjacent but reshaped: drift is owned-malformed, so repair takes the
    // adopt branch rather than /adopt.
    const viaRepair = fixture(MARKER + "\ndeveloper_instructions  =  \"" + big + "\"\n");
    const get = await call("GET", "/api/codex-prompt", viaRepair);
    expect(get.body.drift).toBe("owned-malformed");
    const repair = await call("POST", "/api/codex-prompt/repair", viaRepair, {
      confirm: true, mode: "adopt", revision: get.body.revision,
    });
    expect(repair.status).toBe(400);
    expect(repair.body.code).toBe("body_too_large");
    expect(existsSync(viaRepair.storePath)).toBe(false);
  });

  test("the composed cap counts existing enabled layers, not the imported body alone", async () => {
    const existing = "y".repeat(70 * 1024);
    const incoming = "z".repeat(60 * 1024);
    const fx = fixture(
      "developer_instructions = \"" + incoming + "\"\n",
      storeJson([{ id: "aaaaaa", title: "Existing", body: existing, enabled: true }]),
    );
    const res = await call("POST", "/api/codex-prompt/adopt", fx, {
      confirm: true, revision: await revision(fx),
    });
    // Each body is under the 64 KiB per-layer cap; together they exceed 128 KiB.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("composed_too_large");
  });

  test("25. /text takes no caller-supplied directory", async () => {
    // A cwd parameter let an authenticated request read any readable folder's
    // AGENTS.md through the dashboard, and described a prompt from wherever the
    // caller pointed rather than the configuration this page reports on.
    const source = await Bun.file(new URL("../src/server/management/codex-prompt-routes.ts", import.meta.url)).text();
    const textRoute = source.slice(source.indexOf("/api/codex-prompt/text"));
    expect(textRoute).not.toContain("searchParams.get(\"cwd\")");
    expect(textRoute.slice(0, 900)).not.toContain("process.cwd()");

    const probe = await Bun.file(new URL("../src/codex/prompt-text-probe.ts", import.meta.url)).text();
    // The probe resolves CODEX_HOME itself; it must not accept a directory.
    expect(probe).toContain("resolveCodexHomeDir()");
    expect(probe).toMatch(/export async function probePromptText\(timeoutMs/);
  });

  test("26. the probe is bounded in bytes as well as in time", async () => {
    // A 15-second window with no output ceiling let a noisy binary balloon the
    // server. Both bounds must exist, and the process must settle exactly once.
    const probe = await Bun.file(new URL("../src/codex/prompt-text-probe.ts", import.meta.url)).text();
    expect(probe).toContain("MAX_PROBE_OUTPUT_BYTES");
    expect(probe).toContain("if (settled) return;");
    // Decoding per chunk corrupts UTF-8 that straddles a chunk boundary.
    expect(probe).toContain("Buffer.concat(chunks).toString(\"utf8\")");
  });

  test("27. the text route forwards live request cancellation to its exact child", async () => {
    const fx = fixture("");
    const pidPath = join(fx.decoyHome, "probe-pid.txt");
    setPromptTextProbeCommandForTests({
      binary: process.execPath,
      args: ["-e", [
        `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1_000);",
      ].join("")],
    });
    const controller = new AbortController();
    const url = new URL("http://127.0.0.1:10100/api/codex-prompt/text");
    const req = new Request(url, {
      method: "GET",
      headers: { host: "127.0.0.1:10100" },
      signal: controller.signal,
    });
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fx.decoyHome;
    let res: Response | null = null;
    try {
      const pending = handleManagementAPI(req, url, config, {
        codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath, baseVariantDir: fx.baseVariantDir },
      }, "gui-session");
      await waitUntil(() => existsSync(pidPath), "route probe child pid");
      controller.abort();
      res = await pending;
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }

    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ ok: false, detail: "prompt probe cancelled" });
    expect(promptTextProbeSpawnAttemptsForTests()).toBe(1);
    const pid = Number(readFileSync(pidPath, "utf8"));
    await waitUntil(() => !isProcessAlive(pid), "route probe child exit");
    expectDecoyUntouched(fx);
  });
  test("24. every ownership state is named, not collapsed into a boolean", async () => {
    // developerInstructionsOwned:false covers an ABSENT key and an EXTERNAL one, and
    // a GUI that cannot tell them apart hides its own create affordance from every
    // first-run user. The four states must each serialize distinctly.
    const absent = fixture("");
    expect((await call("GET", "/api/codex-prompt", absent)).body.developerInstructionsState).toBe("absent");

    const external = fixture("developer_instructions = \"hand written\"\n");
    expect((await call("GET", "/api/codex-prompt", external)).body.developerInstructionsState).toBe("external");

    const malformed = fixture(MARKER + "\ndeveloper_instructions = 'reshaped'\n");
    expect((await call("GET", "/api/codex-prompt", malformed)).body.developerInstructionsState).toBe("owned-malformed");

    const owned = fixture(ownedConfig("Be brief."), storeJson([
      { id: "aaaaaa", title: "House rules", body: "Be brief.", enabled: true },
    ]));
    const ownedRes = await call("GET", "/api/codex-prompt", owned);
    expect(ownedRes.body.developerInstructionsState).toBe("owned");
    // The boolean still agrees with the state it was too coarse to express.
    expect(ownedRes.body.developerInstructionsOwned).toBe(true);

    // A mutation echoes the state too, so the GUI never has to re-GET to learn it.
    const rev = ownedRes.body.revision as string;
    const put = await call("PUT", "/api/codex-prompt/toggle", owned, { id: "apps", enabled: false, revision: rev });
    expect(put.body.snapshot.developerInstructionsState).toBe("owned");
  });

  test("an unrecognized repair mode is refused rather than treated as adopt", async () => {
    const fx = fixture(MARKER + "\ndeveloper_instructions = 'reshaped'\n");
    const res = await call("POST", "/api/codex-prompt/repair", fx, {
      confirm: true, mode: "reset", revision: await revision(fx),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_body");
  });


});
