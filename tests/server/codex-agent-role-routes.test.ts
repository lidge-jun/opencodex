import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ROLE = 'name = "explorer"\ndeveloper_instructions = """\nmodel = "x"\n"""\nmodel = "gpt-5.5"\n';
const saved = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let root = "";

function restore(name: keyof typeof saved): void {
  if (saved[name] === undefined) delete process.env[name];
  else process.env[name] = saved[name];
}

beforeEach(() => {
  // Match getCodexHome(), which resolves aliases before filesystem access (for example macOS /var).
  root = fs.realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-agent-role-routes-")));
  mkdirSync(join(root, "codex", "agents"), { recursive: true });
  mkdirSync(join(root, "home", ".omo"), { recursive: true });
  writeFileSync(join(root, "codex", "agents", "explorer.toml"), ROLE);
  installLazyCodex();
  process.env.CODEX_HOME = join(root, "codex");
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
});

afterEach(() => {
  restore("CODEX_HOME");
  restore("HOME");
  restore("USERPROFILE");
  removeTreeWithRetry(root);
});

const config = { port: 10100, providers: {}, defaultProvider: "openai" } as unknown as OcxConfig;
const DETECTED = { detected: true, pluginEnabled: true, pluginInstalled: true };

function installLazyCodex(): void {
  const plugin = join(root, "codex", "plugins", "cache", "sisyphuslabs", "omo", "5.1.1");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "lazycodex-install.json"), "{}");
  writeFileSync(join(root, "codex", "config.toml"), '[plugins."omo@sisyphuslabs"]\nenabled = true\n');
}

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleManagementAPI(new Request(`http://localhost${path}`, init), new URL(`http://localhost${path}`), config);
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() as Record<string, unknown> };
}

function put(role: string, model: unknown) {
  return call(`/api/codex-agent-roles/${role}`, { method: "PUT", body: JSON.stringify({ model }) });
}

describe("/api/codex-agent-roles", () => {
  test("round-trips a role model through the TOML and omo.jsonc", async () => {
    writeFileSync(join(root, "home", ".omo", "omo.jsonc"), '{ "[codex]": {} }\n');
    expect((await call("/api/codex-agent-roles")).body).toEqual({
      lazycodex: DETECTED,
      omoJsonc: { state: "present" },
      roles: [{ role: "explorer", model: "gpt-5.5", effort: null, omoJsoncModel: null }],
    });
    const saved = await put("explorer", "xai/grok-4.5");
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true, role: "explorer", model: "xai/grok-4.5", toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toBe(ROLE.replace('model = "gpt-5.5"', 'model = "xai/grok-4.5"'));
    expect((await call("/api/codex-agent-roles")).body.roles).toEqual([{ role: "explorer", model: "xai/grok-4.5", effort: null, omoJsoncModel: "xai/grok-4.5" }]);
  });

  test("an effort goes to the role file and, as reasoning, to omo.jsonc", async () => {
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "explorer": { "model": "gpt-5.5", "reasoning": "low" } } } }\n');
    const saved = await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: "high" }) });
    expect(saved.body).toMatchObject({ effort: "high", toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toContain('model_reasoning_effort = "high"');
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.explorer).toEqual({ model: "gpt-5.5", reasoning: "high" });
    expect((await call("/api/codex-agent-roles")).body.roles).toEqual([{ role: "explorer", model: "gpt-5.5", effort: "high", omoJsoncModel: "gpt-5.5" }]);

    // LazyCodex has no ultra level: the role file keeps it, and omo.jsonc drops the stale low.
    await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: "ultra" }) });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toContain('model_reasoning_effort = "ultra"');
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.explorer).toEqual({ model: "gpt-5.5" });
  });

  test("a null effort returns the role to its model default in both files", async () => {
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "explorer": { "model": "gpt-5.5", "reasoning": "high" } } } }\n');
    await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: "high" }) });
    const cleared = await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: null }) });
    expect(cleared.body).toMatchObject({ effort: null, toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).not.toContain("model_reasoning_effort");
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.explorer).toEqual({ model: "gpt-5.5" });
    expect((await call("/api/codex-agent-roles")).body.roles).toEqual([{ role: "explorer", model: "gpt-5.5", effort: null, omoJsoncModel: "gpt-5.5" }]);
  });

  test("a model-only save keeps the role's effort and its omo.jsonc reasoning", async () => {
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "explorer": { "model": "gpt-5.5", "reasoning": "high" } } } }\n');
    await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: "high" }) });
    const saved = await put("explorer", "xai/grok-4.5");
    expect(saved.status).toBe(200);
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toContain('model_reasoning_effort = "high"');
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.explorer).toEqual({ model: "xai/grok-4.5", reasoning: "high" });
  });

  test("without LazyCodex it lists nothing, writes nothing, and never opens omo.jsonc", async () => {
    writeFileSync(join(root, "codex", "config.toml"), "");
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": {} }\n');
    const nativeRead = fs.readFileSync;
    const reads: string[] = [];
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      reads.push(String(path));
      return nativeRead(path, options as BufferEncoding);
    }) as never);
    try {
      expect((await call("/api/codex-agent-roles")).body).toEqual({
        lazycodex: { detected: false, pluginEnabled: false, pluginInstalled: true },
        omoJsonc: null,
        roles: [],
      });
      const refused = await put("explorer", "m");
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("lazycodex_not_detected");
    } finally {
      spy.mockRestore();
    }
    expect(reads).not.toContain(omoPath);
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toBe(ROLE);
    expect(readFileSync(omoPath, "utf8")).toBe('{ "[codex]": {} }\n');
  });

  test("reports an absent or commented omo.jsonc without writing it", async () => {
    expect((await put("explorer", "m1")).body.omoJsonc).toEqual({ status: "absent" });
    const commented = '{ // mine\n  "codex": {} }\n';
    writeFileSync(join(root, "home", ".omo", "omo.jsonc"), commented);
    expect((await call("/api/codex-agent-roles")).body.omoJsonc).toEqual({ state: "comments" });
    const result = await put("explorer", "m2");
    expect(result.body.toml).toEqual({ status: "written" });
    expect(result.body.omoJsonc).toEqual({ status: "skipped_comments" });
    expect(readFileSync(join(root, "home", ".omo", "omo.jsonc"), "utf8")).toBe(commented);
  });

  test("rejects unknown roles, traversal, and bad models", async () => {
    expect((await put("missing", "m")).status).toBe(404);
    expect((await put("..%2Fconfig", "m")).status).toBe(404);
    expect((await put("%E0%A4%A", "m")).status).toBe(400);
    expect((await put("explorer", "")).status).toBe(400);
    expect((await put("explorer", 7)).status).toBe(400);
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toBe(ROLE);
  });

  test("an unreadable omo.jsonc still lists the roles", async () => {
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": {} }\n');
    const nativeOpen = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((path, flags, mode) => {
      if (path === omoPath) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return nativeOpen(path, flags, mode);
    }) as typeof fs.openSync);
    try {
      const listed = await call("/api/codex-agent-roles");
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({
        lazycodex: DETECTED,
        omoJsonc: { state: "unreadable" },
        roles: [{ role: "explorer", model: "gpt-5.5", effort: null, omoJsoncModel: null }],
      });
      const saved = await put("explorer", "m3");
      expect(saved.body.toml).toEqual({ status: "written" });
      expect(saved.body.omoJsonc).toEqual({ status: "write_failed" });
    } finally {
      spy.mockRestore();
    }
  });

  test("refuses an invalid role file with 409 and keeps it unchanged", async () => {
    const rolePath = join(root, "codex", "agents", "explorer.toml");
    const broken = 'name = "explorer"\nmodel = "old\\q"\n';
    writeFileSync(rolePath, broken);
    const refused = await put("explorer", "m4");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("invalid_role_file");
    expect(readFileSync(rolePath, "utf8")).toBe(broken);
  });

  test("a filesystem failure is reported without its path", async () => {
    // getCodexHome() canonicalizes CODEX_HOME, so the route reads the real path. On macOS the
    // temp root sits under /var, a symlink to /private/var: matching the spelled path would never
    // fire, the write would succeed, and the test would prove nothing about the failure branch.
    const canonicalRoot = realpathSync.native(root);
    const rolePath = join(canonicalRoot, "codex", "agents", "explorer.toml");
    const nativeRead = fs.readFileSync;
    let denied = 0;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path === rolePath) {
        denied += 1;
        throw Object.assign(new Error(`EACCES: permission denied, open '${rolePath}'`), { code: "EACCES" });
      }
      return nativeRead(path, options as BufferEncoding);
    }) as never);
    try {
      const failed = await put("explorer", "m5");
      expect(denied).toBeGreaterThan(0);
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: "could not write the role file", code: "write_failed" });
      expect(JSON.stringify(failed.body)).not.toContain(root);
      expect(JSON.stringify(failed.body)).not.toContain(canonicalRoot);
    } finally {
      spy.mockRestore();
    }
  });
});
