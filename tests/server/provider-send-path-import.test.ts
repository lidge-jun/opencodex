import { expect, test } from "bun:test";
import { repoRoot } from "../helpers/repo-root";

// A prior config import can hide an initialization cycle. Keep the management
// boundary first in a fresh module cache, just as an isolated CI batch loads it.
test("management send-path validation initializes before the config facade", () => {
  const child = Bun.spawnSync([
    process.execPath,
    "--eval",
    `
      const { providerManagementConfigError } = await import("./src/server/auth-cors.ts");
      const { getDefaultConfig } = await import("./src/config.ts");
      const provider = {
        adapter: "openai-chat", baseUrl: "https://example.test/v1",
        apiKey: "fixture-key", models: ["fixture-model"], responsesPath: 42,
      };
      const error = providerManagementConfigError("fixture", provider);
      if (!error?.includes("responsesPath must be a string")) throw new Error(String(error));
      if (getDefaultConfig().port !== 10100) throw new Error("config schema did not initialize");
      console.log("management and config initialized");
    `,
  ], { cwd: repoRoot(), env: process.env, timeout: 20_000 });
  expect(new TextDecoder().decode(child.stderr)).toBe("");
  expect(child.exitCode).toBe(0);
  expect(new TextDecoder().decode(child.stdout).trim()).toBe("management and config initialized");
}, 25_000);
