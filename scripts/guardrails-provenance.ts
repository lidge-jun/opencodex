import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const EXPECTED_PROVENANCE_SHA256 =
  "9ccaa93fb54b02b7eb66dfb21eb03e8e402c90b1e70c76bc88d39038c5e4172d";
const PROVENANCE_PATH = "src/guardrails/rules/provenance.json";
const PROVENANCE_SCHEMA_PATH = "src/guardrails/rules/provenance.schema.json";
const PROVENANCE_SCHEMA_ID = "https://opencodex.me/schemas/guardrails-provenance-v2.json";
const PROVENANCE_SCHEMA_TITLE = "OpenCodex Guardrails provenance";
const MODIFICATION_NOTICE = "Modified by OpenCodex contributors from";

const sha256Schema = z.string().regex(SHA256_PATTERN);
const commitSchema = z.string().regex(COMMIT_PATTERN);
const sourceFileSchema = z.object({
  path: z.string().min(1),
  sha256: sha256Schema,
}).strict();
const licenseSourceSchema = z.object({
  sourcePath: z.string().min(1),
  sha256: sha256Schema,
}).strict();
const assetSchema = z.object({
  sourcePath: z.string().min(1),
  distributedPath: z.string().min(1),
  sha256: sha256Schema,
  disposition: z.enum(["copied", "modified"]),
}).strict();
const testFixtureSchema = z.object({
  sourcePath: z.string().min(1),
  sourceSha256: sha256Schema,
  distributedPath: z.string().min(1),
  sha256: sha256Schema,
  disposition: z.literal("modified"),
}).strict();
const embeddedSourceSchema = z.object({
  name: z.string().min(1),
  repository: z.url(),
  commit: commitSchema,
  sourcePath: z.string().min(1),
  licenseSpdx: z.string().min(1),
  licenseSourcePath: z.string().min(1),
  distributedLicensePath: z.string().min(1),
  licenseSha256: sha256Schema,
}).strict();
const runtimeDependencySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  disposition: z.literal("dependency-only"),
  sourceRepository: z.url(),
  sourceTag: z.string().min(1),
  sourceCommit: commitSchema,
  npmIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/=]+$/),
  npmTarballSha1: z.string().regex(SHA1_PATTERN),
  licenseSpdx: z.string().min(1),
  licenseSourcePath: z.string().min(1),
  distributedLicensePath: z.string().min(1),
  licenseSha256: sha256Schema,
  installedPath: z.string().min(1),
  artifacts: z.array(sourceFileSchema),
  embeddedSources: z.array(embeddedSourceSchema),
}).strict();

export const guardrailsProvenanceSchema = z.object({
  schemaVersion: z.literal(2),
  donor: z.object({
    repository: z.url(),
    commit: commitSchema,
    license: licenseSourceSchema,
    notice: licenseSourceSchema,
  }).strict(),
  assets: z.array(assetSchema).length(2),
  testFixtures: z.array(testFixtureSchema).length(1),
  gitleaks: z.object({
    repository: z.url(),
    commit: commitSchema,
    configPath: z.string().min(1),
    configSha256: sha256Schema,
    licenseSourcePath: z.string().min(1),
  }).strict(),
  generatorSources: z.array(sourceFileSchema).min(1),
  generatedOutput: sourceFileSchema,
  runtimeDependencies: z.array(runtimeDependencySchema).length(2),
  distributionFiles: z.array(sourceFileSchema).min(8),
}).strict();

export type GuardrailsProvenance = z.infer<typeof guardrailsProvenanceSchema>;
export type GuardrailsRuntimeDependency = GuardrailsProvenance["runtimeDependencies"][number];
export interface GuardrailsDonorRuleCase {
  name: string;
  ruleId: string;
  input: string;
  wantFullText: string;
}

export function guardrailsProvenanceJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(guardrailsProvenanceSchema, {
      io: "input",
      target: "draft-2020-12",
    }),
    $id: PROVENANCE_SCHEMA_ID,
    title: PROVENANCE_SCHEMA_TITLE,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertUnique(values: readonly string[], label: string): void {
  assert(new Set(values).size === values.length, `${label} must not contain duplicates`);
}

function splitGoStringExpression(expression: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let callDepth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        quoted = false;
      }
      continue;
    }
    if (character === "\"") {
      quoted = true;
    } else if (character === "(") {
      callDepth += 1;
    } else if (character === ")") {
      callDepth -= 1;
      assert(callDepth >= 0, `invalid Go string expression: ${expression}`);
    } else if (character === "+" && callDepth === 0) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  assert(!quoted && callDepth === 0, `unterminated Go string expression: ${expression}`);
  parts.push(expression.slice(start).trim());
  return parts;
}

function parseGoQuotedString(value: string): string {
  assert(/^"(?:[^"\\]|\\.)*"$/.test(value), `unsupported Go string literal: ${value}`);
  try {
    const parsed: unknown = JSON.parse(value);
    assert(typeof parsed === "string", `Go string literal did not decode to text: ${value}`);
    return parsed;
  } catch (error) {
    throw new Error(
      `invalid Go string literal ${value}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function evaluateGoStringExpression(expression: string): string {
  return splitGoStringExpression(expression).map(part => {
    if (part.startsWith("\"")) return parseGoQuotedString(part);
    const repeat = /^strings\.Repeat\(("(?:[^"\\]|\\.)*"),\s*(\d+)\)$/.exec(part);
    assert(repeat !== null, `unsupported Go string expression part: ${part}`);
    const count = Number(repeat[2]);
    assert(Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000, `invalid strings.Repeat count: ${part}`);
    return parseGoQuotedString(repeat[1] ?? "").repeat(count);
  }).join("");
}

export function parseGuardrailsDonorRuleCases(source: string): GuardrailsDonorRuleCase[] {
  const functionStart = source.indexOf("func realConfigRuleCases() []realConfigRuleCase {");
  assert(functionStart >= 0, "donor source is missing realConfigRuleCases");
  const functionSource = source.slice(functionStart);
  const cases: GuardrailsDonorRuleCase[] = [];
  let current: Partial<GuardrailsDonorRuleCase> | undefined;

  for (const line of functionSource.split(/\r?\n/)) {
    if (/^\s*\{\s*$/.test(line)) {
      assert(current === undefined, "donor source contains a nested rule case");
      current = {};
      continue;
    }
    if (/^\s*\},\s*$/.test(line)) {
      if (current === undefined) break;
      assert(
        typeof current.name === "string"
          && typeof current.ruleId === "string"
          && typeof current.input === "string"
          && typeof current.wantFullText === "string",
        "donor source contains an incomplete rule case",
      );
      cases.push(current as GuardrailsDonorRuleCase);
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const field = /^\s*(name|ruleID|input|wantFullText):\s*(.+),\s*$/.exec(line);
    if (field === null) continue;
    const key = field[1] === "ruleID" ? "ruleId" : field[1];
    assert(key !== undefined && field[2] !== undefined, "donor source contains an invalid rule field");
    assert(current[key as keyof GuardrailsDonorRuleCase] === undefined, `duplicate donor rule field: ${key}`);
    current[key as keyof GuardrailsDonorRuleCase] = evaluateGoStringExpression(field[2]);
  }

  assert(current === undefined, "donor source ends inside a rule case");
  assert(cases.length > 0, "donor source did not yield any rule cases");
  assertUnique(cases.map(ruleCase => ruleCase.name), "donor rule case names");
  return cases;
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function validatePinnedSources(provenance: GuardrailsProvenance): void {
  assert(
    provenance.donor.repository === "https://github.com/cloud-ru-tech/guardrails-llm-filter"
      && provenance.donor.commit === "bbd6f27467a53ff3869b59449edf4209f85ae675",
    "Guardrails donor repository or commit drifted from the reviewed snapshot",
  );
  assert(
    provenance.gitleaks.repository === "https://github.com/gitleaks/gitleaks"
      && provenance.gitleaks.commit === "09242ce9c8a60d9b051fc2d166f9e849b88c7ac0"
      && provenance.gitleaks.configSha256
        === "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf",
    "Gitleaks source provenance drifted from the reviewed snapshot",
  );
  const re2 = provenance.runtimeDependencies.find(dependency => dependency.name === "re2-wasm");
  assert(re2?.version === "1.0.2", "provenance must pin re2-wasm@1.0.2");
  assert(
    re2.sourceCommit === "63796eaa20e1eea74466c0c56e2785a64f7ae372",
    "re2-wasm source commit drifted from the reviewed snapshot",
  );
  assert(
    re2.npmIntegrity
      === "sha512-VXUdgSiUrE/WZXn6gUIVVIsg0+Hp6VPZPOaHCay+OuFKy6u/8ktmeNEf+U5qSA8jzGGFsg8jrDNu1BeHpz2pJA==",
    "re2-wasm npm integrity drifted from the reviewed snapshot",
  );
  assert(
    re2.npmTarballSha1 === "78c09dc651b8962aa814b55ae7fe5e472ec15bbb",
    "re2-wasm npm tarball SHA-1 drifted from the reviewed snapshot",
  );
  assert(
    re2.artifacts.find(artifact => artifact.path === "build/wasm/re2.js")?.sha256
      === "4bfa5d6a8dd0052da8d06baf171078a392dc9c70592d5dca90c9aefa9006336e",
    "re2-wasm loader artifact drifted from the reviewed snapshot",
  );
  assert(
    re2.artifacts.find(artifact => artifact.path === "build/wasm/re2.wasm")?.sha256
      === "79e025a30d20157807add5e7d01acefe700f06721f4a56669b0bad5d00995e72",
    "re2-wasm binary artifact drifted from the reviewed snapshot",
  );
  const embeddedRe2 = re2.embeddedSources.find(source => source.name === "Google RE2");
  assert(
    embeddedRe2?.commit === "166dbbeb3b0ab7e733b278e8f42a84f6882b8a25",
    "embedded Google RE2 commit drifted from the reviewed snapshot",
  );
  const yaml = provenance.runtimeDependencies.find(dependency => dependency.name === "yaml");
  assert(yaml?.version === "2.8.1", "provenance must pin yaml@2.8.1");
  assert(
    yaml.sourceCommit === "1dc3c3ba06971613d0bcb772da4711ca25343dac",
    "yaml source commit drifted from the reviewed snapshot",
  );
  assert(
    yaml.npmIntegrity
      === "sha512-lcYcMxX2PO9XMGvAJkJ3OsNMw+/7FKes7/hgerGUYWIoWu5j/+YQqcZr5JnPZWzOsEBgMbSbiSTn/dv/69Mkpw==",
    "yaml npm integrity drifted from the reviewed snapshot",
  );
  assert(
    yaml.npmTarballSha1 === "1870aa02b631f7e8328b93f8bc574fac5d6c4d79",
    "yaml npm tarball SHA-1 drifted from the reviewed snapshot",
  );
}

function verifyAssetFiles(workspace: string, provenance: GuardrailsProvenance): void {
  assertUnique(provenance.assets.map(asset => asset.sourcePath), "Guardrails asset source paths");
  assertUnique(provenance.assets.map(asset => asset.distributedPath), "Guardrails distributed asset paths");
  for (const asset of provenance.assets) {
    const distributedPath = join(workspace, asset.distributedPath);
    assert(existsSync(distributedPath), `Guardrails asset is missing: ${asset.distributedPath}`);
    assert(sha256(distributedPath) === asset.sha256, `Guardrails asset hash drifted: ${asset.distributedPath}`);
    const prefix = readFileSync(distributedPath, "utf8").slice(0, 4_096);
    if (asset.disposition === "copied") {
      assert(!prefix.includes(MODIFICATION_NOTICE), `copied asset has a false modification notice: ${asset.distributedPath}`);
    } else {
      assert(prefix.includes(MODIFICATION_NOTICE), `modified asset lacks a file-local notice: ${asset.distributedPath}`);
    }
  }
  const generatedAsset = provenance.assets.find(asset =>
    asset.sourcePath === provenance.generatedOutput.path);
  assert(
    generatedAsset?.sha256 === provenance.generatedOutput.sha256,
    "generated output does not match the distributed generated asset",
  );
}

function verifyTestFixtures(workspace: string, provenance: GuardrailsProvenance): void {
  assertUnique(provenance.testFixtures.map(fixture => fixture.sourcePath), "Guardrails fixture source paths");
  assertUnique(provenance.testFixtures.map(fixture => fixture.distributedPath), "Guardrails fixture distributed paths");
  for (const fixture of provenance.testFixtures) {
    const distributedPath = join(workspace, fixture.distributedPath);
    assert(existsSync(distributedPath), `Guardrails test fixture is missing: ${fixture.distributedPath}`);
    assert(sha256(distributedPath) === fixture.sha256, `Guardrails test fixture hash drifted: ${fixture.distributedPath}`);
  }
}

function verifyDistributionFiles(workspace: string, provenance: GuardrailsProvenance): void {
  assertUnique(provenance.distributionFiles.map(file => file.path), "Guardrails distribution files");
  for (const file of provenance.distributionFiles) {
    const path = join(workspace, file.path);
    assert(existsSync(path), `Guardrails distribution file is missing: ${file.path}`);
    assert(sha256(path) === file.sha256, `Guardrails distribution file hash drifted: ${file.path}`);
  }
  const notice = readFileSync(join(workspace, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const required of [
    provenance.donor.commit,
    provenance.gitleaks.commit,
    "Disposition: copied unchanged",
    "Disposition: direct runtime dependency",
    "do not imply endorsement",
  ]) {
    assert(notice.includes(required), `THIRD_PARTY_NOTICES.md is missing required ledger text: ${required}`);
  }
}

function verifyDependencies(
  workspace: string,
  provenance: GuardrailsProvenance,
  requireLockfile: boolean,
): void {
  assertUnique(provenance.runtimeDependencies.map(dependency => dependency.name), "runtime dependency names");
  const packageJson = parseJsonFile(join(workspace, "package.json")) as {
    dependencies?: Record<string, unknown>;
  };
  const lockfilePath = join(workspace, "bun.lock");
  if (requireLockfile) assert(existsSync(lockfilePath), "bun.lock is missing");
  const lockfile = existsSync(lockfilePath) ? readFileSync(lockfilePath, "utf8") : undefined;
  const workspaceRequire = createRequire(join(workspace, "package.json"));
  for (const dependency of provenance.runtimeDependencies) {
    assert(
      packageJson.dependencies?.[dependency.name] === dependency.version,
      `package.json must pin ${dependency.name}@${dependency.version}`,
    );
    if (lockfile !== undefined) {
      const escapeRegExp = (value: string): string =>
        value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const name = escapeRegExp(JSON.stringify(dependency.name));
      const resolved = escapeRegExp(JSON.stringify(`${dependency.name}@${dependency.version}`));
      const integrity = escapeRegExp(JSON.stringify(dependency.npmIntegrity));
      const exactPackageEntry = new RegExp(
        `^\\s*${name}:\\s*\\[${resolved},[^\\n]*,\\s*${integrity}\\],?\\s*$`,
        "m",
      );
      assert(
        exactPackageEntry.test(lockfile),
        `bun.lock must pin ${dependency.name}@${dependency.version} to the reviewed integrity`,
      );
    }
    const packagePath = workspaceRequire.resolve(`${dependency.name}/package.json`);
    const installedPackage = parseJsonFile(packagePath) as { version?: unknown };
    assert(installedPackage.version === dependency.version, `installed ${dependency.name} version drifted`);
    const dependencyRoot = dirname(packagePath);
    for (const artifact of dependency.artifacts) {
      const artifactPath = join(dependencyRoot, artifact.path);
      assert(existsSync(artifactPath), `${dependency.name} artifact is missing: ${artifact.path}`);
      assert(sha256(artifactPath) === artifact.sha256, `${dependency.name} artifact hash drifted: ${artifact.path}`);
    }
    const distributedLicense = join(workspace, dependency.distributedLicensePath);
    assert(sha256(distributedLicense) === dependency.licenseSha256, `${dependency.name} license text drifted`);
    for (const source of dependency.embeddedSources) {
      assert(
        sha256(join(workspace, source.distributedLicensePath)) === source.licenseSha256,
        `${source.name} distributed license text drifted`,
      );
    }
  }
}

export function verifyGuardrailsProvenance(
  workspace: string,
  options: { requireLockfile?: boolean } = {},
): GuardrailsProvenance {
  const provenancePath = join(workspace, PROVENANCE_PATH);
  assert(
    sha256(provenancePath) === EXPECTED_PROVENANCE_SHA256,
    `${PROVENANCE_PATH} changed without updating the reviewed provenance pin`,
  );
  const schemaPath = join(workspace, PROVENANCE_SCHEMA_PATH);
  assert(existsSync(schemaPath), `${PROVENANCE_SCHEMA_PATH} is missing`);
  const publishedSchema = parseJsonFile(schemaPath);
  assert(
    isDeepStrictEqual(publishedSchema, guardrailsProvenanceJsonSchema()),
    `${PROVENANCE_SCHEMA_PATH} drifted from the canonical Zod schema`,
  );
  const parsed = guardrailsProvenanceSchema.safeParse(parseJsonFile(provenancePath));
  if (!parsed.success) {
    throw new Error(`Guardrails provenance schema validation failed: ${parsed.error.message}`);
  }
  validatePinnedSources(parsed.data);
  verifyAssetFiles(workspace, parsed.data);
  verifyTestFixtures(workspace, parsed.data);
  verifyDistributionFiles(workspace, parsed.data);
  verifyDependencies(workspace, parsed.data, options.requireLockfile ?? true);
  return parsed.data;
}
