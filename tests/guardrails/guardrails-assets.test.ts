import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  guardrailsProvenanceJsonSchema,
  guardrailsProvenanceSchema,
  parseGuardrailsDonorRuleCases,
  verifyGuardrailsProvenance,
} from "../../scripts/guardrails-provenance";
import { repoRoot } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

const ROOT = repoRoot();
const RULES_DIR = join(ROOT, "src", "guardrails", "rules");

test("YAML parser reports deep collection stack exhaustion as YAMLParseError", () => {
  // A bounded Node stack makes the npm parser regression independent of Bun's larger stack.
  const source = `
    const { parse, YAMLParseError } = require(process.argv[1]);
    const results = ["sequence", "mapping"].map(collection => {
      const open = collection === "sequence" ? "[" : "{a:";
      const close = collection === "sequence" ? "]" : "}";
      let failure;
      try { parse(open.repeat(5000) + "1" + close.repeat(5000)); }
      catch (error) { failure = error; }
      return { collection, yamlParseError: failure instanceof YAMLParseError, rangeError: failure instanceof RangeError };
    });
    console.log(JSON.stringify(results));
  `;
  const output = execFileSync("node", ["--stack-size=512", "-e", source, join(ROOT, "node_modules", "yaml")], {
    encoding: "utf8",
    timeout: INTERNAL_DEADLINE_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const results: unknown = JSON.parse(output);
  expect(results).toEqual([
    { collection: "sequence", yamlParseError: true, rangeError: false },
    { collection: "mapping", yamlParseError: true, rangeError: false },
  ]);
}, SPAWN_BUDGET_MS);

test("Guardrails vendors pinned donor assets with complete distribution notices", () => {
  const provenancePath = join(RULES_DIR, "provenance.json");
  expect(existsSync(provenancePath)).toBe(true);
  expect(createHash("sha256").update(readFileSync(provenancePath)).digest("hex")).toBe(
    "a835bfa0c7f0ff6e33f3466198121c5185a375d95d989106f1ede07237abf402",
  );
  expect(existsSync(join(RULES_DIR, "provenance.schema.json"))).toBe(true);
  const provenance = verifyGuardrailsProvenance(ROOT);
  expect(provenance.donor).toMatchObject({
    repository: "https://github.com/cloud-ru-tech/guardrails-llm-filter",
    commit: "bbd6f27467a53ff3869b59449edf4209f85ae675",
  });
  expect(provenance.gitleaks).toMatchObject({
    repository: "https://github.com/gitleaks/gitleaks",
    commit: "09242ce9c8a60d9b051fc2d166f9e849b88c7ac0",
    configSha256: "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf",
  });
  expect(provenance.runtimeDependencies.find(dependency => dependency.name === "yaml")).toMatchObject({
    version: "2.8.3",
    sourceCommit: "ce14587484822bffb0f7d31aefedcaf2dc0d0387",
    npmTarballSha1: "a0d6bd2efb3dd03c59370223701834e60409bd7d",
    npmIntegrity: "sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==",
  });

  for (const asset of provenance.assets) {
    const path = join(ROOT, asset.distributedPath);
    expect(existsSync(path)).toBe(true);
    expect(asset.disposition).toBe("copied");
  }
  const schemaPath = join(RULES_DIR, "provenance.schema.json");
  const schemaSha256 = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
  expect(provenance.distributionFiles).toContainEqual({
    path: "src/guardrails/rules/provenance.schema.json",
    sha256: schemaSha256,
  });

  const manual = parseYaml(readFileSync(join(RULES_DIR, "guardrails_regex_rules.yaml"), "utf8")) as {
    guardrails_regex_rules?: unknown[];
  };
  const generated = parseYaml(readFileSync(join(RULES_DIR, "guardrails_regex_rules.gitleaks.generated.yaml"), "utf8")) as {
    guardrails_regex_rules?: Array<{ rules?: unknown[] }>;
  };
  const supplementalSource = readFileSync(
    join(RULES_DIR, "guardrails_regex_rules.opencodex.yaml"),
    "utf8",
  );
  const supplemental = parseYaml(supplementalSource) as {
    guardrails_regex_rules?: Array<{ rules?: Array<{ rule_id?: string }> }>;
  };
  const countRules = (groups: Array<{ rules?: unknown[] }>): number =>
    groups.reduce((total, group) => total + (group.rules?.length ?? 0), 0);
  expect(countRules(manual.guardrails_regex_rules as Array<{ rules?: unknown[] }>)).toBe(46);
  expect(countRules(generated.guardrails_regex_rules ?? [])).toBe(220);
  expect(countRules(supplemental.guardrails_regex_rules ?? [])).toBe(6);
  expect(supplementalSource).toContain("OpenCodex-authored supplemental rules");
  expect(
    supplemental.guardrails_regex_rules
      ?.flatMap(group => group.rules ?? [])
      .every(rule => rule.rule_id?.startsWith("opencodex.")),
  ).toBe(true);
  expect(provenance.assets.some(asset => asset.distributedPath.endsWith(".opencodex.yaml"))).toBe(false);
  expect(provenance.distributionFiles).toContainEqual({
    path: "src/guardrails/rules/guardrails_regex_rules.opencodex.yaml",
    sha256: createHash("sha256").update(supplementalSource).digest("hex"),
  });

  for (const path of [
    "THIRD_PARTY_NOTICES.md",
    "LICENSES/Apache-2.0.txt",
    "LICENSES/re2-wasm-Apache-2.0.txt",
    "LICENSES/Gitleaks-MIT.txt",
    "LICENSES/Google-RE2-BSD-3-Clause.txt",
    "LICENSES/node-re2-BSD-3-Clause.txt",
  ]) {
    expect(existsSync(join(ROOT, path))).toBe(true);
  }
});

test("Guardrails provenance schema rejects drift and unknown fields", () => {
  const valid = JSON.parse(readFileSync(join(RULES_DIR, "provenance.json"), "utf8")) as Record<string, unknown>;
  const publishedSchema = JSON.parse(
    readFileSync(join(RULES_DIR, "provenance.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(publishedSchema).toEqual(guardrailsProvenanceJsonSchema());
  expect(guardrailsProvenanceSchema.safeParse({ ...valid, schemaVersion: 1 }).success).toBe(false);
  expect(guardrailsProvenanceSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);

  const assets = structuredClone(valid.assets) as Array<Record<string, unknown>>;
  assets[0] = { ...assets[0], disposition: "rewritten" };
  expect(guardrailsProvenanceSchema.safeParse({ ...valid, assets }).success).toBe(false);

  const dependencies = structuredClone(valid.runtimeDependencies) as Array<Record<string, unknown>>;
  delete dependencies[1]?.sourceCommit;
  expect(guardrailsProvenanceSchema.safeParse({ ...valid, runtimeDependencies: dependencies }).success).toBe(false);
  const dependenciesWithoutTarballSha1 = structuredClone(valid.runtimeDependencies) as Array<Record<string, unknown>>;
  delete dependenciesWithoutTarballSha1[1]?.npmTarballSha1;
  expect(
    guardrailsProvenanceSchema.safeParse({
      ...valid,
      runtimeDependencies: dependenciesWithoutTarballSha1,
    }).success,
  ).toBe(false);
});

test("published package declares the Guardrails runtime and license materials", () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    files?: string[];
  };
  expect(packageJson.dependencies?.["re2-wasm"]).toBe("1.0.2");
  expect(packageJson.dependencies?.yaml).toBe("2.8.3");
  expect(packageJson.files).toEqual(expect.arrayContaining([
    "src",
    "THIRD_PARTY_NOTICES.md",
    "LICENSES",
  ]));
});

test("donor rule cases reproduce from the supported Go table syntax", () => {
  const source = `
func realConfigRuleCases() []realConfigRuleCase {
  return []realConfigRuleCase{
    {
      name:         "plain",
      ruleID:       "plain.rule",
      input:        "prefix-secret",
      wantFullText: "secret",
    },
    {
      name:   "joined",
      ruleID: "joined.rule",
      // The donor uses this form to avoid scanner false positives.
      input:        "prefix-" + strings.Repeat("a", 3),
      wantFullText: strings.Repeat("a", 3),
    },
  }
}
`;
  expect(parseGuardrailsDonorRuleCases(source)).toEqual([
    {
      name: "plain",
      ruleId: "plain.rule",
      input: "prefix-secret",
      wantFullText: "secret",
    },
    {
      name: "joined",
      ruleId: "joined.rule",
      input: "prefix-aaa",
      wantFullText: "aaa",
    },
  ]);
});
