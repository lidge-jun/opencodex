import { describe, expect, test } from "bun:test";
import { configSchema } from "../../src/config/schema/config-schema";
import { validateConfigCandidate, configDiagnosticsFromRaw } from "../../src/config/diagnostics";
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
    for (const chatgptDesktop of [null, true, [], "yes", { appServerShim: "true" }, { appServerShim: true, unblockSend: true }, { port: 1234 }]) {
      const candidate = { ...base, port: 12345, chatgptDesktop };
      const parsed = configSchema.parse(candidate);
      expect(parsed.chatgptDesktop).toBeUndefined();
      expect(parsed.port).toBe(12345);
      const write = validateConfigCandidate(candidate);
      expect(write.ok).toBe(false);
      if (!write.ok) expect(write.error).toContain("chatgptDesktop");
    }
  });
  test("enabled shim warns on other platforms", () => {
    const diagnostics = configDiagnosticsFromRaw(JSON.stringify({ ...base, chatgptDesktop: { appServerShim: true } }));
    expect(diagnostics.error).toBeNull();
    if (process.platform !== "darwin") expect(diagnostics.warnings?.join(" ")).toContain("macOS only");
  });
  test("all operations reject non-macOS without app side effects", async () => {
    for (const sub of ["launch", "restore", "status"]) expect(await handleChatgptCommand([sub], "linux")).toBe(1);
  });
  test("hidden self-test works and rejects extra options", async () => {
    expect(await handleInternalCommand(["chatgpt-app-server-filter", "--self-test"])).toBe(0);
    expect(await handleInternalCommand(["chatgpt-app-server-filter", "--invalid"])).toBe(2);
  });
});
