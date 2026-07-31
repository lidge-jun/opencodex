import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("startup star prompt", () => {
  test("does not ship a package-manager postinstall lifecycle prompt", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.mjs");
  });

  test("ocx start waits for the interactive prompt before sync/injection", async () => {
    const cli = await readText("src/cli/index.ts");
    const promptIndex = cli.indexOf("await maybeShowStarPrompt()");
    const syncIndex = cli.indexOf("await syncModelsToCodex(port)");

    expect(cli).not.toContain("void maybeShowStarPrompt()");
    expect(promptIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(syncIndex);
  });

  test("GitHub star prompt asks with an explicit Yes/No selector and names gh", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    expect(prompt).toContain("interactiveConfirm");
    expect(prompt).toContain("defaultYes: true");
    expect(prompt).toContain("Star it on GitHub (via gh)?");
  });

  test("an agent driving ocx is told to ask the user instead of answering", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");
    const guardIndex = prompt.indexOf("if (isAgentDriven()) {");
    const markerIndex = prompt.indexOf("writeFileSync(marker");

    expect(guardIndex).toBeGreaterThan(-1);
    // The guard must precede the marker write, otherwise an agent run would
    // consume the one-time prompt the user never saw.
    expect(guardIndex).toBeLessThan(markerIndex);
    // The agent path relays the question rather than selecting a choice.
    expect(prompt).toContain("printAgentDeferral");
    expect(prompt).toContain("do not answer this yourself");
    expect(prompt).toContain("Ask the user whether to star");
    expect(prompt).not.toMatch(/isAgentDriven\(\)[\s\S]{0,80}starRepo\(\)/);
  });

  test("the star prompt only appears when gh can actually star", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    // The invariant is that the prompt is gated on a real `gh auth status`
    // check, not that the call is spelled a particular way. The call now goes
    // through the shared Windows launcher (a bare `gh` spawn stalls on a `.cmd`
    // shim), so assert the arguments and the resolver rather than the literal.
    expect(prompt).toContain('ghInvocation(["auth", "status"])');
    expect(prompt).toContain('commandInvocation("gh"');
    expect(prompt).toContain("if (!ghAvailable()) return;");
  });

  test("declining the star prompt does not steer the agent afterwards", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    // A "No" ends the feature: no persisted decline state, and nothing injected
    // into any model prompt to keep nudging the user later.
    expect(prompt).toContain("if (!yes) return;");
    expect(prompt).not.toMatch(/declined/i);
    expect(prompt).not.toMatch(/system\s*prompt|encourage|remind the user/i);
  });

  test("ocx init offers the Codex autostart shim by default", async () => {
    const init = await readText("src/cli/init.ts");

    expect(init).toContain("Install Codex autostart shim? [Y/n]");
    expect(init).toContain("installCodexShim");
  });

  test("ocx service install gets the prompt too, after the service is up", async () => {
    const service = await readText("src/service.ts");
    const installIndex = service.indexOf("await ops.install()");
    const promptIndex = service.indexOf("await maybeShowStarPrompt()");

    expect(installIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeGreaterThan(-1);
    // Installing the service is the real work: it must succeed and report before
    // the prompt appears, so a declined star never looks like a failed install.
    expect(installIndex).toBeLessThan(promptIndex);
    // Only the hand-typed install path prompts. Other subcommands stay silent.
    expect(service.match(/maybeShowStarPrompt\(\)/g) ?? []).toHaveLength(1);
  });

  test("the service-installed proxy still cannot prompt", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    // The supervised child always carries OCX_SERVICE=1; that guard is what makes
    // the `service install` call site the only interactive moment for those users.
    expect(prompt).toContain("if (process.env.OCX_SERVICE ||");
  });
});
