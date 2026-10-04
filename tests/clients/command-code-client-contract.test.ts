/**
 * Client-contract regression for the Command Code integration.
 *
 * The two cases below were found by running the PUBLISHED consumer
 * (`command-code@1.66.0`) against our exported provider, not by reading our own
 * output. Each test carries the client-side expression it is proving, taken from
 * `dist/cli.mjs` of that release:
 *
 *   - root selection: `const o = e.provider ?? e.providers;`
 *   - home resolution: `homeDir15(e) => e.env().HOME ?? e.env().USERPROFILE`,
 *     then `${home}/.commandcode/providers.json`
 *   - credential form: a raw string is refused; a `$ENV` / `{env:VAR}` / `!command`
 *     reference, or `false` for a keyless endpoint, is accepted
 *
 * The parser is reproduced here as `publishedCommandCodeRoot`, not imported, so
 * the test states the contract explicitly and fails loudly if we ever contradict
 * it. `COMMANDCODE_HOME` does not appear anywhere in the shipped bundle
 * (`grep -c COMMANDCODE_HOME dist/cli.mjs` → 0), which is why the path resolver
 * takes no override.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildClientContribution,
  buildCommandCodeClientConfig,
  commandCodeConfigPath,
  commandCodeHomeDir,
  type ExportContext,
} from "../../src/clients/config-export";
import { setPath } from "../../src/integrations/merge";
import { OPENCODE_PROVIDER_ID } from "../../src/clients/config-export/constants";
import { MANAGED_PATH_TEMPLATES } from "../../src/integrations/mutation-plan";

/** `const o = e.provider ?? e.providers;` — verbatim from command-code@1.66.0. */
function publishedCommandCodeRoot(document: unknown): Record<string, unknown> | undefined {
  const doc = document as { provider?: unknown; providers?: unknown } | null;
  const o = doc?.provider ?? doc?.providers;
  return typeof o === "object" && o !== null && !Array.isArray(o)
    ? (o as Record<string, unknown>)
    : undefined;
}

/** `isApiKeyReference` — a raw secret is not one. */
function publishedAcceptsApiKey(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value !== "string") return false;
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    || /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
    || value.startsWith("!");
}

const CONTEXT: ExportContext = {
  baseUrl: "http://127.0.0.1:10100/v1",
  models: [
    { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000 },
    { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000 },
  ],
};

describe("Command Code client contract (published command-code@1.66.0)", () => {
  test("a plural-root target keeps its root, and the client still reads every provider", () => {
    // BEFORE: the user's own plural-root document.
    const before = {
      providers: {
        acme: { name: "Acme", api: "openai-completions", baseURL: "https://api.acme.test/v1", apiKey: "$ACME_KEY", models: { "acme/large": {} } },
      },
    };

    const contribution = buildClientContribution("commandcode", { ...CONTEXT, document: before });
    const after = contribution.fragments.reduce(
      (doc, fragment) => setPath(doc, fragment.path, fragment.value),
      before,
    );

    // The fragment landed under the root the target already used.
    expect(contribution.fragments).toHaveLength(1);
    expect(contribution.fragments[0]!.path).toEqual(["providers", OPENCODE_PROVIDER_ID]);

    // THE REGRESSION THIS GUARDS: the published client resolves
    // `document.provider ?? document.providers`. If we had written a singular root
    // into this document, `provider` would win and the user's `acme` provider would
    // still be on disk but invisible to the consumer.
    const resolved = publishedCommandCodeRoot(after);
    expect(resolved).toBeDefined();
    expect(Object.keys(resolved!).sort()).toEqual([OPENCODE_PROVIDER_ID, "acme"].sort());
    expect(resolved!.acme).toEqual(before.providers.acme);
    expect((resolved as Record<string, { models: Record<string, unknown> }>)[OPENCODE_PROVIDER_ID]!.models["openai/gpt-5.6-sol"]).toBeDefined();
  });

  test("a singular-root target keeps the singular root", () => {
    const before = { provider: { legacy: { name: "Legacy", api: "openai-completions", baseURL: "https://legacy.test/v1", apiKey: false, models: {} } } };
    const contribution = buildClientContribution("commandcode", { ...CONTEXT, document: before });
    expect(contribution.fragments[0]!.path).toEqual(["provider", OPENCODE_PROVIDER_ID]);

    const after = contribution.fragments.reduce((doc, f) => setPath(doc, f.path, f.value), before);
    const resolved = publishedCommandCodeRoot(after);
    expect(Object.keys(resolved!).sort()).toEqual([OPENCODE_PROVIDER_ID, "legacy"].sort());
  });

  test("a fresh target writes the singular root and the client resolves it", () => {
    const doc = buildCommandCodeClientConfig(CONTEXT);
    const resolved = publishedCommandCodeRoot(doc);
    expect(resolved).toBeDefined();
    expect(Object.keys(resolved!)).toEqual([OPENCODE_PROVIDER_ID]);
  });

  test("both roots are declared as managed paths so disable can remove either", () => {
    // `mutation-plan` refuses to publish an undeclared path; if only the singular
    // root were declared, a block written under the plural root could never be
    // removed again.
    expect(MANAGED_PATH_TEMPLATES.commandcode).toEqual([
      ["provider", OPENCODE_PROVIDER_ID],
      ["providers", OPENCODE_PROVIDER_ID],
    ]);
  });

  test("the exported provider is accepted by the published credential check", () => {
    const provider = buildCommandCodeClientConfig(CONTEXT).provider[OPENCODE_PROVIDER_ID]!;
    // The literal "opencodex-loopback" this exporter used to write is NOT accepted.
    expect(publishedAcceptsApiKey("opencodex-loopback")).toBe(false);
    expect(publishedAcceptsApiKey(provider.apiKey)).toBe(true);
  });

  test("the config path ignores COMMANDCODE_HOME, which the client does not read", () => {
    const relocated = "/tmp/commandcode-relocated";
    // The client resolves `HOME ?? USERPROFILE` + `/.commandcode/providers.json`
    // and never consults COMMANDCODE_HOME, so honouring it would make `enable`
    // report success at a path Command Code never opens.
    expect(commandCodeHomeDir({ COMMANDCODE_HOME: relocated }, "/home/user")).toBe(join("/home/user", ".commandcode"));
    expect(commandCodeConfigPath({ COMMANDCODE_HOME: relocated }, "/home/user")).toBe(join("/home/user", ".commandcode", "providers.json"));
    // The real home still resolves the ordinary way.
    expect(commandCodeConfigPath({}, homedir())).toBe(join(homedir(), ".commandcode", "providers.json"));
  });

  test("a before/after write through the real path leaves the file parseable by the client", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-contract-"));
    const path = join(dir, "providers.json");
    const before = { providers: { acme: { name: "Acme", api: "openai-completions", baseURL: "https://api.acme.test/v1", apiKey: "$ACME_KEY", models: { "acme/large": {} } } } };
    writeFileSync(path, JSON.stringify(before, null, 2), "utf8");

    const onDisk = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as unknown;
    const contribution = buildClientContribution("commandcode", { ...CONTEXT, document: onDisk });
    const after = contribution.fragments.reduce((doc, f) => setPath(doc, f.path, f.value), onDisk);
    writeFileSync(path, JSON.stringify(after, null, 2), "utf8");

    // Re-read exactly as the client does, and confirm nothing the user configured
    // was lost or shadowed.
    const reloaded = publishedCommandCodeRoot(JSON.parse(require("node:fs").readFileSync(path, "utf8")));
    expect(reloaded).toBeDefined();
    expect(reloaded!.acme).toEqual(before.providers.acme);
    expect(reloaded![OPENCODE_PROVIDER_ID]).toBeDefined();
  });
});
