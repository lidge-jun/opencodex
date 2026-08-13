import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("startup prompts after GitHub-star removal", () => {
  test("does not ship a package-manager postinstall lifecycle prompt", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.mjs");
    expect(pkg.files ?? []).not.toContain("AGENTS_INSTALL.md");
  });

  test("the GitHub star prompt and packaged consent file are gone", async () => {
    const cli = await readText("src/cli/index.ts");
    const service = await readText("src/service.ts");
    const notify = await readText("src/update/notify.ts");
    const agents = await readText("AGENTS.md");
    const readme = await readText("README.md");

    expect(cli).not.toContain("maybeShowStarPrompt");
    expect(cli).not.toContain("star-prompt");
    expect(service).not.toContain("maybeShowStarPrompt");
    expect(service).not.toContain("star-prompt");
    expect(notify).not.toContain("hasStarPromptRun");
    expect(notify).not.toContain("star-prompt");
    expect(agents).not.toContain("AGENTS_INSTALL.md");
    expect(readme).not.toContain("AGENTS_INSTALL.md");
    expect(readme).not.toContain("agent_consent_required");
  });

  test("ocx start still waits for the interactive update prompt before binding a port", async () => {
    const cli = await readText("src/cli/index.ts");
    const promptIndex = cli.indexOf("await maybeShowUpdatePrompt()");
    const portIndex = cli.indexOf("let port = await chooseListenPort");

    expect(cli).not.toContain("void maybeShowUpdatePrompt()");
    expect(promptIndex).toBeGreaterThan(-1);
    expect(portIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(portIndex);
  });

  test("ocx init offers the Codex autostart shim by default", async () => {
    const init = await readText("src/cli/init.ts");

    expect(init).toContain("Install Codex autostart shim? [Y/n]");
    expect(init).toContain("installCodexShim");
  });
});
