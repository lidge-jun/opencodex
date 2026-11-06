import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRoleModelChanges, ROLE_HISTORY_MAX_BYTES, ROLE_HISTORY_MAX_ROWS } from "../../src/codex/role-model-history";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const saved = { CODEX_HOME: process.env.CODEX_HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const config = { port: 10100, providers: {}, defaultProvider: "openai" } as unknown as OcxConfig;
let root: string, home: string, dir: string, path: string;
const setting = (model: string) => ({ model, effort: null });
const line = (row: object) => `${JSON.stringify(row)}\n`;
const row = (batch: string, n = 1, model = "f") => ({ at: "2026-10-27T00:00:00.000Z", batch, n, codexHome: home, role: "explorer", before: setting("initial"), after: setting(model) });

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-role-history-recovery-")));
  home = join(root, "codex");
  dir = join(root, "ocx", "integrations");
  path = join(dir, "codex-agent-roles.jsonl");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, "agents"), { recursive: true });
  const plugin = join(home, "plugins", "cache", "sisyphuslabs", "omo", "5.1.1");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "lazycodex-install.json"), "{}");
  writeFileSync(join(home, "config.toml"), '[plugins."omo@sisyphuslabs"]\nenabled = true\n');
  for (const role of ["explorer", "librarian"]) writeFileSync(join(home, "agents", `${role}.toml`), 'model = "initial"\n');
  process.env.CODEX_HOME = home;
  process.env.OPENCODEX_HOME = join(root, "ocx");
  process.env.HOME = process.env.USERPROFILE = join(root, "user");
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTreeWithRetry(root);
});

async function put(role: string, body: object) {
  const url = new URL(`http://localhost/api/codex-agent-roles/${role}`);
  const response = (await handleManagementAPI(new ManagementRequest(url, { method: "PUT", body: JSON.stringify(body) }), url, config))!;
  return { status: response.status, body: await response.json() as { batch: string } };
}

test.each(["byte", "row"] as const)("Restore retains its interleaved source at the %s tail boundary", async boundary => {
  const started = await put("explorer", { model: "changed" });
  expect(started.status).toBe(200);
  const source = started.body.batch;
  let text = readFileSync(path, "utf8");
  const last = line({ ...row(source, 2, "changed"), role: "librarian" });
  if (boundary === "byte") {
    let index = 0;
    while (Buffer.byteLength(text + last) < ROLE_HISTORY_MAX_BYTES - 1500) text += line(row(`filler-${index++}`, 1, "f".repeat(200)));
    const pad = row("pad", 1, "");
    pad.after.model = "p".repeat(ROLE_HISTORY_MAX_BYTES - 64 - Buffer.byteLength(text + last + line(pad)));
    text += line(pad);
  } else {
    for (let index = 0; index < ROLE_HISTORY_MAX_ROWS - 2; index++) text += line({ ...row(`filler-${index}`), codexHome: "other" });
  }
  writeFileSync(path, text);
  expect((await put("librarian", { model: "changed", batch: source })).status).toBe(200);
  if (boundary === "byte") expect(statSync(path).size).toBe(ROLE_HISTORY_MAX_BYTES - 64);
  expect(listRoleModelChanges(home, 50, dir).filter(change => change.batch === source)).toHaveLength(2);
  const first = await put("explorer", { model: "initial", effort: null, restores: source });
  expect(first.status).toBe(200);
  expect(statSync(path).size).toBeLessThanOrEqual(ROLE_HISTORY_MAX_BYTES);
  expect(readFileSync(path, "utf8").trim().split("\n").length).toBeLessThanOrEqual(ROLE_HISTORY_MAX_ROWS);
  expect((await put("librarian", { model: "initial", effort: null, restores: source, batch: first.body.batch })).status).toBe(200);
  expect(readFileSync(join(home, "agents", "librarian.toml"), "utf8")).toContain('model = "initial"');
});

test("protected source bytes displace unrelated batches within the read budget", async () => {
  const started = await put("explorer", { model: "changed" });
  const source = started.body.batch;
  const sourceRows = Array.from({ length: 50 }, (_, index) => line(row(source, index + 1, "s".repeat(3500)))).join("");
  let text = sourceRows;
  let index = 0;
  while (Buffer.byteLength(text) < ROLE_HISTORY_MAX_BYTES - 12000) text += line(row(`filler-${index++}`, 1, "f".repeat(500)));
  writeFileSync(path, text);
  writeFileSync(join(home, "agents", "explorer.toml"), `model = "${"c".repeat(15000)}"\n`);
  expect((await put("explorer", { model: "initial", effort: null, restores: source })).status).toBe(200);
  expect(statSync(path).size).toBeLessThanOrEqual(ROLE_HISTORY_MAX_BYTES);
  expect(listRoleModelChanges(home, 1000, dir).filter(change => change.batch === source)).toHaveLength(50);
});

test.each(["torn", "complete"])("restart after an unterminated %s suffix leaves a new Apply all batch joinable", async suffix => {
  const old = await put("explorer", { model: "before-restart" });
  const complete = readFileSync(path, "utf8");
  // Disk state left by an interrupted process; no in-memory batch state survives a restart.
  writeFileSync(path, suffix === "torn" ? `${complete}{"at":"interrupted` : complete.trimEnd());
  const first = await put("explorer", { model: "apply-a" });
  expect(first.status).toBe(200);
  expect(typeof first.body.batch).toBe("string");
  expect((await put("librarian", { model: "apply-b", batch: first.body.batch })).status).toBe(200);
  const history = listRoleModelChanges(home, 50, dir);
  expect(history.filter(change => change.batch === first.body.batch)).toHaveLength(2);
  expect(history.filter(change => change.batch === old.body.batch)).toHaveLength(1);
  expect(readFileSync(join(home, "agents", "librarian.toml"), "utf8")).toContain('model = "apply-b"');
});
