import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegisteredAdapter, effectiveAdapterContract } from "../src/adapters/registry";
import {
  COMPATIBILITY_MANIFESTS,
  OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST,
  compatibilityManifestIssues,
} from "../src/compatibility";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { listScenarioIds } from "../src/lab/conformance/runner";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../src/codex/catalog/native-models";
import { parseRequest } from "../src/responses/parser";
import { resolveJsonPointer } from "../src/lab/conformance/json-pointer";
import fixtureJson from "./fixtures/compatibility/openai-codex-forward-gpt56-sol-v1.json";

type FixtureAssertion = {
  id: string;
  operator: "equals" | "absent";
  path: string;
  expected?: unknown;
};

type FixtureCase = {
  id: string;
  incomingHeaders?: Record<string, string>;
  request: Record<string, unknown>;
  assertions: FixtureAssertion[];
};

type CompatibilityFixture = {
  schemaVersion: number;
  id: string;
  manifestId: string;
  cases: FixtureCase[];
};

const fixture = fixtureJson as CompatibilityFixture;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_IMPORT_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;

function resolveRuntimeImport(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), `${base}.mts`, `${base}.mjs`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function firstCompatibilityImportPath(entry: string): string[] | null {
  const start = resolve(repoRoot, entry);
  const previous = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const source = readFileSync(current, "utf8");
    RUNTIME_IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RUNTIME_IMPORT_RE.exec(source)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
      // Dynamic imports are permitted for future on-demand CLI/GUI readers; only
      // load-time edges would put passive contract data onto the ordinary path.
      if (!specifier || match[4] !== undefined) continue;
      const next = resolveRuntimeImport(specifier, current);
      if (!next || previous.has(next)) continue;
      previous.set(next, current);
      if (next.replaceAll("\\", "/").includes("/src/compatibility/")) {
        const chain: string[] = [];
        let node: string | null = next;
        while (node) {
          chain.push(node.slice(repoRoot.length + 1).replaceAll("\\", "/"));
          node = previous.get(node) ?? null;
        }
        return chain.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

type OutboundFixtureRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

async function outboundRequest(fixtureCase: FixtureCase): Promise<OutboundFixtureRequest> {
  const registry = getProviderRegistryEntry("openai");
  if (!registry) throw new Error("openai registry entry missing");
  const provider = {
    ...providerConfigSeed(registry),
    _codexAccountRequired: true,
    _codexAccountOverride: {
      accessToken: "fixture-runtime-token",
      chatgptAccountId: "fixture-account",
    },
  };
  const adapter = createRegisteredAdapter(provider);
  const parsed = parseRequest(structuredClone(fixtureCase.request));
  const budget = createTranslatorBudget();
  try {
    const request = await adapter.buildRequest(parsed, {
      headers: new Headers(fixtureCase.incomingHeaders),
      translatorBudget: budget,
    });
    try {
      return {
        url: request.url,
        headers: request.headers,
        body: JSON.parse(request.body) as Record<string, unknown>,
      };
    } finally {
      request.releaseBodyObservation?.();
    }
  } finally {
    budget.dispose();
  }
}

function expectAssertion(body: Record<string, unknown>, assertion: FixtureAssertion): void {
  const resolved = resolveJsonPointer(body, assertion.path);
  if (assertion.operator === "absent") {
    expect(resolved.ok, assertion.id).toBe(false);
    return;
  }
  expect(resolved.ok, assertion.id).toBe(true);
  if (resolved.ok) expect(resolved.value, assertion.id).toEqual(assertion.expected);
}

describe("versioned compatibility manifests", () => {
  test("every bundled manifest is schema-valid and uniquely identified", () => {
    expect(COMPATIBILITY_MANIFESTS.length).toBeGreaterThan(0);
    expect(new Set(COMPATIBILITY_MANIFESTS.map(manifest => manifest.id)).size)
      .toBe(COMPATIBILITY_MANIFESTS.length);
    for (const manifest of COMPATIBILITY_MANIFESTS) {
      expect(compatibilityManifestIssues(manifest), manifest.id).toEqual([]);
    }
  });

  test("rejects duplicate claims and unproved non-passthrough behavior", () => {
    const invalid = structuredClone(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST) as unknown as {
      subject: Record<string, unknown>;
      claims: Array<Record<string, unknown>>;
    };
    invalid.subject.baseUrl = "https://chatgpt.com/backend-api/codex/";
    invalid.claims[1]!.id = invalid.claims[0]!.id;
    invalid.claims[1]!.feature = invalid.claims[0]!.feature;
    delete invalid.claims[2]!.limitation;
    invalid.claims[3]!.evidence = [{ kind: "fixture", id: fixture.id }];
    invalid.claims[4]!.unknownField = true;
    const issues = compatibilityManifestIssues(invalid);
    expect(issues.some(issue => issue.includes("duplicates"))).toBe(true);
    expect(issues.some(issue => issue.includes("feature duplicates"))).toBe(true);
    expect(issues.some(issue => issue.includes("subject.baseUrl must be normalized"))).toBe(true);
    expect(issues.some(issue => issue.includes("limitation"))).toBe(true);
    expect(issues.some(issue => issue.includes("assertionIds"))).toBe(true);
    expect(issues.some(issue => issue.includes("unknownField"))).toBe(true);
  });

  test("the first manifest is pinned to the canonical Codex forward route", () => {
    const manifest = OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST;
    const provider = getProviderRegistryEntry(manifest.subject.providerId);
    expect(provider).toBeDefined();
    expect(provider?.baseUrl).toBe(manifest.subject.baseUrl);
    expect(provider?.adapter).toBe(manifest.subject.adapterId);
    expect(provider?.authKind).toBe(manifest.subject.authMode);
    expect(effectiveAdapterContract(manifest.subject.adapterId).wire)
      .toBe(manifest.subject.upstreamProtocol);
    expect(manifest.subject.modelIds).toEqual(["gpt-5.6-sol"]);
    expect(manifest.subject.modelIds.every(model => SUPPORTED_NATIVE_OPENAI_SLUGS.has(model))).toBe(true);
    expect(Object.isFrozen(manifest.claims)).toBe(true);
    expect(Object.isFrozen(manifest.claims[0]?.evidence)).toBe(true);
  });

  test("ordinary request and startup graphs do not load the passive manifest catalog", () => {
    const protectedFiles = [
      "src/router.ts",
      "src/server/index.ts",
      "src/server/lifecycle.ts",
      "src/server/management-api.ts",
      "src/server/responses/core.ts",
    ];
    for (const file of protectedFiles) {
      const chain = firstCompatibilityImportPath(file);
      expect(chain === null ? "clean" : chain.join(" -> "), file).toBe("clean");
    }
  });
});

describe("OpenAI Codex forward compatibility fixture", () => {
  test("executes every fixture assertion against the production adapter", async () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.manifestId).toBe(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST.id);
    expect(new Set(fixture.cases.map(fixtureCase => fixtureCase.id)).size).toBe(fixture.cases.length);
    for (const fixtureCase of fixture.cases) {
      const outbound = await outboundRequest(fixtureCase);
      for (const assertion of fixtureCase.assertions) expectAssertion(outbound, assertion);
    }
  });

  test("every manifest claim names assertion-level evidence that exists", () => {
    const allAssertionIds = new Set(fixture.cases.flatMap(fixtureCase =>
      fixtureCase.assertions.map(assertion => assertion.id)));
    expect(allAssertionIds.size).toBe(
      fixture.cases.reduce((total, fixtureCase) => total + fixtureCase.assertions.length, 0),
    );
    const labScenarios = new Set(listScenarioIds());

    for (const claim of OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST.claims) {
      for (const evidence of claim.evidence) {
        if (evidence.kind === "fixture") {
          expect(evidence.id, claim.id).toBe(fixture.id);
          for (const assertionId of evidence.assertionIds ?? []) {
            expect(allAssertionIds.has(assertionId), `${claim.id}:${assertionId}`).toBe(true);
          }
        } else {
          expect(labScenarios.has(evidence.id), `${claim.id}:${evidence.id}`).toBe(true);
        }
      }
    }
  });
});
