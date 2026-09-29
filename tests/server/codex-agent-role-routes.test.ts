import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  root = mkdtempSync(join(tmpdir(), "ocx-agent-role-routes-"));
  mkdirSync(join(root, "codex", "agents"), { recursive: true });
  mkdirSync(join(root, "home", ".omo"), { recursive: true });
  writeFileSync(join(root, "codex", "agents", "explorer.toml"), ROLE);
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
    writeFileSync(join(root, "home", ".omo", "omo.jsonc"), '{ "codex": {} }\n');
    expect((await call("/api/codex-agent-roles")).body).toEqual({
      roles: [{ role: "explorer", model: "gpt-5.5", omoModel: null }],
      omo: { state: "present" },
    });
    const saved = await put("explorer", "xai/grok-4.5");
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true, role: "explorer", model: "xai/grok-4.5", toml: { status: "written" }, omo: { status: "written" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toBe(ROLE.replace('model = "gpt-5.5"', 'model = "xai/grok-4.5"'));
    expect((await call("/api/codex-agent-roles")).body.roles).toEqual([{ role: "explorer", model: "xai/grok-4.5", omoModel: "xai/grok-4.5" }]);
  });

  test("reports an absent or commented omo.jsonc without writing it", async () => {
    expect((await put("explorer", "m1")).body.omo).toEqual({ status: "absent" });
    const commented = '{ // mine\n  "codex": {} }\n';
    writeFileSync(join(root, "home", ".omo", "omo.jsonc"), commented);
    expect((await call("/api/codex-agent-roles")).body.omo).toEqual({ state: "comments" });
    const result = await put("explorer", "m2");
    expect(result.body.toml).toEqual({ status: "written" });
    expect(result.body.omo).toEqual({ status: "skipped_comments" });
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
    writeFileSync(omoPath, '{ "codex": {} }\n');
    const nativeRead = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path === omoPath) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return nativeRead(path, options as BufferEncoding);
    }) as never);
    try {
      const listed = await call("/api/codex-agent-roles");
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({
        roles: [{ role: "explorer", model: "gpt-5.5", omoModel: null }],
        omo: { state: "unreadable" },
      });
      const saved = await put("explorer", "m3");
      expect(saved.body.toml).toEqual({ status: "written" });
      expect(saved.body.omo).toEqual({ status: "write_failed" });
    } finally {
      spy.mockRestore();
    }
  });
});
