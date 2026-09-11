/**
 * The providers guide must keep answering "which account does this login spend?".
 *
 * The question arrives from users faster than the docs answer it (#4215), and the two obvious
 * ways to answer it are both wrong. "OpenCodex never converts a subscription login into an API
 * key" is false -- orcarouter-oauth mints a user-owned sk-orca- key by design. "An API key bills
 * per token" is false too -- Z.AI GLM Coding Plan, Kimi Code, the BigModel coding plan, Command
 * Code and CodeBuddy all sell a subscription as a key. Both sentences read as obviously true,
 * which is exactly why a future edit will reach for them again.
 *
 * So this pins the shape that survived three source audits: a rule stated per authMode, one row
 * per provider that accepts both, and a pointer at the dashboard surface that actually renders
 * the mode. The per-provider rows rot first, because a new dual-mode preset lands in the registry
 * without anyone reopening this guide.
 */
import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const GUIDE = repoPath("docs-site/src/content/docs/guides/providers.md");
const HEADING = "### Which account a request spends";

/** The subsection only, so a marker that also appears in the API-key catalog cannot satisfy it. */
async function billingSection(): Promise<string> {
  const source = await Bun.file(GUIDE).text();
  const start = source.indexOf(HEADING);
  expect(start, `providers.md lost the "${HEADING}" section`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Each provider that accepts a subscription login AND an API key. Both markers must appear on that
 * provider's row: a row naming only one mode leaves the reader guessing about the other, which is
 * the failure #4215 reported.
 */
const DUAL_MODE = [
  { label: "OpenAI / ChatGPT", login: "`openai`", key: "`openai-apikey`" },
  { label: "Anthropic", login: "ocx login anthropic", key: "`anthropic-apikey`" },
  { label: "xAI", login: "ocx login xai", key: '`authMode: "key"`' },
  { label: "Kimi", login: "ocx login kimi", key: "`kimi-code`" },
  { label: "Command Code", login: "ocx login command-code", key: "`commandcode`" },
  { label: "GitHub Copilot", login: "ocx login github-copilot", key: '`authMode: "key"`' },
  { label: "OrcaRouter", login: "ocx login orcarouter-oauth", key: "`orcarouter`" },
  { label: "Meta Muse", login: "ocx login meta-muse", key: "`meta-model`" },
] as const;

describe("provider billing claims", () => {
  test("the rule is stated per authentication mode, not per vendor tier", async () => {
    const section = await billingSection();

    // forward: the ChatGPT plan, and the windows are plan-dependent. The unqualified version of
    // this sentence promised every plan a five-hour window, which is not true.
    expect(section).toContain("plan-dependent");
    expect(section).toContain("It never reads an API key.");

    // key: the account that owns the key, on that key's own terms -- which may be a plan.
    expect(section).toContain("usage lands on the account that owns that");
    expect(section).toContain("but a plan");

    // No cross-family fallback, stated as a failure rather than as a silent swap.
    expect(section).toContain("fails with an authentication error");
  });

  test("both shipped exceptions to the rule are stated", async () => {
    const section = await billingSection();
    // A key persisted on an OAuth preset survives login, so logging in does not necessarily move
    // billing to the subscription.
    expect(section).toContain('`authMode: "key"` on the same provider id');
    // The consent flow that really does hand back an API key.
    expect(section).toContain("sk-orca-");

    // Copilot accepts a key on the same provider id, but that key is still a Copilot credential.
    // The guide says elsewhere that the device flow is the supported path, so this section must not
    // imply a key moves Copilot billing to some other account.
    expect(section).toContain("the subscription still pays");
  });

  test("every dual-mode provider names both of its modes", async () => {
    const section = await billingSection();
    const rows = section.split("\n").filter(line => line.startsWith("| "));
    for (const provider of DUAL_MODE) {
      const row = rows.find(line => line.startsWith(`| ${provider.label} |`));
      expect(row, `no row for ${provider.label}`).toBeDefined();
      expect(row, `${provider.label} row lost its subscription login`).toContain(provider.login);
      expect(row, `${provider.label} row lost its API key`).toContain(provider.key);
    }
  });

  test("the login-only providers are named so their absence is not read as an omission", async () => {
    const section = await billingSection();
    expect(section).toContain("Cursor, Kiro and Nous Portal are login-only");
    // Antigravity is the provider a reader is most likely to mistake for a dual-mode one, because
    // a `google` preset sits beside it in the catalog. It is a different product, so it belongs
    // here rather than in the table above -- a row there would contradict its own heading.
    expect(section).toContain("Google Antigravity is");
    expect(section).toContain("not a key mode for the same login");
  });

  test("the reader is pointed at a dashboard surface that exists", async () => {
    // #4215 asked for "the account card", which carries no auth-mode badge: the mode is a
    // provider-level field on the Connection block. Sending a reader to the account rows would
    // have them hunting for something that was never built.
    const section = await billingSection();
    expect(section).toContain("**Authentication** row");
    for (const label of ["`OAuth`", "`API key`", "`ChatGPT passthrough`", "`Local`", "`No key needed`"]) {
      expect(section, `the Authentication row no longer lists ${label}`).toContain(label);
    }
    expect(section).toContain("the account rows below it do not repeat it");
  });

  test("the refuted absolute claim does not come back", async () => {
    // Both phrasings are the ones a well-meaning edit reaches for, and both are false while
    // orcarouter-oauth ships.
    const source = await Bun.file(GUIDE).text();
    expect(/never converts/i.test(source)).toBe(false);
    expect(source).not.toContain("does not convert one into the other");
  });
});
