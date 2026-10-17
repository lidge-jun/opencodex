import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRegisteredAdapter, effectiveAdapterContract } from "../../src/adapters/registry";
import {
  COMPATIBILITY_MANIFESTS,
  OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST,
  OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST,
  compatibilityManifestIssues,
} from "../../src/compatibility";
import type { CompatibilityManifestV1, CompatibilitySubjectV1 } from "../../src/compatibility";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { listScenarioIds } from "../../src/lab/conformance/runner";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry, providerModelWireDefault } from "../../src/providers/registry";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../../src/codex/catalog/native-models";
import { parseRequest } from "../../src/responses/parser";
import { resolveJsonPointer } from "../../src/lab/conformance/json-pointer";
import type { OcxProviderConfig } from "../../src/types";
import forwardFixtureJson from "../fixtures/compatibility/openai-codex-forward-gpt56-sol-v1.json";
import openGatewayFixtureJson from "../fixtures/compatibility/opengateway-key-glm53-responses-v1.json";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

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

const FIXTURES = [forwardFixtureJson, openGatewayFixtureJson] as CompatibilityFixture[];
const forwardFixture = forwardFixtureJson as CompatibilityFixture;
const openGatewayFixture = openGatewayFixtureJson as CompatibilityFixture;
/** Synthetic credential the runner selects; fixtures may assert it but never carry a real one. */
const FIXTURE_RUNTIME_TOKEN = "fixture-runtime-token";
const OPENAI_WIRES: ReadonlySet<string> = new Set(["openai-chat", "openai-responses"]);
const repoRoot = resolveRepoRoot();
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

function fixtureForManifest(manifest: CompatibilityManifestV1): CompatibilityFixture {
  const matches = FIXTURES.filter(candidate => candidate.manifestId === manifest.id);
  if (matches.length !== 1) throw new Error(`${manifest.id} needs exactly one fixture, found ${matches.length}`);
  return matches[0]!;
}

/** Effective adapter for one subject model, resolved the way routing resolves mixed-wire presets. */
function subjectModelAdapter(subject: CompatibilitySubjectV1, modelId: string): string | undefined {
  const registry = getProviderRegistryEntry(subject.providerId);
  if (!registry) return undefined;
  const seed = providerConfigSeed(registry);
  if (seed.adapter === subject.adapterId) return seed.adapter;
  return providerModelWireDefault(
    subject.providerId,
    seed,
    modelId,
    OPENAI_WIRES,
    subject.inboundProtocol === "messages" ? "anthropic" : subject.inboundProtocol,
  );
}

function providerForSubject(subject: CompatibilitySubjectV1): OcxProviderConfig {
  const registry = getProviderRegistryEntry(subject.providerId);
  if (!registry) throw new Error(`${subject.providerId} registry entry missing`);
  if (subject.authMode === "forward") {
    return {
      ...providerConfigSeed(registry),
      _codexAccountRequired: true,
      _codexAccountOverride: {
        accessToken: FIXTURE_RUNTIME_TOKEN,
        chatgptAccountId: "fixture-account",
      },
    } as OcxProviderConfig;
  }
  if (subject.authMode === "key") {
    const adapter = subjectModelAdapter(subject, subject.modelIds[0]!);
    if (adapter !== subject.adapterId) throw new Error(`${subject.providerId} does not resolve to ${subject.adapterId}`);
    // Enrichment is what carries registry capability flags such as supportsResponsesCustomTools
    // onto a configured provider; the bare seed would skip the lowering this fixture proves.
    const provider = { ...providerConfigSeed(registry), apiKey: FIXTURE_RUNTIME_TOKEN };
    enrichProviderFromRegistry(subject.providerId, provider);
    return { ...provider, adapter };
  }
  throw new Error(`no fixture runner for auth mode ${subject.authMode}`);
}

async function outboundRequest(
  subject: CompatibilitySubjectV1,
  fixtureCase: FixtureCase,
): Promise<OutboundFixtureRequest> {
  const adapter = createRegisteredAdapter(providerForSubject(subject));
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
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        body: JSON.parse(request.body) as Record<string, unknown>,
      };
    } finally {
      request.releaseBodyObservation?.();
    }
  } finally {
    budget.dispose();
  }
}

function expectAssertion(outbound: OutboundFixtureRequest, assertion: FixtureAssertion): void {
  const resolved = resolveJsonPointer(outbound, assertion.path);
  if (assertion.operator === "absent") {
    expect(resolved.ok, assertion.id).toBe(false);
    return;
  }
  expect(resolved.ok, assertion.id).toBe(true);
  if (resolved.ok) expect(resolved.value, assertion.id).toEqual(assertion.expected);
}

/** The caller-supplied value an outbound selector corresponds to, if the selector has one. */
function callerInputAt(fixtureCase: FixtureCase, path: string): { ok: true; value: unknown } | { ok: false } {
  if (path.startsWith("/body/")) {
    const resolved = resolveJsonPointer(fixtureCase.request, path.slice("/body".length));
    return resolved.ok ? { ok: true, value: resolved.value } : { ok: false };
  }
  if (path.startsWith("/headers/") && path.indexOf("/", "/headers/".length) === -1) {
    const name = path.slice("/headers/".length).toLowerCase();
    const entry = Object.entries(fixtureCase.incomingHeaders ?? {})
      .find(([candidate]) => candidate.toLowerCase() === name);
    return entry ? { ok: true, value: entry[1] } : { ok: false };
  }
  return { ok: false };
}

/**
 * Passthrough means the caller's value reaches the upstream unchanged, so its evidence must be an
 * equality whose expected value IS the caller's value at the same place. An absence check, or an
 * equality against a rewritten value, proves a transformation and cannot back a lossless claim.
 */
type PassthroughBinding = {
  /** Outbound selectors that can prove this feature survived. */
  selector: RegExp;
  /** Extra requirement on the preserved value, so a partial value cannot stand in for the feature. */
  valueIssue?: (value: unknown) => string | undefined;
};

/**
 * Features that may be claimed as passthrough, and where their evidence must look. Evidence for an
 * unrelated field (the model id, say) preserves a caller value but proves nothing about the feature.
 * A new passthrough feature needs a binding here before it can be claimed.
 */
const PASSTHROUGH_FEATURE_BINDINGS: Readonly<Record<string, PassthroughBinding>> = {
  "request.custom_tools": {
    selector: /^\/body\/tools\/\d+$/,
    valueIssue: value => (value as { type?: unknown } | null)?.type === "custom"
      ? undefined
      : "is not a native custom tool declaration",
  },
  "request.custom_tools.grammar": {
    selector: /^\/body\/tools\/\d+\/format$/,
    valueIssue: value => {
      const format = value as { type?: unknown; definition?: unknown } | null;
      return format?.type === "grammar" && typeof format.definition === "string" && format.definition.length > 0
        ? undefined
        : "is not a grammar format with a non-empty definition";
    },
  },
  "request.prompt_cache_key": { selector: /^\/body\/prompt_cache_key$/ },
};

function passthroughEvidenceIssues(
  claimId: string,
  feature: string,
  fixtureCase: FixtureCase,
  assertion: FixtureAssertion,
): string[] {
  const binding = PASSTHROUGH_FEATURE_BINDINGS[feature];
  if (!binding) return [`${claimId}: passthrough feature ${feature} has no evidence selector binding`];
  if (!binding.selector.test(assertion.path)) {
    return [`${claimId}: passthrough evidence ${assertion.id} selector ${assertion.path} does not prove ${feature}`];
  }
  if (assertion.operator !== "equals" || !Object.prototype.hasOwnProperty.call(assertion, "expected")) {
    return [`${claimId}: passthrough evidence ${assertion.id} must be an equals assertion`];
  }
  const input = callerInputAt(fixtureCase, assertion.path);
  if (!input.ok) {
    return [`${claimId}: passthrough evidence ${assertion.id} selector ${assertion.path} has no caller input to compare`];
  }
  if (!Bun.deepEquals(input.value, assertion.expected, true)) {
    return [`${claimId}: passthrough evidence ${assertion.id} expects a value that differs from the caller input`];
  }
  const valueIssue = binding.valueIssue?.(assertion.expected);
  if (valueIssue) return [`${claimId}: passthrough evidence ${assertion.id} ${valueIssue}`];
  return [];
}

/**
 * Catalog evidence gate. The schema validator only requires assertion ids to be listed; this
 * resolves each one inside the manifest's own fixture and checks passthrough coherence.
 */
function manifestEvidenceIssues(manifest: CompatibilityManifestV1, fixture: CompatibilityFixture): string[] {
  const issues: string[] = [];
  const assertions = new Map<string, { fixtureCase: FixtureCase; assertion: FixtureAssertion }>();
  for (const fixtureCase of fixture.cases) {
    for (const assertion of fixtureCase.assertions) {
      if (assertions.has(assertion.id)) issues.push(`${fixture.id}: assertion ${assertion.id} is not unique`);
      assertions.set(assertion.id, { fixtureCase, assertion });
    }
  }
  const labScenarios = new Set(listScenarioIds());
  for (const claim of manifest.claims) {
    let fixtureEvidence = 0;
    for (const evidence of claim.evidence) {
      if (evidence.kind !== "fixture") {
        if (!labScenarios.has(evidence.id)) issues.push(`${claim.id}: lab scenario ${evidence.id} does not exist`);
        continue;
      }
      fixtureEvidence += 1;
      if (evidence.id !== fixture.id) issues.push(`${claim.id}: evidence fixture ${evidence.id} is not ${fixture.id}`);
      for (const assertionId of evidence.assertionIds ?? []) {
        const found = assertions.get(assertionId);
        if (!found) {
          issues.push(`${claim.id}: assertion ${assertionId} does not exist in fixture ${fixture.id}`);
          continue;
        }
        if (claim.disposition === "passthrough") {
          issues.push(...passthroughEvidenceIssues(claim.id, claim.feature, found.fixtureCase, found.assertion));
        }
      }
    }
    if (claim.disposition === "passthrough" && fixtureEvidence === 0) {
      issues.push(`${claim.id}: passthrough claims need fixture evidence`);
    }
  }
  return issues;
}

type MutableManifest = {
  claims: Array<Record<string, unknown> & { evidence: Array<Record<string, unknown>> }>;
};

function mutableClone(manifest: CompatibilityManifestV1): CompatibilityManifestV1 & MutableManifest {
  return structuredClone(manifest) as unknown as CompatibilityManifestV1 & MutableManifest;
}

function claimIndex(manifest: CompatibilityManifestV1, id: string): number {
  const index = manifest.claims.findIndex(claim => claim.id === id);
  if (index < 0) throw new Error(`${manifest.id} has no claim ${id}`);
  return index;
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
    invalid.claims[3]!.evidence = [{ kind: "fixture", id: forwardFixture.id }];
    invalid.claims[4]!.unknownField = true;
    const issues = compatibilityManifestIssues(invalid);
    expect(issues.some(issue => issue.includes("duplicates"))).toBe(true);
    expect(issues.some(issue => issue.includes("feature duplicates"))).toBe(true);
    expect(issues.some(issue => issue.includes("subject.baseUrl must be normalized"))).toBe(true);
    expect(issues.some(issue => issue.includes("limitation"))).toBe(true);
    expect(issues.some(issue => issue.includes("assertionIds"))).toBe(true);
    expect(issues.some(issue => issue.includes("unknownField"))).toBe(true);
  });

  test("every manifest is pinned to the route its subject names", () => {
    for (const manifest of COMPATIBILITY_MANIFESTS) {
      const { subject } = manifest;
      const provider = getProviderRegistryEntry(subject.providerId);
      expect(provider, manifest.id).toBeDefined();
      expect(provider?.baseUrl, manifest.id).toBe(subject.baseUrl);
      expect(provider?.authKind, manifest.id).toBe(subject.authMode);
      expect(effectiveAdapterContract(subject.adapterId).wire, manifest.id).toBe(subject.upstreamProtocol);
      for (const modelId of subject.modelIds) {
        expect(subjectModelAdapter(subject, modelId), `${manifest.id}:${modelId}`).toBe(subject.adapterId);
      }
      expect(Object.isFrozen(manifest.claims), manifest.id).toBe(true);
      expect(Object.isFrozen(manifest.claims[0]?.evidence), manifest.id).toBe(true);
    }

    const forward = OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST.subject;
    expect(forward.modelIds).toEqual(["gpt-5.6-sol"]);
    expect(forward.modelIds.every(model => SUPPORTED_NATIVE_OPENAI_SLUGS.has(model))).toBe(true);

    const lowered = OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST.subject;
    const openGateway = getProviderRegistryEntry(lowered.providerId);
    expect(openGateway?.supportsResponsesCustomTools).toBe(false);
    expect(lowered.modelIds.every(model => openGateway?.models?.includes(model))).toBe(true);
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

describe("compatibility fixtures", () => {
  test("each fixture belongs to exactly one bundled manifest", () => {
    expect(new Set(FIXTURES.map(fixture => fixture.id)).size).toBe(FIXTURES.length);
    expect(new Set(FIXTURES.map(fixture => fixture.manifestId)).size).toBe(FIXTURES.length);
    for (const fixture of FIXTURES) {
      expect(fixture.schemaVersion, fixture.id).toBe(1);
      expect(COMPATIBILITY_MANIFESTS.some(manifest => manifest.id === fixture.manifestId), fixture.id).toBe(true);
      expect(new Set(fixture.cases.map(fixtureCase => fixtureCase.id)).size, fixture.id).toBe(fixture.cases.length);
    }
    for (const manifest of COMPATIBILITY_MANIFESTS) expect(fixtureForManifest(manifest).manifestId).toBe(manifest.id);
  });

  test("executes every fixture assertion against the production adapter", async () => {
    for (const manifest of COMPATIBILITY_MANIFESTS) {
      const fixture = fixtureForManifest(manifest);
      for (const fixtureCase of fixture.cases) {
        const outbound = await outboundRequest(manifest.subject, fixtureCase);
        for (const assertion of fixtureCase.assertions) expectAssertion(outbound, assertion);
      }
    }
  });

  test("every manifest claim names assertion-level evidence that exists and supports it", () => {
    for (const manifest of COMPATIBILITY_MANIFESTS) {
      expect(manifestEvidenceIssues(manifest, fixtureForManifest(manifest)), manifest.id).toEqual([]);
    }
  });
});

describe("custom-tool grammar evidence", () => {
  const grammarFeature = "request.custom_tools.grammar";

  test("native and lowered subjects record representation and grammar separately", () => {
    const forwardGrammar = OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST.claims.find(claim => claim.feature === grammarFeature);
    const loweredGrammar = OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST.claims.find(claim => claim.feature === grammarFeature);
    const forwardTools = OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST.claims.find(claim => claim.feature === "request.custom_tools");
    const loweredTools = OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST.claims.find(claim => claim.feature === "request.custom_tools");
    expect([forwardTools?.disposition, forwardGrammar?.disposition]).toEqual(["passthrough", "passthrough"]);
    expect([loweredTools?.disposition, loweredGrammar?.disposition]).toEqual(["translated", "degraded"]);

    // Both fixtures send the same non-empty grammar, so the difference is the route, not the input.
    const forwardFormat = resolveJsonPointer(forwardFixture.cases[0]!.request, "/tools/0/format");
    const loweredFormat = resolveJsonPointer(openGatewayFixture.cases[0]!.request, "/tools/0/format");
    expect(forwardFormat.ok && loweredFormat.ok).toBe(true);
    if (forwardFormat.ok && loweredFormat.ok) {
      expect(loweredFormat.value).toEqual(forwardFormat.value);
      expect((forwardFormat.value as { definition?: string }).definition?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("grammar loss cannot be labeled passthrough", () => {
    const index = claimIndex(OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST, "custom-tool-grammar");
    const asPassthrough = (assertionIds: string[]) => {
      const clone = mutableClone(OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST);
      clone.claims[index]!.disposition = "passthrough";
      delete clone.claims[index]!.limitation;
      clone.claims[index]!.evidence = [{ kind: "fixture", id: openGatewayFixture.id, assertionIds }];
      // Schema-valid on purpose: only the evidence gate can see that the value did not survive.
      expect(compatibilityManifestIssues(clone)).toEqual([]);
      return clone;
    };

    expect(manifestEvidenceIssues(asPassthrough(["custom-tool-grammar-removed"]), openGatewayFixture)).toContain(
      "custom-tool-grammar: passthrough evidence custom-tool-grammar-removed must be an equals assertion",
    );
    expect(manifestEvidenceIssues(asPassthrough(["custom-tool-lowered-to-function"]), openGatewayFixture)).toContain(
      "custom-tool-grammar: passthrough evidence custom-tool-lowered-to-function selector /body/tools/0 does not prove request.custom_tools.grammar",
    );

    // A genuinely preserved but unrelated caller value must not stand in for the grammar.
    const withModelAssertion = structuredClone(openGatewayFixture);
    withModelAssertion.cases[0]!.assertions.push({
      id: "model-preserved",
      operator: "equals",
      path: "/body/model",
      expected: withModelAssertion.cases[0]!.request.model,
    });
    expect(manifestEvidenceIssues(asPassthrough(["model-preserved"]), withModelAssertion)).toContain(
      "custom-tool-grammar: passthrough evidence model-preserved selector /body/model does not prove request.custom_tools.grammar",
    );
  });

  test("a rewritten value cannot back a passthrough claim", () => {
    const clone = mutableClone(OPENGATEWAY_KEY_GLM53_RESPONSES_MANIFEST);
    const index = claimIndex(clone, "custom-tools");
    clone.claims[index]!.disposition = "passthrough";
    delete clone.claims[index]!.limitation;
    expect(compatibilityManifestIssues(clone)).toEqual([]);
    expect(manifestEvidenceIssues(clone, openGatewayFixture)).toContain(
      "custom-tools: passthrough evidence custom-tool-lowered-to-function expects a value that differs from the caller input",
    );
  });

  test("grammar passthrough evidence must carry a non-empty definition", () => {
    const withoutDefinition = structuredClone(forwardFixture);
    const fieldCase = withoutDefinition.cases.find(fixtureCase => fixtureCase.id === "field-contract")!;
    const tools = fieldCase.request.tools as Array<{ format: Record<string, unknown> }>;
    delete tools[0]!.format.definition;
    const grammarAssertion = fieldCase.assertions.find(assertion => assertion.id === "custom-tool-grammar-preserved")!;
    delete (grammarAssertion.expected as Record<string, unknown>).definition;
    expect(manifestEvidenceIssues(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST, withoutDefinition)).toContain(
      "custom-tool-grammar: passthrough evidence custom-tool-grammar-preserved is not a grammar format with a non-empty definition",
    );
  });

  test("passthrough evidence must point at a caller-supplied value for a bound feature", () => {
    const grammarIndex = claimIndex(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST, "custom-tool-grammar");
    const unrelatedSelector = mutableClone(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST);
    unrelatedSelector.claims[grammarIndex]!.evidence = [{
      kind: "fixture",
      id: forwardFixture.id,
      assertionIds: ["canonical-url"],
    }];
    expect(manifestEvidenceIssues(unrelatedSelector, forwardFixture)).toContain(
      "custom-tool-grammar: passthrough evidence canonical-url selector /url does not prove request.custom_tools.grammar",
    );

    const noCallerValue = structuredClone(forwardFixture);
    noCallerValue.cases[0]!.assertions.push({
      id: "second-tool-format",
      operator: "equals",
      path: "/body/tools/1/format",
      expected: { type: "grammar", syntax: "lark", definition: "start: X" },
    });
    const citesMissingInput = mutableClone(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST);
    citesMissingInput.claims[grammarIndex]!.evidence = [{
      kind: "fixture",
      id: forwardFixture.id,
      assertionIds: ["second-tool-format"],
    }];
    expect(manifestEvidenceIssues(citesMissingInput, noCallerValue)).toContain(
      "custom-tool-grammar: passthrough evidence second-tool-format selector /body/tools/1/format has no caller input to compare",
    );

    const unbound = mutableClone(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST);
    const metadataIndex = claimIndex(unbound, "metadata");
    unbound.claims[metadataIndex]!.disposition = "passthrough";
    delete unbound.claims[metadataIndex]!.limitation;
    expect(manifestEvidenceIssues(unbound, forwardFixture)).toContain(
      "metadata: passthrough feature request.metadata has no evidence selector binding",
    );
  });

  test("missing assertion evidence fails the catalog gate", () => {
    const dangling = mutableClone(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST);
    dangling.claims[claimIndex(dangling, "custom-tool-grammar")]!.evidence = [{
      kind: "fixture",
      id: forwardFixture.id,
      assertionIds: ["no-such-assertion"],
    }];
    expect(compatibilityManifestIssues(dangling)).toEqual([]);
    expect(manifestEvidenceIssues(dangling, forwardFixture)).toContain(
      `custom-tool-grammar: assertion no-such-assertion does not exist in fixture ${forwardFixture.id}`,
    );

    const deleted = structuredClone(forwardFixture);
    for (const fixtureCase of deleted.cases) {
      fixtureCase.assertions = fixtureCase.assertions.filter(assertion => assertion.id !== "custom-tool-grammar-preserved");
    }
    expect(manifestEvidenceIssues(OPENAI_CODEX_FORWARD_GPT56_SOL_MANIFEST, deleted)).toContain(
      `custom-tool-grammar: assertion custom-tool-grammar-preserved does not exist in fixture ${forwardFixture.id}`,
    );
  });
});
