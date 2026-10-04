import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync, readFileSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitUpdateRestartChild, UPDATE_RESTART_CHILD_ENV } from "../../src/cli/update-restart-child";
import { assertUpdateRestartConfiguration, readUpdateRestartHome, assertUpdateRestartHome } from "../../src/cli/update-restart-home";

const roots: string[] = [];
const initial = { ocx: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME, state: process.env.OPENCODEX_SERVICE_STATE_PATH };
afterEach(() => {
  for (const [key, value] of [["OPENCODEX_HOME", initial.ocx], ["CODEX_HOME", initial.codex], ["OPENCODEX_SERVICE_STATE_PATH", initial.state]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
  const root = mkdtempSync(join(tmpdir(), "ocx-update-home-")); roots.push(root);
  const config = join(root, "ocx"); const codex = join(root, "codex"); mkdirSync(config); mkdirSync(codex);
  process.env.OPENCODEX_HOME = config; process.env.CODEX_HOME = codex;
  delete process.env.OPENCODEX_SERVICE_STATE_PATH;
  return { root, config, codex };
}
test("physical home identity detects same-path directory replacement", () => {
  const h = home(); const captured = readUpdateRestartHome(); assertUpdateRestartHome(captured);
  renameSync(h.config, h.config + "-old"); mkdirSync(h.config);
  expect(() => assertUpdateRestartHome(captured)).toThrow();
});
test("canonical aliases identify the same directory", () => {
  const h = home(); const captured = readUpdateRestartHome();
  const alias = join(h.root, "alias"); symlinkSync(h.config, alias, process.platform === "win32" ? "junction" : "dir");
  process.env.OPENCODEX_HOME = alias;
  expect(readUpdateRestartHome()).toEqual(captured);
});
test("unreadable ownership state fails closed", () => {
  const h = home(); writeFileSync(join(h.config, "service-state.json"), "{bad");
  expect(() => readUpdateRestartHome()).toThrow();
});

test("busy child lease leaves config bytes, permissions and files unchanged", () => {
  const h = home(); const configPath = join(h.config, "config.json");
  writeFileSync(configPath, '{"hostname":"127.0.0.1"}\n'); chmodSync(configPath, 0o644);
  const marker = { home: readUpdateRestartHome(), version: "2.77.0", port: 10100, hostname: "127.0.0.1", deadlineAt: Date.now() + 5000 };
  const before = { bytes: readFileSync(configPath, "utf8"), mode: statSync(configPath).mode, files: readdirSync(h.config) };
  let acquired = false;
  expect(() => admitUpdateRestartChild(["start", "--port", "10100"], {
    env: { [UPDATE_RESTART_CHILD_ENV]: JSON.stringify(marker) }, version: () => "2.77.0",
    acquire: () => { acquired = true; throw new Error("lease busy"); },
  })).toThrow("lease busy");
  expect(acquired).toBe(true);
  expect({ bytes: readFileSync(configPath, "utf8"), mode: statSync(configPath).mode, files: readdirSync(h.config) }).toEqual(before);
});

test("production parent guard rejects client and hostname drift before stop", () => {
  const h = home(); const config = join(h.config, "config.json");
  writeFileSync(config, JSON.stringify({ hostname: "127.0.0.1" }));
  expect(() => assertUpdateRestartConfiguration("127.0.0.1")).not.toThrow();
  writeFileSync(config, JSON.stringify({ hostname: "::1" }));
  expect(() => assertUpdateRestartConfiguration("127.0.0.1")).toThrow();
  writeFileSync(config, JSON.stringify({ hostname: "127.0.0.1", runtimeRole: "client" }));
  expect(() => assertUpdateRestartConfiguration("127.0.0.1")).toThrow();
});
test("production child checker refuses client and competing runtime before acquisition", () => {
  for (const kind of ["client", "runtime", "malformed-runtime"] as const) {
    const h = home();
    writeFileSync(join(h.config, "config.json"), JSON.stringify({ hostname: "127.0.0.1", ...(kind === "client" ? { runtimeRole: "client" } : {}) }));
    if (kind !== "client") writeFileSync(join(h.config, "runtime-port.json"), kind === "runtime" ? JSON.stringify({ pid: process.pid + 1, port: 10100 }) : "{");
    const marker = { home: readUpdateRestartHome(), version: "2.77.0", port: 10100, hostname: "127.0.0.1", deadlineAt: Date.now() + 5000 };
    let acquired = false;
    expect(() => admitUpdateRestartChild(["start", "--port", "10100"], {
      env: { [UPDATE_RESTART_CHILD_ENV]: JSON.stringify(marker) }, version: () => "2.77.0",
      acquire: () => { acquired = true; return { release() {} }; },
    })).toThrow();
    expect(acquired).toBe(false);
  }
});
