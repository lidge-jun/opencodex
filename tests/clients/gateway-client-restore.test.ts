import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_CLIENTS, type GatewayClientContext } from "../../src/integrations/gateway-clients";
import * as gatewayIO from "../../src/integrations/gateway-clients/io";

const target = { url: "http://127.0.0.1:10100", apiKey: "opencodex-local", defaultModel: "managed-model" };
const start = "# >>> opencodex agy >>>";
const end = "# <<< opencodex agy <<<";
let root: string;
let ctx: GatewayClientContext;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-gw-restore-")));
  ctx = { home: join(root, "home"), platform: "linux", env: { SHELL: "/bin/zsh" }, stateDir: join(root, "state") };
  mkdirSync(join(ctx.home, ".antigravity"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (path: string) => readFileSync(path, "utf8");
const record = (id: string) => join(ctx.stateDir, "gateway-clients", id + ".json");
const settings = () => join(ctx.home, ".antigravity", "settings.json");
const originalSettings = {
  theme: "dark",
  gateway: { enabled: false },
  models: { defaultModelId: "mine", list: [{ modelId: "mine" }] },
};

const markerDamage = [
  ["a missing closing marker", (text: string) => text.replace(end, "")],
  ["a missing opening marker", (text: string) => text.replace(start, "")],
  ["both markers missing", (text: string) => text.replace(start, "").replace(end, "")],
  ["an inline closing marker", (text: string) => text.replace(end, "# unrelated " + end)],
  ["nested markers", (text: string) => text.replace(end, start + "\necho inside-another-block\n" + end)],
  ["duplicate marker pairs", (text: string) => text + text.slice(text.indexOf(start))],
] as const;

test.each(markerDamage)("agy refuses to disconnect or reconnect a profile with %s", (_label, damage) => {
  const agy = GATEWAY_CLIENTS.agy;
  const bash = join(ctx.home, ".bashrc");
  const zsh = join(ctx.home, ".zshrc");
  writeFileSync(bash, "# bash\n");
  writeFileSync(zsh, "# zsh\n");
  expect(agy.connect(ctx, target).ok).toBe(true);
  const connectedBash = read(bash);
  const connectedZsh = read(zsh);
  const afterBlock = "export KEEP_ME=1\n";
  const damaged = damage(connectedZsh) + afterBlock;
  writeFileSync(zsh, damaged);
  const saved = read(record("agy"));

  expect(agy.disconnect(ctx)).toMatchObject({
    ok: false, code: "agy-profile-restore-required", profilePath: "~/.zshrc", changed: false, changedFiles: [],
  });
  expect(read(bash)).toBe(connectedBash);
  expect(read(zsh)).toBe(damaged);
  expect(read(record("agy"))).toBe(saved);
  expect(agy.status(ctx, target).state).toBe("drifted");

  expect(agy.connect(ctx, { ...target, url: "http://127.0.0.1:10200" })).toMatchObject({
    ok: false, code: "agy-profile-restore-required", profilePath: "~/.zshrc", changed: false, changedFiles: [],
  });
  expect(read(bash)).toBe(connectedBash);
  expect(read(zsh)).toBe(damaged);
  expect(read(record("agy"))).toBe(saved);

  writeFileSync(zsh, connectedZsh + afterBlock);
  expect(agy.disconnect(ctx)).toMatchObject({ ok: true, restore: "path-wise" });
  expect(read(bash)).toBe("# bash\n");
  expect(read(zsh)).toBe("# zsh\n\n" + afterBlock);
  expect(existsSync(record("agy"))).toBe(false);
});

test("agy refuses a first connect to a profile with reversed markers", () => {
  const profile = join(ctx.home, ".zshrc");
  const original = [end, "# profile", start].join("\r\n");
  writeFileSync(profile, original);

  expect(GATEWAY_CLIENTS.agy.connect(ctx, target)).toMatchObject({
    ok: false, code: "unsupported-file", changed: false, changedFiles: [],
  });
  expect(read(profile)).toBe(original);
  expect(existsSync(record("agy"))).toBe(false);
});

test("agy retries an interrupted path-wise restore without rewriting the restored profile", () => {
  const agy = GATEWAY_CLIENTS.agy;
  const bash = join(ctx.home, ".bashrc");
  const zsh = join(ctx.home, ".zshrc");
  writeFileSync(bash, "# bash\n");
  writeFileSync(zsh, "# zsh\n");
  expect(agy.connect(ctx, target).ok).toBe(true);
  const edit = "export KEEP_ME=1\n";
  writeFileSync(bash, read(bash) + edit);
  writeFileSync(zsh, read(zsh) + edit);

  const write = gatewayIO.writeClientFile;
  const fault = spyOn(gatewayIO, "writeClientFile").mockImplementation((...args) => {
    if (args[1] === zsh) throw new Error("fixture interrupted the second restore");
    write(...args);
  });
  try {
    expect(agy.disconnect(ctx)).toMatchObject({ ok: false, code: "io-error", changedFiles: [bash] });
  } finally {
    fault.mockRestore();
  }
  expect(read(bash)).toBe("# bash\n\n" + edit);
  expect(existsSync(record("agy"))).toBe(true);

  expect(agy.disconnect(ctx)).toMatchObject({ ok: true, restore: "path-wise", changedFiles: [zsh] });
  expect(read(bash)).toBe("# bash\n\n" + edit);
  expect(read(zsh)).toBe("# zsh\n\n" + edit);
  expect(existsSync(record("agy"))).toBe(false);
});

test("Antigravity restores reordered gateway keys and preserves unrelated edits", () => {
  const app = GATEWAY_CLIENTS.antigravity;
  writeFileSync(settings(), JSON.stringify(originalSettings));
  expect(app.connect(ctx, target).ok).toBe(true);
  const connected = JSON.parse(read(settings()));
  const gateway = Object.fromEntries(Object.entries(connected.gateway).reverse());
  writeFileSync(settings(), JSON.stringify({ ...connected, gateway, theme: "light" }));

  expect(app.disconnect(ctx)).toMatchObject({ ok: true, restore: "path-wise" });
  expect(JSON.parse(read(settings()))).toEqual({ ...originalSettings, theme: "light" });
  expect(existsSync(record("antigravity"))).toBe(false);
});

test.each(["gateway", "models.defaultModelId", "models.list"])(
  "Antigravity refuses to restore a changed %s and keeps the settings and record",
  path => {
    const app = GATEWAY_CLIENTS.antigravity;
    writeFileSync(settings(), JSON.stringify(originalSettings));
    expect(app.connect(ctx, target).ok).toBe(true);
    const saved = read(record("antigravity"));
    const applied = JSON.parse(read(settings()));
    const edited = structuredClone(applied);
    if (path === "gateway") edited.gateway.url = "https://custom.example";
    if (path === "models.defaultModelId") edited.models.defaultModelId = "another-model";
    if (path === "models.list") edited.models.list = [{ modelId: "another-model" }];
    const changed = JSON.stringify({ ...edited, theme: "light" });
    writeFileSync(settings(), changed);

    expect(app.disconnect(ctx)).toMatchObject({
      ok: false, code: "unsupported-file", changed: false, changedFiles: [],
      message: expect.stringContaining(path),
    });
    expect(read(settings())).toBe(changed);
    expect(read(record("antigravity"))).toBe(saved);

    writeFileSync(settings(), JSON.stringify({ ...applied, theme: "light" }));
    expect(app.disconnect(ctx)).toMatchObject({ ok: true, restore: "path-wise" });
    expect(JSON.parse(read(settings()))).toEqual({ ...originalSettings, theme: "light" });
    expect(existsSync(record("antigravity"))).toBe(false);
  },
);
