import { describe, expect, spyOn, test } from "bun:test";
import { configSchema } from "../../src/config/schema/config-schema";
import { validateConfigCandidate, configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { warnDegradedTopLevelOptIns } from "../../src/config/load-degrade";
import { chatgptDesktopConfigIssue } from "../../src/config/schema/leaf-validators";
import { handleChatgptCommand } from "../../src/cli/chatgpt-command";
import { handleInternalCommand } from "../../src/cli/internal-command";

const base = { providers: { xai: { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1" } }, defaultProvider: "xai" };
describe("experimental ChatGPT desktop config", () => {
  test("absent and false are off; true is opt-in", () => {
    expect(configSchema.parse(base).chatgptDesktop).toBeUndefined();
    for (const appServerShim of [undefined, false, true]) {
      const parsed = configSchema.parse({ ...base, chatgptDesktop: { appServerShim } });
      expect(parsed.chatgptDesktop?.appServerShim === true).toBe(appServerShim === true);
      expect(validateConfigCandidate({ ...base, chatgptDesktop: { appServerShim } }).ok).toBe(true);
    }
  });
  test("malformed reads disable only the experimental feature; writes reject unknown and malformed fields", () => {
    for (const chatgptDesktop of [null, true, [], "yes", { appServerShim: "true" }, { appServerShim: true, unblocksend: true }, { port: 0 }]) {
      const candidate = { ...base, port: 12345, chatgptDesktop };
      const parsed = configSchema.parse(candidate);
      expect(parsed.chatgptDesktop).toBeUndefined();
      expect(parsed.port).toBe(12345);
      const write = validateConfigCandidate(candidate);
      expect(write.ok).toBe(false);
      if (!write.ok) expect(write.error).toContain("chatgptDesktop");
    }
  });
  test("a block the read path drops says why instead of reading as silently off", () => {
    // A key left over from an older or ported config is the usual cause (#6196).
    const leftover = { ...base, chatgptDesktop: { appServerShim: true, unblockPort: true } };
    expect(configSchema.parse(leftover).chatgptDesktop).toBeUndefined();
    expect(chatgptDesktopConfigIssue(leftover)).toContain("unblockPort");
    expect(chatgptDesktopConfigIssue({ ...base, chatgptDesktop: { appServerShim: "true" } })).toContain("chatgptDesktop.appServerShim");
    for (const fine of [base, { ...base, chatgptDesktop: { appServerShim: true } }, { ...base, chatgptDesktop: {} }, null, []]) {
      expect(chatgptDesktopConfigIssue(fine)).toBeNull();
    }
    const diagnostics = configDiagnosticsFromRaw(JSON.stringify(leftover));
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.warnings?.join(" ")).toContain("unblockPort");
    expect(diagnostics.warnings?.join(" ")).toContain("the whole chatgptDesktop block is ignored");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnDegradedTopLevelOptIns(leftover, configSchema.parse(leftover));
      expect(warn.mock.calls.map(call => String(call[0])).join(" ")).toContain("unblockPort");
      warn.mockClear();
      warnDegradedTopLevelOptIns(base, configSchema.parse(base));
      expect(warn.mock.calls.length).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
  test("salvaged configs retain the dropped desktop block reason and fallback error", () => {
    const candidate = { ...base, port: 12345, routingProfiles: { bad: { candidates: [] } } };
    const fallback = configDiagnosticsFromRaw(JSON.stringify(candidate));
    expect(fallback.source).toBe("fallback");
    expect(fallback.error).toContain("routingProfiles.bad");
    for (const chatgptDesktop of [{ appServerShim: true, unblockPort: true }, { appServerShim: "true" }]) {
      const normal = configDiagnosticsFromRaw(JSON.stringify({ ...base, chatgptDesktop }));
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify({ ...candidate, chatgptDesktop }));
      expect(normal.warnings?.join(" ")).toContain("the whole chatgptDesktop block is ignored");
      expect(diagnostics.warnings).toEqual(normal.warnings);
      expect(diagnostics.source).toBe(fallback.source);
      expect(diagnostics.error).toBe(fallback.error);
      expect(diagnostics.config.chatgptDesktop).toBeUndefined();
      expect(diagnostics.config.providers).toEqual(fallback.config.providers);
      expect(diagnostics.config.providers.xai).toEqual(base.providers.xai);
      expect(diagnostics.config.port).toBe(12345);
      expect(diagnostics.config.routingProfiles?.bad).toBeUndefined();
    }
  });
  test("enabled shim warns on other platforms", () => {
    const diagnostics = configDiagnosticsFromRaw(JSON.stringify({ ...base, chatgptDesktop: { appServerShim: true } }));
    expect(diagnostics.error).toBeNull();
    if (process.platform !== "darwin") expect(diagnostics.warnings?.join(" ")).toContain("macOS only");
  });
  for (const unblockSend of [undefined, false]) {
    test(`PAC fallback warns without enabling send unblock when unblockSend is ${unblockSend}`, () => {
      const chatgptDesktop = { pacFallback: true, ...(unblockSend === undefined ? {} : { unblockSend }) };
      const candidate = { ...base, port: 12345, chatgptDesktop };
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify(candidate));
      expect(diagnostics.warnings?.join(" ")).toContain("chatgptDesktop.pacFallback requires chatgptDesktop.unblockSend");
      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.config.chatgptDesktop).toEqual(chatgptDesktop);
      expect(diagnostics.config.providers.xai).toEqual(base.providers.xai);
      expect(diagnostics.config.defaultProvider).toBe(base.defaultProvider);
      expect(diagnostics.config.port).toBe(12345);
      expect(validateConfigCandidate(candidate).ok).toBe(true);
    });
  }
  test("enabled send unblock and disabled PAC fallback do not warn about an inactive PAC", () => {
    for (const chatgptDesktop of [{ pacFallback: true, unblockSend: true }, { pacFallback: false }, { pacFallback: false, unblockSend: false }]) {
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify({ ...base, chatgptDesktop }));
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.config.chatgptDesktop).toEqual(chatgptDesktop);
      expect(diagnostics.warnings?.some(warning => warning.includes("chatgptDesktop.pacFallback")) ?? false).toBe(false);
      if (chatgptDesktop.unblockSend === true && process.platform !== "darwin") {
        expect(diagnostics.warnings?.join(" ")).toContain("chatgptDesktop.unblockSend is experimental and macOS only");
      }
    }
  });
  test("invalid desktop leaves warn only about the dropped block rather than an inactive PAC", () => {
    for (const chatgptDesktop of [{ pacFallback: true, unblockSend: "true" }, { pacFallback: true, unknown: true }, { pacFallback: "true" }]) {
      const candidate = { ...base, chatgptDesktop };
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify(candidate));
      expect(diagnostics.config.chatgptDesktop).toBeUndefined();
      expect(diagnostics.config.providers.xai).toEqual(base.providers.xai);
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.warnings?.join(" ")).toContain("the whole chatgptDesktop block is ignored");
      expect(diagnostics.warnings?.some(warning => warning.includes("requires chatgptDesktop.unblockSend")) ?? false).toBe(false);
      expect(validateConfigCandidate(candidate).ok).toBe(false);
    }
  });
  test("all operations reject non-macOS without app side effects", async () => {
    for (const sub of ["launch", "restore", "status", "install-watcher", "uninstall-watcher"]) expect(await handleChatgptCommand([sub], "linux")).toBe(1);
  });
  test("unexpected watcher arguments are rejected before app side effects", async () => {
    expect(await handleChatgptCommand(["install-watcher", "--unknown"], "darwin")).toBe(64);
    expect(await handleChatgptCommand(["uninstall-watcher", "--yes"], "darwin")).toBe(64);
  });
  test("hidden self-test works and rejects extra options", async () => {
    expect(await handleInternalCommand(["chatgpt-app-server-filter", "--self-test"])).toBe(0);
    expect(await handleInternalCommand(["chatgpt-app-server-filter", "--invalid"])).toBe(2);
  });
});
