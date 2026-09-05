import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { commandInvocation } from "../src/lib/win-exec";
import {
  type GuardrailsRuntimeDependency,
  parseGuardrailsDonorRuleCases,
  verifyGuardrailsProvenance,
} from "./guardrails-provenance";

const REQUIRED_TARBALL_FILES = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "LICENSES/Apache-2.0.txt",
  "LICENSES/re2-wasm-Apache-2.0.txt",
  "LICENSES/Gitleaks-MIT.txt",
  "LICENSES/Google-RE2-BSD-3-Clause.txt",
  "LICENSES/node-re2-BSD-3-Clause.txt",
  "LICENSES/yaml-ISC.txt",
  "src/guardrails/rules/guardrails_regex_rules.yaml",
  "src/guardrails/rules/guardrails_regex_rules.gitleaks.generated.yaml",
  "src/guardrails/rules/guardrails_regex_rules.opencodex.yaml",
  "src/guardrails/rules/provenance.json",
  "src/guardrails/rules/provenance.schema.json",
  "src/guardrails/rules/MODIFICATIONS.md",
  "tests/fixtures/guardrails-donor-rule-cases.json",
] as const;
const MAX_UPSTREAM_SOURCE_BYTES = 8 * 1024 * 1024;
const PINNED_SOURCE_ATTEMPTS = 2;
const PINNED_SOURCE_TIMEOUT_MS = 10_000;

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface NpmPackResult {
  filename: string;
  files: Array<{ path: string }>;
}

interface GuardrailsPackageModule {
  createBuiltinGuardrailsRegistry(): { dispose(): void; rules: readonly { ruleId: string }[] };
  scanGuardrailsText(
    registry: { dispose(): void; rules: readonly { ruleId: string }[] },
    value: string,
  ): Array<{ ruleId: string; value: string }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(command: readonly string[], cwd?: string): Promise<CommandResult> {
  const [binary, ...args] = command;
  const invocation = commandInvocation(binary ?? "", args);
  const child = Bun.spawn([invocation.file, ...invocation.args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runOrThrow(command: readonly string[], cwd?: string): Promise<string> {
  const result = await run(command, cwd);
  if (result.exitCode === 0) return result.stdout;
  throw new Error(`${command.join(" ")} failed with exit ${result.exitCode}: ${result.stderr.trim()}`);
}

function parsePackResult(output: string): NpmPackResult {
  const parsed: unknown = JSON.parse(output);
  assert(Array.isArray(parsed) && parsed.length === 1, "npm pack must return exactly one package");
  const candidate = parsed[0];
  assert(typeof candidate === "object" && candidate !== null, "npm pack returned an invalid package record");
  const record = candidate as { filename?: unknown; files?: unknown };
  assert(typeof record.filename === "string", "npm pack result is missing filename");
  assert(Array.isArray(record.files), "npm pack result is missing files");
  const files = record.files.map(file => {
    assert(typeof file === "object" && file !== null, "npm pack returned an invalid file record");
    const path = (file as { path?: unknown }).path;
    assert(typeof path === "string", "npm pack file record is missing path");
    return { path };
  });
  return { filename: record.filename, files };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha1(path: string): string {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

function npmIntegrity(path: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function rawGitHubUrl(repository: string, commit: string, sourcePath: string): string {
  const parsed = new URL(repository);
  assert(parsed.protocol === "https:" && parsed.hostname === "github.com", `unsupported source repository: ${repository}`);
  const segments = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  assert(segments.length === 2, `unsupported GitHub repository path: ${repository}`);
  assert(!sourcePath.split("/").some(segment => segment === "" || segment === "." || segment === ".."), `invalid source path: ${sourcePath}`);
  const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${segments[0]}/${segments[1]}/${commit}/${encodedPath}`;
}

async function verifyPinnedSource(
  repository: string,
  commit: string,
  sourcePath: string,
  expectedSha256: string,
): Promise<Uint8Array> {
  const url = rawGitHubUrl(repository, commit, sourcePath);
  let lastError: unknown;
  for (let attempt = 1; attempt <= PINNED_SOURCE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(PINNED_SOURCE_TIMEOUT_MS),
      });
      assert(response.ok, `pinned source returned HTTP ${response.status}: ${sourcePath}`);
      const declaredLength = Number(response.headers.get("content-length"));
      assert(
        !Number.isFinite(declaredLength) || declaredLength <= MAX_UPSTREAM_SOURCE_BYTES,
        `pinned source exceeds the byte limit: ${sourcePath}`,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert(bytes.byteLength <= MAX_UPSTREAM_SOURCE_BYTES, `pinned source exceeds the byte limit: ${sourcePath}`);
      assert(
        createHash("sha256").update(bytes).digest("hex") === expectedSha256,
        `pinned source hash drifted: ${repository}@${commit}/${sourcePath}`,
      );
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `could not verify pinned source ${repository}@${commit}/${sourcePath}: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

async function verifyPinnedUpstreamSources(
  provenance: ReturnType<typeof verifyGuardrailsProvenance>,
): Promise<void> {
  await verifyPinnedSource(
    provenance.donor.repository,
    provenance.donor.commit,
    provenance.donor.license.sourcePath,
    provenance.donor.license.sha256,
  );
  await verifyPinnedSource(
    provenance.donor.repository,
    provenance.donor.commit,
    provenance.donor.notice.sourcePath,
    provenance.donor.notice.sha256,
  );
  for (const source of [...provenance.assets, ...provenance.generatorSources]) {
    const sourcePath = "sourcePath" in source ? source.sourcePath : source.path;
    await verifyPinnedSource(
      provenance.donor.repository,
      provenance.donor.commit,
      sourcePath,
      source.sha256,
    );
  }
  for (const fixture of provenance.testFixtures) {
    const donorSource = await verifyPinnedSource(
      provenance.donor.repository,
      provenance.donor.commit,
      fixture.sourcePath,
      fixture.sourceSha256,
    );
    const distributedFixture = JSON.parse(
      readFileSync(join(process.cwd(), fixture.distributedPath), "utf8"),
    ) as {
      cases?: unknown;
      source?: {
        commit?: unknown;
        license?: unknown;
        path?: unknown;
        repository?: unknown;
        sha256?: unknown;
        transform?: unknown;
      };
      version?: unknown;
    };
    assert(distributedFixture.version === 1, "donor fixture version drifted");
    assert(
      distributedFixture.source?.repository === provenance.donor.repository
        && distributedFixture.source.commit === provenance.donor.commit
        && distributedFixture.source.path === fixture.sourcePath
        && distributedFixture.source.sha256 === fixture.sourceSha256
        && distributedFixture.source.license === "Apache-2.0"
        && distributedFixture.source.transform
          === "Mechanical conversion of donor Go table entries to JSON; field values unchanged.",
      "donor fixture source metadata drifted",
    );
    const regeneratedCases = parseGuardrailsDonorRuleCases(new TextDecoder().decode(donorSource));
    assert(
      isDeepStrictEqual(distributedFixture.cases, regeneratedCases),
      "donor fixture cases do not reproduce from the pinned Go source",
    );
  }
  await verifyPinnedSource(
    provenance.gitleaks.repository,
    provenance.gitleaks.commit,
    provenance.gitleaks.configPath,
    provenance.gitleaks.configSha256,
  );
  const gitleaksLicense = provenance.distributionFiles.find(file =>
    file.path === "LICENSES/Gitleaks-MIT.txt");
  assert(gitleaksLicense !== undefined, "provenance is missing the distributed Gitleaks license");
  await verifyPinnedSource(
    provenance.gitleaks.repository,
    provenance.gitleaks.commit,
    provenance.gitleaks.licenseSourcePath,
    gitleaksLicense.sha256,
  );
  for (const dependency of provenance.runtimeDependencies) {
    await verifyPinnedSource(
      dependency.sourceRepository,
      dependency.sourceCommit,
      dependency.licenseSourcePath,
      dependency.licenseSha256,
    );
    for (const embedded of dependency.embeddedSources) {
      await verifyPinnedSource(
        embedded.repository,
        embedded.commit,
        embedded.licenseSourcePath,
        embedded.licenseSha256,
      );
    }
  }
}

async function downloadVerifiedDependencyTarball(
  temporaryRoot: string,
  dependency: GuardrailsRuntimeDependency,
): Promise<string> {
  const output = await runOrThrow([
    "npm",
    "pack",
    `${dependency.name}@${dependency.version}`,
    "--json",
    "--pack-destination",
    temporaryRoot,
  ]);
  const packed = parsePackResult(output);
  const tarball = join(temporaryRoot, packed.filename);
  assert(
    sha1(tarball) === dependency.npmTarballSha1,
    `${dependency.name}@${dependency.version} npm tarball SHA-1 drifted`,
  );
  assert(
    npmIntegrity(tarball) === dependency.npmIntegrity,
    `${dependency.name}@${dependency.version} npm tarball integrity drifted`,
  );
  return tarball;
}

async function main(): Promise<void> {
  const workspace = process.cwd();
  const provenance = verifyGuardrailsProvenance(workspace);
  const re2 = provenance.runtimeDependencies.find(dependency => dependency.name === "re2-wasm");
  const yaml = provenance.runtimeDependencies.find(dependency => dependency.name === "yaml");
  assert(re2 !== undefined && yaml !== undefined, "provenance must include re2-wasm and yaml");
  const loader = re2.artifacts.find(artifact => artifact.path === "build/wasm/re2.js");
  const wasm = re2.artifacts.find(artifact => artifact.path === "build/wasm/re2.wasm");
  assert(loader !== undefined, "provenance must include the dependency-owned re2.js loader");
  assert(wasm !== undefined, "provenance must include the dependency-owned re2.wasm");
  await verifyPinnedUpstreamSources(provenance);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "opencodex-guardrails-package-"));
  try {
    const packOutput = await runOrThrow(["npm", "pack", "--json", "--pack-destination", temporaryRoot], workspace);
    const packed = parsePackResult(packOutput);
    const packedPaths = new Set(packed.files.map(file => file.path));
    for (const requiredPath of REQUIRED_TARBALL_FILES) {
      assert(packedPaths.has(requiredPath), `npm tarball is missing ${requiredPath}`);
    }
    assert(![...packedPaths].some(path => path.startsWith("node_modules/")), "npm tarball must not vendor node_modules");
    assert(![...packedPaths].some(path => path.endsWith("re2.wasm")), "npm tarball must not copy re2.wasm outside re2-wasm dependency");

    const tarball = join(temporaryRoot, packed.filename);
    const dependencyTarballs: string[] = [];
    for (const dependency of provenance.runtimeDependencies) {
      dependencyTarballs.push(await downloadVerifiedDependencyTarball(temporaryRoot, dependency));
    }
    const installRoot = join(temporaryRoot, "fresh-install");
    await runOrThrow([
      "npm",
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--prefix",
      installRoot,
      tarball,
      ...dependencyTarballs,
    ]);

    const packageRoot = join(installRoot, "node_modules", "@bitkyc08", "opencodex");
    for (const requiredPath of REQUIRED_TARBALL_FILES) {
      assert(existsSync(join(packageRoot, requiredPath)), `fresh install is missing ${requiredPath}`);
    }
    const installedProvenance = verifyGuardrailsProvenance(packageRoot, { requireLockfile: false });
    const installedRe2 = installedProvenance.runtimeDependencies.find(dependency => dependency.name === "re2-wasm");
    const installedYaml = installedProvenance.runtimeDependencies.find(dependency => dependency.name === "yaml");
    assert(installedRe2 !== undefined && installedYaml !== undefined, "installed provenance is missing dependencies");
    const installedRequire = createRequire(join(packageRoot, "package.json"));
    const installedRe2PackagePath = installedRequire.resolve("re2-wasm/package.json");
    const installedRe2Package = JSON.parse(readFileSync(installedRe2PackagePath, "utf8")) as { version?: unknown };
    assert(installedRe2Package.version === installedRe2.version, "fresh install resolved an unexpected re2-wasm version");
    const installedLoader = join(dirname(installedRe2PackagePath), "build", "wasm", "re2.js");
    const installedWasm = join(dirname(installedRe2PackagePath), "build", "wasm", "re2.wasm");
    assert(sha256(installedLoader) === loader.sha256, "fresh install resolved an unexpected re2.js loader");
    assert(sha256(installedWasm) === wasm.sha256, "fresh install resolved an unexpected re2.wasm binary");
    const installedYamlPackagePath = installedRequire.resolve("yaml/package.json");
    const installedYamlPackage = JSON.parse(readFileSync(installedYamlPackagePath, "utf8")) as { version?: unknown };
    assert(installedYamlPackage.version === installedYaml.version, "fresh install resolved an unexpected yaml version");

    const moduleUrl = pathToFileURL(join(packageRoot, "src", "guardrails", "index.ts")).href;
    const guardrails = await import(moduleUrl) as GuardrailsPackageModule;
    const registry = guardrails.createBuiltinGuardrailsRegistry();
    try {
      assert(registry.rules.length === 272, "fresh package did not compile all built-in rules");
      const value = "sk_live_abcdefghijklmnopqrstuvwx";
      for (let iteration = 0; iteration < 300; iteration += 1) {
        const findings = guardrails.scanGuardrailsText(registry, value);
        assert(findings.some(finding => finding.value === value), "fresh package did not scan a Stripe API key");
      }
      const supplementalValue = "SyntheticPackageApiKey42";
      const supplementalFindings = guardrails.scanGuardrailsText(
        registry,
        `SERVICE_API_KEY=${supplementalValue}`,
      );
      assert(
        supplementalFindings.some(finding =>
          finding.ruleId === "opencodex.api-keys.assignment"
          && finding.value === supplementalValue
        ),
        "fresh package did not scan a supplemental OpenCodex assignment",
      );
      const punycodeEmail = `${["agent", "example"].join("@")}.${"xn--p1ai"}`;
      assert(
        guardrails.scanGuardrailsText(registry, punycodeEmail)
          .some(finding => finding.value === punycodeEmail),
        "fresh package did not scan a punycode email",
      );
    } finally {
      registry.dispose();
    }
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

await main();
