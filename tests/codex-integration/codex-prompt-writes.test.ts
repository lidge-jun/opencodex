/**
 * Route-level contract for the /api/codex-prompt write verbs — the cases split
 * out of codex-prompt-route.test.ts under the file-size ratchet: toggle
 * restore-default (`enabled: null`) and POST /api/codex-prompt/base/import.
 *
 * Every case injects fixture paths through `ManagementApiDeps.codexPromptPaths`, so
 * no test may resolve the real CODEX_HOME. A decoy directory with sentinel files
 * rides along and is asserted byte-identical after every verb: proving the
 * fixture changed does not prove nothing else did.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { readPromptLayers, recoverPromptJournal } from "../../src/codex/prompt-layers";
import { configWriteLockPath } from "../../src/codex/config-write-lock";
import { tryAcquire, release } from "../../src/codex/prompt-lock";
import { encodeJournal, hashBytes } from "../../src/codex/prompt-journal";
import { journalPathFor } from "../../src/codex/prompt-layers/paths";
import type { ManagementPrincipal } from "../../src/server/management-auth";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
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
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

test("recovery-only Repair honors the shared config lock and preserves every image while busy", async () => {
  const configBytes = 'model = "fixture"\n';
  const fx = fixture(configBytes);
  const journalPath = journalPathFor(fx.storePath);
  const bytes = encodeJournal({
    configPath: fx.configPath, storePath: fx.storePath,
    preConfig: hashBytes(configBytes), postConfig: hashBytes(configBytes),
    preStore: hashBytes(null), postStore: hashBytes(null),
    preConfigBytes: configBytes, postConfigBytes: configBytes,
    preStoreBytes: null, postStoreBytes: null,
  });
  writeFileSync(journalPath, bytes);
  const rev = await revision(fx);
  const held = tryAcquire(configWriteLockPath(fx.configPath));
  if (!held.ok) throw new Error("setup");
  try {
    const refused = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: rev });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("locked");
    expect(read(fx.configPath)).toBe(configBytes);
    expect(read(fx.storePath)).toBe(null);
    expect(read(journalPath)).toBe(bytes);
    expectDecoyUntouched(fx);
  } finally { release(held.handle); }
  const retry = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: rev });
  expect(retry.status).toBe(200);
  expect(read(fx.configPath)).toBe(configBytes);
  expect(read(fx.storePath)).toBe(null);
  expect(existsSync(journalPath)).toBe(false);
  expectDecoyUntouched(fx);
});

test("recovery can restore a known config image whose custom parent directory is absent", () => {
  const preStoreBytes = '{"version":1,"layers":[]}', postStoreBytes = '{"version":1,"layers":[{}]}';
  const fx = fixture(undefined, preStoreBytes);
  const configPath = join(fx.configPath, "..", "missing-home", "config.toml");
  const preConfigBytes = 'model = "fixture"\n';
  const journalPath = journalPathFor(fx.storePath);
  writeFileSync(journalPath, encodeJournal({
    configPath, storePath: fx.storePath,
    preConfig: hashBytes(preConfigBytes), postConfig: hashBytes(null),
    preStore: hashBytes(preStoreBytes), postStore: hashBytes(postStoreBytes),
    preConfigBytes, postConfigBytes: null, preStoreBytes, postStoreBytes,
  }));
  const result = recoverPromptJournal({ ...fx, configPath });
  expect(result.ok).toBe(true);
  expect(read(configPath)).toBe(preConfigBytes);
  expect(read(fx.storePath)).toBe(preStoreBytes);
  expect(existsSync(journalPath)).toBe(false);
  expectDecoyUntouched(fx);
});

test("Repair preserves a hostless unsafe config lock and returns the upstream nonretryable status", async () => {
  const configBytes = 'model = "fixture"\n';
  const fx = fixture(configBytes);
  const journalPath = journalPathFor(fx.storePath);
  const journalBytes = encodeJournal({
    configPath: fx.configPath, storePath: fx.storePath,
    preConfig: hashBytes(configBytes), postConfig: hashBytes(configBytes),
    preStore: hashBytes(null), postStore: hashBytes(null),
    preConfigBytes: configBytes, postConfigBytes: configBytes,
    preStoreBytes: null, postStoreBytes: null,
  });
  writeFileSync(journalPath, journalBytes);
  const rev = await revision(fx);
  const lockPath = configWriteLockPath(fx.configPath);
  const lockBytes = JSON.stringify({ token: "legacy-owner", pid: process.pid, acquiredAt: Date.now() });
  writeFileSync(lockPath, lockBytes);
  const refused = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: rev });
  expect(refused.status).toBe(422);
  expect(refused.body.code).toBe("unsafe");
  expect(read(lockPath)).toBe(lockBytes);
  expect(read(fx.configPath)).toBe(configBytes);
  expect(read(fx.storePath)).toBe(null);
  expect(read(journalPath)).toBe(journalBytes);
  expect(existsSync(fx.storePath.replace(/\.json$/, ".lock"))).toBe(false);
});

test.skipIf(process.platform === "win32")("Repair through a config alias shares the canonical lock and replays after release", async () => {
  const preConfigBytes = 'model = "before"\n', postConfigBytes = 'model = "after"\n';
  const fx = fixture(postConfigBytes);
  const canonical = fx.configPath;
  fx.configPath = join(canonical, "..", "config-alias.toml");
  symlinkSync(canonical, fx.configPath);
  const journalPath = journalPathFor(fx.storePath);
  const journalBytes = encodeJournal({
    configPath: fx.configPath, storePath: fx.storePath,
    preConfig: hashBytes(preConfigBytes), postConfig: hashBytes(postConfigBytes),
    preStore: hashBytes(null), postStore: hashBytes('{"layers":[{}]}'),
    preConfigBytes, postConfigBytes, preStoreBytes: null, postStoreBytes: '{"layers":[{}]}',
  });
  writeFileSync(journalPath, journalBytes);
  const held = tryAcquire(configWriteLockPath(canonical));
  if (!held.ok) throw new Error("setup");
  try {
    expect(recoverPromptJournal(fx)).toMatchObject({ ok: false, error: "locked" });
    expect(read(canonical)).toBe(postConfigBytes);
    expect(read(journalPath)).toBe(journalBytes);
  } finally { release(held.handle); }
  expect(recoverPromptJournal(fx)).toMatchObject({ ok: true, changed: true });
  expect(read(canonical)).toBe(preConfigBytes);
  expect(read(fx.configPath)).toBe(preConfigBytes);
  expect(existsSync(journalPath)).toBe(false);
  expectDecoyUntouched(fx);
});

describe("toggle restore-default (enabled: null)", () => {
  test("null deletes the key line rather than writing the default literal", async () => {
    // An explicit `include_apps_instructions = false` is an override. `null` is
    // the restore verb: the line is removed so the file follows Codex's default
    // again, instead of a literal that happens to match it today.
    const fx = fixture("model = \"x\"\ninclude_apps_instructions = false\n");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: null, revision: await revision(fx),
    });
    expect(res.status).toBe(200);
    const config = read(fx.configPath)!;
    expect(config).not.toContain("include_apps_instructions");
    expect(config).toContain("model = \"x\"");
    const apps = res.body.snapshot.toggles.find((t: any) => t.id === "apps");
    expect(apps.userFileValue).toBeNull();
    // The switch itself still reads on — absent means default, and the default is on.
    expect(apps.defaultedUserValue).toBe(true);
  });

  test("null removes a key from inside a table without orphaning the table", async () => {
    // skills.include_instructions lives under [skills]; removing the key leaves
    // the header, which is valid TOML and keeps any hand-written comments
    // reachable.
    const fx = fixture("model = \"x\"\n\n[skills]\ninclude_instructions = false\n");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "skills", enabled: null, revision: await revision(fx),
    });
    expect(res.status).toBe(200);
    const config = read(fx.configPath)!;
    expect(config).not.toContain("include_instructions");
    expect(config).toContain("[skills]");
  });

  test("null on an absent key is a harmless no-op", async () => {
    const fx = fixture("model = \"x\"\n");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: null, revision: await revision(fx),
    });
    expect(res.status).toBe(200);
    expect(read(fx.configPath)).toBe("model = \"x\"\n");
  });

  test("a missing enabled field is still invalid_body", async () => {
    const fx = fixture("");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", revision: await revision(fx),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_body");
    // fixture("") creates the file; the refusal leaves it byte-identical.
    expect(read(fx.configPath)).toBe("");
  });

  test("null removes the key but keeps a trailing comment the user wrote", async () => {
    const fx = fixture("model = \"x\"\ninclude_apps_instructions = false # asked for minimal prompts\n");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: null, revision: await revision(fx),
    });
    expect(res.status).toBe(200);
    const config = read(fx.configPath)!;
    expect(config).not.toContain("include_apps_instructions");
    expect(config).toContain("# asked for minimal prompts");
  });

  test("a toggle write replaces a non-boolean value instead of duplicating the key", async () => {
    // `= "bogus"` is a bad fact about the same key. A matcher that only knew
    // `true|false` used to append a second assignment — and TOML refuses
    // duplicate keys, so the whole file stopped parsing.
    const fx = fixture("model = \"x\"\ninclude_apps_instructions = \"bogus\"\n");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: true, revision: await revision(fx),
    });
    expect(res.status).toBe(200);
    const lines = read(fx.configPath)!.split("\n").filter(l => /^\s*include_apps_instructions\s*=/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("true");
  });

  test("an adjacent comment survives a root toggle write AND a restore-default removal", async () => {
    // `false# note` — no space before `#` — is still a comment. A matcher that
    // required whitespace used to drop it on write and on removal.
    const fx = fixture("include_apps_instructions = false# keep me\n");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: true, revision: await revision(fx),
    });
    expect(res.status).toBe(200);
    expect(read(fx.configPath)).toBe("include_apps_instructions = true# keep me\n");

    const res2 = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: null, revision: await revision(fx),
    });
    expect(res2.status).toBe(200);
    // The assignment is gone; the comment the user wrote beside it is not.
    expect(read(fx.configPath)).toBe("# keep me\n");
    expect(() => Bun.TOML.parse(read(fx.configPath)!)).not.toThrow();
  });

  test("a # inside a quoted value is never mistaken for a comment", async () => {
    const fx = fixture('include_apps_instructions = "a#b" # real comment\n');
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: false, revision: await revision(fx),
    });
    expect(res.status).toBe(200);
    // The quoted value is replaced whole; the real comment is preserved.
    expect(read(fx.configPath)).toBe('include_apps_instructions = false # real comment\n');
    expect(() => Bun.TOML.parse(read(fx.configPath)!)).not.toThrow();
  });

  test("an adjacent comment inside a [skills] table survives the same way", async () => {
    const fx = fixture("[skills]\ninclude_instructions = false# stay\n");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "skills", enabled: true, revision: await revision(fx),
    });
    expect(res.status).toBe(200);
    expect(read(fx.configPath)).toBe("[skills]\ninclude_instructions = true# stay\n");
    expect(() => Bun.TOML.parse(read(fx.configPath)!)).not.toThrow();
  });

  for (const value of ['"""\ntrue\n"""', '[\n  true,\n]', '[ # keep this array\n  true,\n]', '{ enabled = true }']) {
    for (const id of ["apps", "skills"]) {
      for (const enabled of [true, null]) {
        test(`a ${id} composite or multi-line value refuses ${enabled} before any write: ${value}`, async () => {
          const configBytes = id === "apps" ? `include_apps_instructions = ${value}\n`
            : `[skills]\ninclude_instructions = ${value}\n`;
          expect(() => Bun.TOML.parse(configBytes)).not.toThrow();
          const fx = fixture(configBytes);
          const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id, enabled, revision: await revision(fx) });
          expect(res.status).toBe(409);
          expect(res.body.code).toBe("unsupported_form");
          expect(read(fx.configPath)).toBe(configBytes);
          expect(existsSync(journalPathFor(fx.storePath))).toBe(false);
          expect(existsSync(fx.storePath)).toBe(false);
        });
      }
    }
  }
});

describe("POST /api/codex-prompt/base/import", () => {
  test("an unreadable config refuses import with its actual read failure", async () => {
    const fx = fixture();
    mkdirSync(fx.configPath);
    const res = await call("POST", "/api/codex-prompt/base/import", fx, { confirm: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("config_unreadable");
    expect(readdirSync(fx.configPath)).toEqual([]);
    expect(existsSync(fx.storePath)).toBe(false);
    expect(existsSync(journalPathFor(fx.storePath))).toBe(false);
  });
  /** An external pointer plus the file it names, inside the fixture's own dir. */
  function externalFixture(body: string, name = "somebody-elses.md"): { fx: Fixture; externalPath: string } {
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-ext-"));
    roots.push(root);
    const externalPath = join(root, name);
    writeFileSync(externalPath, body, "utf8");
    // The value is a JSON-encoded TOML basic string, so a Windows path's
    // backslashes land escaped exactly as a user would write them.
    return { fx: fixture(`model_instructions_file = ${JSON.stringify(externalPath)}\n`), externalPath };
  }

  /** A preview request; `title` previews that spelling so its hash binds it. */
  async function previewImport(fx: Fixture, title?: string) {
    return call("POST", "/api/codex-prompt/base/import", fx,
      title === undefined ? { confirm: false } : { confirm: false, title });
  }

  /** Preview (with `title` when given), then confirm bound to exactly that preview. */
  async function importConfirmed(fx: Fixture, title?: string) {
    const preview = await previewImport(fx, title);
    expect(preview.status).toBe(200);
    return call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true,
      revision: await revision(fx),
      ...(title === undefined ? {} : { title }),
      previewSha256: preview.body.preview.previewSha256,
    });
  }

  test("preview returns the serialized file — heading plus normalized body — and writes nothing", async () => {
    const { fx, externalPath } = externalFixture("Ship the external base.");
    const before = read(fx.configPath);
    const res = await previewImport(fx);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    const p = res.body.preview;
    // The serialized text is what Codex will read: `# {title}` + the body.
    expect(p.serialized).toBe("# somebody-elses\nShip the external base.");
    expect(p.suggestedTitle).toBe("somebody-elses");
    expect(p.effectiveTitle).toBe("somebody-elses");
    // The two byte counts are separately named: the body carries the 64 KiB
    // budget, the serialized figure is the complete file.
    expect(p.bodyBytes).toBe(Buffer.byteLength("Ship the external base.", "utf8"));
    expect(p.serializedBytes).toBe(Buffer.byteLength(p.serialized, "utf8"));
    expect(p.previewSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(read(fx.configPath)).toBe(before);
    expect(existsSync(fx.baseVariantDir)).toBe(false);
  });

  for (const [label, source] of [
    ["plain text", "Ship the external base."],
    ["an existing heading", "# Existing Heading\n\nBody text."],
    ["tabs", "Indent\ta level\tdeep"],
    ["CRLF", "line one\r\nline two\r\n"],
  ] as const) {
    test(`the previewed serialization is the stored file, byte for byte (${label})`, async () => {
      const { fx } = externalFixture(source);
      const preview = await previewImport(fx);
      expect(preview.status).toBe(200);
      const res = await importConfirmed(fx);
      expect(res.status).toBe(200);
      const variant = res.body.snapshot.baseVariants[0];
      // The file on disk is the previewed serialization, not a re-derivation:
      // the heading Codex reads is the one the preview showed.
      expect(read(join(fx.baseVariantDir, `${variant.id}.md`))).toBe(preview.body.preview.serialized);
    });
  }

  test("confirm copies the file into the variant directory and repoints the key", async () => {
    const { fx, externalPath } = externalFixture("Ship the external base.");
    const res = await importConfirmed(fx);
    expect(res.status).toBe(200);
    const snapshot = res.body.snapshot;
    expect(snapshot.baseVariants).toHaveLength(1);
    const variant = snapshot.baseVariants[0];
    expect(variant.title).toBe("somebody-elses");
    expect(variant.body).toBe("Ship the external base.");
    // The key now names OUR copy — selection resolves as a managed variant.
    expect(snapshot.baseSelection).toEqual({ kind: "variant", id: variant.id });
    expect(read(join(fx.baseVariantDir, `${variant.id}.md`))).toContain("Ship the external base.");
    // The user's file is left where it was; nothing external is modified.
    expect(read(externalPath)).toBe("Ship the external base.");
    expect(read(fx.configPath)!).toContain(variant.id + ".md");
    // Format-agnostic: the original file's basename is gone from the key.
    expect(read(fx.configPath)!).not.toContain("somebody-elses.md");
  });

  test("nothing_to_import when the key is absent or already managed", async () => {
    const absent = fixture("model = \"x\"\n");
    const res1 = await call("POST", "/api/codex-prompt/base/import", absent, { confirm: false });
    expect(res1.status).toBe(409);
    expect(res1.body.code).toBe("nothing_to_import");

    // A key pointing at a MANAGED variant is also not external.
    const managed = fixture("model = \"x\"\n");
    await call("PUT", "/api/codex-prompt/base", managed, {
      id: null, title: "Mine", body: "b", revision: await revision(managed),
    });
    const id = (await call("GET", "/api/codex-prompt", managed)).body.baseVariants[0].id as string;
    await call("PUT", "/api/codex-prompt/base/select", managed, {
      kind: "variant", id, revision: await revision(managed),
    });
    const res2 = await call("POST", "/api/codex-prompt/base/import", managed, { confirm: false });
    expect(res2.status).toBe(409);
    expect(res2.body.code).toBe("nothing_to_import");
  });

  test("an unreadable target is refused with the resolved path", async () => {
    // A directory where the file should be is unreadable on every platform.
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-ext-"));
    roots.push(root);
    const externalPath = join(root, "dir-instead.md");
    mkdirSync(externalPath);
    const fx = fixture(`model_instructions_file = ${JSON.stringify(externalPath)}\n`);
    const res = await call("POST", "/api/codex-prompt/base/import", fx, { confirm: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("import_file_unreadable");
    expect(res.body.path).toBe(externalPath);
  });

  test("a control character in the file is rejected before any copy is made", async () => {
    const { fx } = externalFixture("okbad");
    const res = await call("POST", "/api/codex-prompt/base/import", fx, { confirm: false });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_characters");
    expect(existsSync(fx.baseVariantDir)).toBe(false);
  });

  test("a 65536-byte body with a valid title imports; one byte more is refused", async () => {
    // The cap is on the BODY alone — the `# {title}\n` heading lives outside
    // the budget, so the stored file is larger than the budget by the heading.
    const fits = externalFixture("x".repeat(64 * 1024));
    const ok = await importConfirmed(fits.fx, "Full");
    expect(ok.status).toBe(200);
    const variant = ok.body.snapshot.baseVariants[0];
    const stored = read(join(fits.fx.baseVariantDir, `${variant.id}.md`))!;
    expect(Buffer.byteLength(stored, "utf8")).toBe(64 * 1024 + "# Full\n".length);
    expect(ok.body.snapshot.baseVariants[0].title).toBe("Full");

    const over = externalFixture("x".repeat(64 * 1024 + 1));
    const res = await previewImport(over.fx);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("body_too_large");
    expect(existsSync(over.fx.baseVariantDir)).toBe(false);
  });

  test("body bytes are measured in UTF-8, not characters", async () => {
    // 30 000 hangul syllables are 90 000 bytes: under a character cap, over a
    // byte cap — the byte cap is the one that exists.
    const { fx } = externalFixture("가".repeat(30_000));
    const res = await previewImport(fx);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("body_too_large");

    const fitting = externalFixture("가".repeat(20_000));
    const res2 = await previewImport(fitting.fx);
    expect(res2.status).toBe(200);
    expect(res2.body.preview.bodyBytes).toBe(60_000);
    // Multibyte text serializes and stores intact.
    const done = await importConfirmed(fitting.fx);
    expect(done.status).toBe(200);
    expect(done.body.snapshot.baseVariants[0].body).toBe("가".repeat(20_000));
  });

  test("a caller title of 80 characters is accepted, 81 refused — before any write", async () => {
    const { fx } = externalFixture("b");
    const revisionNow = await revision(fx);
    for (const [label, payload] of [
      ["81 chars on preview", { confirm: false, title: "x".repeat(81) }],
      ["81 chars on confirm", { confirm: true, revision: revisionNow, title: "x".repeat(81), previewSha256: "0".repeat(64) }],
      ["a newline", { confirm: false, title: "a\nb" }],
      ["a non-string", { confirm: false, title: 42 }],
      ["empty", { confirm: false, title: "   " }],
    ] as const) {
      const res = await call("POST", "/api/codex-prompt/base/import", fx, payload);
      expect(res.status, label).toBe(400);
      expect(res.body.code, label).toBe("invalid_title");
    }
    // 80 chars is inside the limit and previews cleanly.
    const title = "y".repeat(80);
    const ok = await previewImport(fx, title);
    expect(ok.status).toBe(200);
    expect(ok.body.preview.effectiveTitle).toBe(title);
    expect(ok.body.preview.serialized.startsWith(`# ${title}\n`)).toBe(true);
  });

  test("a long filename-derived suggestion is bounded to the title limit", async () => {
    const name = `${"v".repeat(120)}.md`;
    const { fx } = externalFixture("body", name);
    const res = await previewImport(fx);
    expect(res.status).toBe(200);
    const p = res.body.preview;
    expect(p.suggestedTitle!.length).toBeLessThanOrEqual(80);
    // The bounded suggestion is what the heading shows — not the full basename.
    expect(p.serialized.startsWith(`# ${p.suggestedTitle}\n`)).toBe(true);
  });

  test("confirm requires a preview hash and refuses a stale or mismatched one", async () => {
    const { fx, externalPath } = externalFixture("Ship the external base.");
    const revisionNow = await revision(fx);
    for (const [label, hash] of [
      ["missing", undefined],
      ["non-string", 42],
      ["malformed", "not-a-sha"],
      ["well-formed but not the preview's", "0".repeat(64)],
    ] as const) {
      const res = await call("POST", "/api/codex-prompt/base/import", fx, {
        confirm: true, revision: revisionNow, ...(hash === undefined ? {} : { previewSha256: hash }),
      });
      expect(res.status === 400 || res.status === 409, label).toBe(true);
      expect(
        res.body.code === "import_preview_required" || res.body.code === "import_body_changed",
        label,
      ).toBe(true);
    }
    // Missing specifically reports the missing-hash contract.
    const missing = await call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true, revision: revisionNow,
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("import_preview_required");
    expect(existsSync(fx.baseVariantDir)).toBe(false);

    // The file moved between preview and confirm: nobody previewed THIS body,
    // so the route refuses rather than install a surprise.
    const preview = await previewImport(fx);
    writeFileSync(externalPath, "Ship the external base — revised after preview.", "utf8");
    const stale = await call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true, revision: await revision(fx), previewSha256: preview.body.preview.previewSha256,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("import_body_changed");
    expect(existsSync(fx.baseVariantDir)).toBe(false);

    // Re-preview picks up the new bytes and their hash; that confirm lands.
    const res = await importConfirmed(fx);
    expect(res.status).toBe(200);
    expect(res.body.snapshot.baseVariants[0].body).toBe("Ship the external base — revised after preview.");
  });

  test("a source rewritten while the write locks are acquired is refused, not activated stale", async () => {
    const { fx, externalPath } = externalFixture("approved body");
    const preview = await previewImport(fx);
    const rev = await revision(fx);
    const configBefore = read(fx.configPath);
    // Rewrite the source at the moment the config write lock is created: both
    // locks are held from here on, after the pre-lock hash check already passed.
    const lockPath = configWriteLockPath(fx.configPath);
    const write = fs.writeFileSync;
    let rewritten = false;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      write(path, data, options);
      if (!rewritten && String(path) === lockPath) {
        rewritten = true;
        write(externalPath, "edited while the confirm held the locks", "utf8");
      }
    }) as typeof fs.writeFileSync);
    let res: Awaited<ReturnType<typeof call>>;
    try {
      res = await call("POST", "/api/codex-prompt/base/import", fx, {
        confirm: true, revision: rev, previewSha256: preview.body.preview.previewSha256,
      });
    } finally {
      spy.mockRestore();
    }
    expect(rewritten).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("import_body_changed");
    // Nothing was activated, the newer source survives, and the copied variant
    // file that provably no config references is cleaned up.
    expect(read(fx.configPath)).toBe(configBefore);
    expect(read(externalPath)).toBe("edited while the confirm held the locks");
    expect(existsSync(fx.baseVariantDir) ? readdirSync(fx.baseVariantDir) : []).toEqual([]);
    expect(existsSync(journalPathFor(fx.storePath))).toBe(false);
  });

  test("a refused import keeps its copy when a peer selected that copy meanwhile", async () => {
    const { fx } = externalFixture("approved body");
    const preview = await previewImport(fx);
    const rev = await revision(fx);
    // When the config write lock is created, a non-cooperating writer points the
    // key at the copy that was just written. The locked recheck then refuses
    // (the selection is no longer external), and cleanup must not delete a file
    // the live config now names.
    const lockPath = configWriteLockPath(fx.configPath);
    const write = fs.writeFileSync;
    let peerConfig: string | null = null;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      write(path, data, options);
      if (peerConfig === null && String(path) === lockPath) {
        const copy = join(fx.baseVariantDir, readdirSync(fx.baseVariantDir)[0]!);
        peerConfig = `model_instructions_file = ${JSON.stringify(copy)}\n# peer selected the managed copy\n`;
        write(fx.configPath, peerConfig, "utf8");
      }
    }) as typeof fs.writeFileSync);
    let res: Awaited<ReturnType<typeof call>>;
    try {
      res = await call("POST", "/api/codex-prompt/base/import", fx, {
        confirm: true, revision: rev, previewSha256: preview.body.preview.previewSha256,
      });
    } finally {
      spy.mockRestore();
    }
    expect(peerConfig).not.toBeNull();
    expect(res.status).toBe(409);
    expect(read(fx.configPath)).toBe(peerConfig);
    const [copy] = readdirSync(fx.baseVariantDir);
    expect(read(join(fx.baseVariantDir, copy!))).toBe("# somebody-elses\napproved body");
  });

  test("the hash binds the title: confirming a different spelling is refused", async () => {
    const { fx } = externalFixture("Ship the external base.");
    const preview = await previewImport(fx); // previews the suggested title
    const res = await call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true, revision: await revision(fx),
      title: "Renamed", previewSha256: preview.body.preview.previewSha256,
    });
    // The hash was computed over the suggested title — "Renamed" was never previewed.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("import_body_changed");
    expect(existsSync(fx.baseVariantDir)).toBe(false);

    // Re-preview WITH the title binds the hash to it; that confirm lands.
    const done = await importConfirmed(fx, "Renamed");
    expect(done.status).toBe(200);
    const variant = done.body.snapshot.baseVariants[0];
    expect(variant.title).toBe("Renamed");
    expect(read(join(fx.baseVariantDir, `${variant.id}.md`))).toBe("# Renamed\nShip the external base.");
  });

  test("slots_full still returns the preview serialization, so the cap does not look like a read failure", async () => {
    const { fx } = externalFixture("Third base.");
    for (const title of ["One", "Two"]) {
      const created = await call("PUT", "/api/codex-prompt/base", fx, {
        id: null, title, body: "b", revision: await revision(fx),
      });
      expect(created.status).toBe(200);
    }
    const res = await previewImport(fx);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("variant_slots_full");
    expect(res.body.serialized).toBe("# somebody-elses\nThird base.");
    // A confirm under slots_full is refused before the hash is even consulted —
    // the cap check precedes the confirmation contract.
    const res2 = await call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true, revision: await revision(fx), previewSha256: "0".repeat(64),
    });
    expect(res2.status).toBe(409);
    expect(res2.body.code).toBe("variant_slots_full");
  });

  test("a stale revision on confirm refuses and leaves no file behind", async () => {
    const { fx } = externalFixture("Ship the external base.");
    const preview = await previewImport(fx);
    const res = await call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true, revision: "sha256:stale",
      previewSha256: preview.body.preview.previewSha256,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
    // The variant file is written BEFORE the transaction touches config.toml;
    // a refused commit must not leave it behind.
    expect(existsSync(fx.baseVariantDir) ? readdirSync(fx.baseVariantDir) : []).toHaveLength(0);
  });

  test("an admin token cannot run the import", async () => {
    const { fx } = externalFixture("Ship the external base.");
    const res = await call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true, revision: await revision(fx),
    }, "admin-token");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("dashboard_session_required");
    expect(existsSync(fx.baseVariantDir)).toBe(false);
  });

  test("a single-quoted model_instructions_file is replaced, not duplicated", async () => {
    // TOML literal strings are legal here; a matcher that only knew "..." used
    // to append a second assignment and corrupt the file.
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-ext-"));
    roots.push(root);
    const externalPath = join(root, "quoted.md");
    writeFileSync(externalPath, "Quoted prompt.", "utf8");
    const fx = fixture(`model_instructions_file = '${externalPath}'\n`);
    const res = await importConfirmed(fx);
    expect(res.status).toBe(200);
    const config = read(fx.configPath)!;
    const keyLines = config.split("\n").filter(l => /^\s*model_instructions_file\s*=/.test(l));
    expect(keyLines).toHaveLength(1);
    expect(keyLines[0]).toContain(".md");
    expect(() => Bun.TOML.parse(config)).not.toThrow();
  });

  test("a double-quoted key is replaced too, and an adjacent comment survives", async () => {
    // "key" assigns the same key as bare `key` — skipping it used to append a
    // duplicate; and `# note` glued to the value is a comment, not value text.
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-ext-"));
    roots.push(root);
    const externalPath = join(root, "dq.md");
    writeFileSync(externalPath, "DQ prompt.", "utf8");
    const fx = fixture(`"model_instructions_file" = ${JSON.stringify(externalPath)}# keep this\n`);
    const res = await importConfirmed(fx);
    expect(res.status).toBe(200);
    const config = read(fx.configPath)!;
    expect(config).toContain("# keep this");
    // Exactly one assignment of the key, however spelled.
    const keyLines = config.split("\n").filter(l => /^\s*["']?model_instructions_file["']?\s*=/.test(l));
    expect(keyLines).toHaveLength(1);
    expect(() => Bun.TOML.parse(config)).not.toThrow();
    expect(readPromptLayers({ configPath: fx.configPath, storePath: fx.storePath, baseVariantDir: fx.baseVariantDir })
      .baseSelection.kind).toBe("variant");
  });

  test("a multi-line string value refuses before any write and leaves the config byte-identical", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-ext-"));
    roots.push(root);
    const externalPath = join(root, "ml.md");
    writeFileSync(externalPath, "x", "utf8");
    // The key is set, but its value is a form a line editor cannot see the end
    // of — the honest answer is a refusal, not a spliced edit.
    const configBytes = `model_instructions_file = """${externalPath}"""\n`;
    const fx = fixture(configBytes);
    const preview = await previewImport(fx);
    expect(preview.status).toBe(409);
    expect(preview.body.code).toBe("import_unsupported_form");
    const confirm = await call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true, revision: await revision(fx), previewSha256: "0".repeat(64),
    });
    expect(confirm.status).toBe(409);
    expect(confirm.body.code).toBe("import_unsupported_form");
    expect(read(fx.configPath)).toBe(configBytes);
    expect(existsSync(fx.baseVariantDir)).toBe(false);
  });
});

for (const key of ['model_instructions_file', '"model_instructions_file"']) {
  test(`an import accepts trailing whitespace after ${key}'s value`, async () => {
    const fx = fixture();
    const external = join(fx.decoyHome, "external.md");
    writeFileSync(external, "Body.");
    writeFileSync(fx.configPath, `${key} = ${JSON.stringify(external)} \t\n`);
    const preview = await call("POST", "/api/codex-prompt/base/import", fx, { confirm: false });
    expect(preview.status).toBe(200);
    const result = await call("POST", "/api/codex-prompt/base/import", fx, {
      confirm: true, revision: readPromptLayers(fx).revision, previewSha256: preview.body.preview?.previewSha256,
    });
    expect(result.status).toBe(200);
    expect(() => Bun.TOML.parse(read(fx.configPath)!)).not.toThrow();
  });
}

test("escaped quoted keys are rewritten without adding a duplicate bare key", async () => {
  const fx = fixture();
  const external = join(fx.decoyHome, "external.md");
  writeFileSync(external, "Body.");
  // Bun's native parser must recognize this key as the same root property.
  const bytes = `"model_instructions_\\u0066ile" = ${JSON.stringify(external)}\n`;
  expect(Bun.TOML.parse(bytes).model_instructions_file).toBe(external);
  writeFileSync(fx.configPath, bytes);
  const preview = await call("POST", "/api/codex-prompt/base/import", fx, { confirm: false });
  expect(preview.status).toBe(200);
  const result = await call("POST", "/api/codex-prompt/base/import", fx, {
    confirm: true, revision: readPromptLayers(fx).revision, previewSha256: preview.body.preview?.previewSha256,
  });
  expect(result.status).toBe(200);
  expect(() => Bun.TOML.parse(read(fx.configPath)!)).not.toThrow();
  expect(read(fx.configPath)!).not.toMatch(/^model_instructions_file\s*=/m);
});

test("the full 64 KiB CRLF-normalized body fits the bounded source read", async () => {
  const fx = fixture();
  const external = join(fx.decoyHome, "crlf.md");
  writeFileSync(external, "\r\n".repeat(65536));
  writeFileSync(fx.configPath, `model_instructions_file = ${JSON.stringify(external)}\n`);
  const result = await call("POST", "/api/codex-prompt/base/import", fx, { confirm: false });
  expect(result.status).toBe(200);
  expect(result.body.preview.bodyBytes).toBe(65536);
});

test("escaped root and table toggle keys preserve trailing whitespace on write and reset", async () => {
  const fx = fixture('"include_\\u0061pps_instructions" = false \t\n[skills]\n"include_\\u0069nstructions" = false \t\n');
  for (const id of ["apps", "skills"]) {
    for (const enabled of [true, null]) {
      const result = await call("PUT", "/api/codex-prompt/toggle", fx, {
        id, enabled, revision: readPromptLayers(fx).revision,
      });
      expect(result.status).toBe(200);
      const parsed = Bun.TOML.parse(read(fx.configPath)!);
      expect(id === "apps" ? parsed.include_apps_instructions : (parsed.skills as Record<string, unknown>).include_instructions)
        .toBe(enabled === null ? undefined : enabled);
    }
  }
});
