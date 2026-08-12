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
    expect(prompt).toContain("Do not answer this on their behalf");
    expect(prompt).toContain("Ask the user once, in the reply that follows this start, whether to star");
    // The deferral must name the concrete command the agent may run only after a
    // yes, so relaying the question does not turn into guesswork.
    expect(prompt).toContain("gh api -X PUT /user/starred/");
    expect(prompt).not.toMatch(/isAgentDriven\(\)[\s\S]{0,80}starRepo\(\)/);
  });

  test("the relayed question is a real choice asked once, never decided by silence", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    // The failure this guards against is an agent softening the question into a
    // throwaway aside, then treating the user's non-answer as a decision. A
    // non-answer settles nothing: silence is deferred, never a Yes, never a No.
    expect(prompt).toContain(`"Star ${"${REPO}"}? Yes / No"`);
    expect(prompt).toMatch(/soft aside/);
    expect(prompt).toContain("silence is deferred, never a");
    expect(prompt).toContain("Yes and never a recorded No");
    // Issue #879: the relay is bounded. The agent asks once; it is the CLI that
    // re-arms on a later version, not the agent repeating every reply.
    expect(prompt).toContain("Do NOT repeat the question in later");
    expect(prompt).toContain("at most once per opencodex version");
  });

  test("the agent deferral is bounded by a .star-deferred record, never the marker", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    // The agent branch must consult the deferral record before printing, and
    // must still never write the one-time .star-prompted marker.
    expect(prompt).toContain(`".star-deferred"`);
    const checkIndex = prompt.indexOf("if (isDeferralCurrent(");
    const printIndex = prompt.indexOf("printAgentDeferral();");
    expect(checkIndex).toBeGreaterThan(-1);
    expect(printIndex).toBeGreaterThan(checkIndex);
    // hasStarPromptRun() (consumed by update/notify.ts's first-run yield) reads
    // only the real marker; the deferral record must not leak into it.
    const fnStart = prompt.indexOf("export function hasStarPromptRun");
    const fnEnd = prompt.indexOf("}", prompt.indexOf("return existsSync", fnStart));
    expect(prompt.slice(fnStart, fnEnd)).toContain("MARKER");
    expect(prompt.slice(fnStart, fnEnd)).not.toContain("DEFERRAL");
  });

  test("the deferral is folded, because only the agent is reading it", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    // An agent-driven start means no human is watching this stream, so the loud
    // form spent ~22 lines of startup output on nobody. The instruction still has
    // to reach the agent verbatim, hence a fold rather than a truncation.
    expect(prompt).toContain("<details>");
    expect(prompt).toContain("</details>");
    expect(prompt).toMatch(/<summary>Agent: relay this question/);
    // The visible line stays dim and single: it is a pointer, not the message.
    expect(prompt).toMatch(/prompt was deferred to you/);
    // The body must remain inside the fold — collapsing it must never become
    // dropping it, which would silently decide the user's account for them.
    const foldStart = prompt.indexOf("<details>");
    const foldEnd = prompt.indexOf("</details>");
    const folded = prompt.slice(foldStart, foldEnd);
    expect(folded).toContain("Do not answer this on their behalf");
    expect(folded).toContain("gh api -X PUT /user/starred/");
    expect(folded).toContain("silence is deferred");
  });

  test("the management star endpoint refuses agent callers too", async () => {
    const routes = await readText("src/server/management/sidebar-routes.ts");

    // The CLI deferral is worthless if an agent can reach the same write over
    // HTTP: it runs on the user's machine and can read the admin token from disk.
    expect(routes).toContain("agent_consent_required");
    expect(routes).toContain("hasBrowserSessionEvidence");
    // The requirement is UNCONDITIONAL. Gating it on isAgentDriven() reads the
    // server's environment, not the caller's, so a service-run proxy (no agent
    // markers) accepted a raw-token star from any agent on the machine.
    expect(routes).toMatch(/if\s*\(!hasBrowserSessionEvidence\(ctx\)\)/);
    expect(routes).not.toMatch(/isAgentDriven\(\)\s*&&/);
    // And that evidence must be the authenticating CREDENTIAL, never a request
    // header: the admin token is readable by anything running as the user, so a
    // header-shaped check is forgeable by the exact caller this guard refuses.
    expect(routes).toMatch(/principal === "gui-session"/);
    expect(routes).not.toMatch(/hasBrowserSessionEvidence[\s\S]*?headers\.get\("x-opencodex-csrf-token"\)/);
  });

  test("the consent rule is written down where agents and users read it", async () => {
    // The normative rule lives in AGENTS_INSTALL.md, read by an agent that
    // INSTALLS or RUNS opencodex. It was moved out of AGENTS.md because that
    // file is loaded for every code change, and the consent boundary applies to
    // none of them — a development-facing file is the wrong trigger surface.
    const install = await readText("AGENTS_INSTALL.md");
    const agents = await readText("AGENTS.md");
    const readme = await readText("README.md");

    // The full contract: the refusal code, the exact question, and both halves
    // of the settle rule. Relocating it must not be allowed to thin it out.
    expect(install).toContain("User-consent actions");
    expect(install).toContain("agent_consent_required");
    expect(install).toContain("Star lidge-jun/opencodex? Yes / No");
    expect(install).toContain("POST /api/github/star");
    expect(install.toLowerCase()).toContain("silence is");
    expect(install.toLowerCase()).toContain("explicit yes");

    // Both entry points must still route an agent to it — a rule nobody is
    // pointed at is a rule nobody reads.
    expect(agents).toContain("AGENTS_INSTALL.md");
    expect(readme).toContain("AGENTS_INSTALL.md");
    expect(readme).toContain("agent_consent_required");
    expect(readme.toLowerCase()).toContain("never an agent");
  });

  test("the star prompt only appears when gh can actually star", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    // The invariant is that the prompt is gated on a real `gh auth status`
    // check, not that the call is spelled a particular way. The call now goes
    // through the shared Windows launcher (a bare `gh` spawn stalls on a `.cmd`
    // shim), so assert the arguments and the resolver rather than the literal.
    expect(prompt).toContain('ghInvocation(["auth", "status"])');
    expect(prompt).toContain('commandInvocation("gh"');
    // The gh check gates the prompt via the (test-seamable) ghOk result.
    expect(prompt).toContain("if (!ghOk) return;");
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
    const installIndex = service.indexOf("await installServiceSafely(backend, ops.install)");
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
