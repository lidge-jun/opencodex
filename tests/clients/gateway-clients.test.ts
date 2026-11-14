import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_CLIENTS, connectGatewayClient, disconnectGatewayClient, gatewayClientsStatus, resolveGatewayTarget,
  type GatewayClientContext, type GatewayTarget,
} from "../../src/integrations/gateway-clients";

const target: GatewayTarget = { url: "http://127.0.0.1:10100", apiKey: "opencodex-local" };
let root: string;
let ctx: GatewayClientContext;
const settings = () => join(ctx.home, ".antigravity", "settings.json");
const read = (p: string) => readFileSync(p, "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-gw-"));
  mkdirSync(join(root, "home"));
  ctx = { home: join(root, "home"), platform: "linux", env: { SHELL: "/bin/zsh" }, stateDir: join(root, "state"), adminSettingsPath: join(root, "admin_settings.json") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const USER_SETTINGS = `{\n    "theme": "dark",\n    "gateway": { "enabled": true, "url": "https://corp.example", "apiKey": "user-key", "customHeaders": { "x": "1" } },\n    "models": { "defaultModelId": "mine", "list": [{ "modelId": "mine" }] },\n    "other": [1, 2]\n}\n`;

describe("antigravity connector", () => {
  test("connect then disconnect restores a user file byte for byte, and re-connect is idempotent", () => {
    mkdirSync(join(ctx.home, ".antigravity"));
    writeFileSync(settings(), USER_SETTINGS);
    const a = GATEWAY_CLIENTS.antigravity;
    expect(a.connect(ctx, { ...target, defaultModel: "gemini-3" }).ok).toBe(true);
    const doc = JSON.parse(read(settings()));
    expect(doc.gateway).toEqual({ enabled: true, url: target.url, apiKey: "opencodex-local", wireProtocol: "openai" });
    expect(doc.models).toEqual({ defaultModelId: "gemini-3" });
    expect(GATEWAY_CLIENTS.antigravity.status(ctx, target).defaultModel).toBe("gemini-3");
    expect(doc.theme).toBe("dark");
    expect(read(settings())).toContain('\n    "theme"');
    const once = read(settings());
    expect(a.connect(ctx, { ...target, defaultModel: "gemini-3" }).changed).toBe(false);
    expect(read(settings())).toBe(once);
    expect(a.status(ctx, target).state).toBe("connected");
    const result = a.disconnect(ctx);
    expect(result.restore).toBe("exact");
    expect(read(settings())).toBe(USER_SETTINGS);
    expect(a.status(ctx, target).state).toBe("disconnected");
    expect(existsSync(join(ctx.stateDir, "gateway-clients", "antigravity.json"))).toBe(false);
  });

  test("an absent file and directory are removed again on disconnect", () => {
    const a = GATEWAY_CLIENTS.antigravity;
    a.connect(ctx, target);
    expect(existsSync(settings())).toBe(true);
    a.disconnect(ctx);
    expect(existsSync(join(ctx.home, ".antigravity"))).toBe(false);
  });

  test("a user edit after connect is kept and only the three stashed paths are restored", () => {
    mkdirSync(join(ctx.home, ".antigravity"));
    writeFileSync(settings(), USER_SETTINGS);
    const a = GATEWAY_CLIENTS.antigravity;
    a.connect(ctx, { ...target, defaultModel: "gemini-3" });
    const edited = JSON.parse(read(settings()));
    edited.theme = "light";
    edited.added = true;
    writeFileSync(settings(), JSON.stringify(edited, null, 4));
    const result = a.disconnect(ctx);
    expect(result.restore).toBe("path-wise");
    const doc = JSON.parse(read(settings()));
    expect(doc.theme).toBe("light");
    expect(doc.added).toBe(true);
    expect(doc.gateway.apiKey).toBe("user-key");
    expect(doc.models).toEqual({ defaultModelId: "mine", list: [{ modelId: "mine" }] });
  });

  test("a file with comments is refused and left untouched; disconnect without a record changes nothing", () => {
    mkdirSync(join(ctx.home, ".antigravity"));
    writeFileSync(settings(), '{\n  // note\n  "a": 1\n}\n');
    const a = GATEWAY_CLIENTS.antigravity;
    const result = a.connect(ctx, target);
    expect(result).toMatchObject({ ok: false, code: "unsupported-file" });
    expect(read(settings())).toBe('{\n  // note\n  "a": 1\n}\n');
    expect(a.disconnect(ctx)).toMatchObject({ ok: true, changed: false, restore: "none" });
  });

  test("admin_settings and env overrides surface in status without leaking secrets", () => {
    writeFileSync(ctx.adminSettingsPath!, JSON.stringify({ gateway: { url: "https://corp.example", apiKey: "SECRET" } }));
    ctx.env.AGY_LLM_GATEWAY_URL = "https://other.example/path?token=SECRET";
    const status = GATEWAY_CLIENTS.antigravity.status(ctx, target);
    expect(status.overrides.map(o => o.source).sort()).toEqual(["admin_settings", "env"]);
    expect(status.overrides.map(o => o.code).sort()).toEqual(["admin-gateway", "env-gateway"]);
    expect(status.notes.map(n => n.code)).toEqual(["restart-app", "no-google-sign-in", "agy-follows-app"]);
    expect(JSON.stringify(status)).not.toContain("SECRET");
  });
});

describe("agy connector", () => {
  test("zsh profile created when none exists, then removed with its file on disconnect", () => {
    const agy = GATEWAY_CLIENTS.agy;
    expect(agy.connect(ctx, target).ok).toBe(true);
    const zshrc = join(ctx.home, ".zshrc");
    expect(read(zshrc)).toContain("agy() { AGY_LLM_GATEWAY_URL='http://127.0.0.1:10100'");
    expect(agy.status(ctx, target).state).toBe("connected");
    expect(agy.disconnect(ctx).restore).toBe("exact");
    expect(existsSync(zshrc)).toBe(false);
  });

  test("existing CRLF profile gets a CRLF block, is replaced in place, and restores byte for byte", () => {
    const zshrc = join(ctx.home, ".zshrc");
    const original = "export A=1\r\nalias x=y\r\n";
    writeFileSync(zshrc, original);
    const agy = GATEWAY_CLIENTS.agy;
    agy.connect(ctx, target);
    const first = read(zshrc);
    expect(first).toContain("# >>> opencodex agy >>>\r\n");
    expect(first.replace(/\r\n/g, "").includes("\n")).toBe(false);
    agy.connect(ctx, { ...target, url: "http://127.0.0.1:10200" });
    expect(read(zshrc).match(/opencodex agy >>>/g)).toHaveLength(1);
    expect(agy.status(ctx, target).state).toBe("drifted");
    agy.disconnect(ctx);
    expect(read(zshrc)).toBe(original);
  });

  test("a profile edited after connect loses only the marked block", () => {
    const bashrc = join(ctx.home, ".bashrc");
    writeFileSync(bashrc, "echo hi\n");
    const agy = GATEWAY_CLIENTS.agy;
    agy.connect(ctx, target);
    writeFileSync(bashrc, `${read(bashrc)}echo later\n`);
    expect(agy.disconnect(ctx).restore).toBe("path-wise");
    expect(read(bashrc)).toBe("echo hi\n\necho later\n");
  });

  test("Windows writes PowerShell 7 profile and only an existing .bashrc", () => {
    const win: GatewayClientContext = { ...ctx, platform: "win32", env: {} };
    const agy = GATEWAY_CLIENTS.agy;
    agy.connect(win, target);
    const ps = join(win.home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    expect(read(ps)).toContain("Get-Command agy -CommandType Application");
    expect(existsSync(join(win.home, ".bashrc"))).toBe(false);
    agy.disconnect(win);
    expect(existsSync(join(win.home, "Documents"))).toBe(false);
  });
});

describe("target resolution and actions", () => {
  test("a bind that needs an admission token is refused before any file is written", () => {
    const config = { hostname: "100.64.0.9" } as Parameters<typeof resolveGatewayTarget>[0];
    expect(resolveGatewayTarget(config, 10100)).toMatchObject({ ok: false, code: "requires-admission-token" });
    expect(connectGatewayClient("antigravity", ctx, config, 10100)).toMatchObject({ ok: false });
    expect(existsSync(join(ctx.home, ".antigravity"))).toBe(false);
  });

  test("loopback resolves to a placeholder key and actions return status", () => {
    const config = {} as Parameters<typeof resolveGatewayTarget>[0];
    const outcome = connectGatewayClient("antigravity", ctx, config, 10100, "gemini-3");
    expect(outcome).toMatchObject({ ok: true, id: "antigravity", action: "connect", status: { state: "connected" } });
    expect(gatewayClientsStatus(ctx).map(s => s.id)).toEqual(["antigravity", "agy"]);
    expect(disconnectGatewayClient("antigravity", ctx)).toMatchObject({ ok: true, restore: "exact" });
  });
});
