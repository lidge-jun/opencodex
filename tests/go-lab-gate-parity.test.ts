import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { labActivationRequired, labAutomationEnabledOnDisk } from "../src/lib/lab-activation";
import { loadConfig } from "../src/config";

/**
 * Differential oracle for the Go Compatibility Lab activation gate (ADR-0008,
 * ticket #19).
 *
 * The Go gate (go/internal/labactivation, exercised through the `ocx-sidecar
 * labcheck` subcommand) must answer identically to
 * src/lib/lab-activation.ts for the same on-disk state: a routing profile in
 * config.json OR Lab automation enabled under <configDir>/lab/. Each fixture
 * directory is evaluated by Go first (the TS config loader can repair/rewrite
 * a config file in place, so Go must read the pristine fixture) and then by
 * the TypeScript functions, and the three outputs — automationEnabled,
 * profilesNonEmpty, required — must match.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function goToolchainAvailable(): boolean {
  return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-labgate-"));
  const binPath = join(dir, process.platform === "win32" ? "ocx-sidecar.exe" : "ocx-sidecar");
  const build = Bun.spawnSync(["go", "build", "-o", binPath, "./cmd/ocx-sidecar"], {
    cwd: join(repoRoot, "go"),
    env: { ...process.env, CGO_ENABLED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(`go build ./cmd/ocx-sidecar failed (${build.exitCode}):\n${new TextDecoder().decode(build.stderr)}`);
  }
  return binPath;
}

const goAvailable = goToolchainAvailable();
const sidecarBinary: string | null = goAvailable ? buildSidecarBinary() : null;
const describeGo = goAvailable ? describe : describe.skip;

interface GateOutput {
  automationEnabled: boolean;
  profilesNonEmpty: boolean;
  required: boolean;
}

function goGate(configDir: string): GateOutput {
  const result = Bun.spawnSync([sidecarBinary!, "labcheck", configDir], {
    env: { ...process.env, CGO_ENABLED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`ocx-sidecar labcheck failed (${result.exitCode}):\n${new TextDecoder().decode(result.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as GateOutput;
}

function tsGate(configDir: string): GateOutput {
  const previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = configDir;
  try {
    const config = loadConfig();
    const profiles = Object.keys(config.routingProfiles ?? {}).length > 0;
    const automation = labAutomationEnabledOnDisk(configDir);
    return {
      automationEnabled: automation,
      profilesNonEmpty: profiles,
      required: labActivationRequired(config, configDir),
    };
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
  }
}

interface Fixture {
  name: string;
  configJSON?: string;
  automation?: { file: "automation-config.json" | "automation-policy.json"; content: string }[];
  // Expected gate decision (cross-checked against both sides).
  want: GateOutput;
}

const PROFILE_CONFIG = JSON.stringify({
  routingProfiles: { demo: { candidates: [{ provider: "openai", model: "gpt-5.5" }] } },
});

function buildFixtures(): { dir: string; fixture: Fixture }[] {
  const root = mkdtempSync(join(tmpdir(), "ocx-labgate-"));
  const fixtures: Fixture[] = [
    { name: "empty-dir", want: { automationEnabled: false, profilesNonEmpty: false, required: false } },
    {
      name: "automation-combined-on",
      automation: [{ file: "automation-config.json", content: '{"policy": {"enabled": true}}' }],
      want: { automationEnabled: true, profilesNonEmpty: false, required: true },
    },
    {
      name: "automation-legacy-on",
      automation: [{ file: "automation-policy.json", content: '{"enabled": true}' }],
      want: { automationEnabled: true, profilesNonEmpty: false, required: true },
    },
    {
      name: "automation-legacy-off",
      automation: [{ file: "automation-policy.json", content: '{"enabled": false}' }],
      want: { automationEnabled: false, profilesNonEmpty: false, required: false },
    },
    {
      name: "combined-authority-wins",
      automation: [
        { file: "automation-config.json", content: '{"policy": {"enabled": false}}' },
        { file: "automation-policy.json", content: '{"enabled": true}' },
      ],
      want: { automationEnabled: false, profilesNonEmpty: false, required: false },
    },
    {
      name: "combined-without-policy-falls-back",
      automation: [
        { file: "automation-config.json", content: '{"scheduler": {}}' },
        { file: "automation-policy.json", content: '{"enabled": true}' },
      ],
      want: { automationEnabled: true, profilesNonEmpty: false, required: true },
    },
    {
      name: "profile-only",
      configJSON: PROFILE_CONFIG,
      want: { automationEnabled: false, profilesNonEmpty: true, required: true },
    },
    {
      name: "profile-plus-automation-off",
      configJSON: PROFILE_CONFIG,
      automation: [{ file: "automation-config.json", content: '{"policy": {"enabled": false}}' }],
      want: { automationEnabled: false, profilesNonEmpty: true, required: true },
    },
    {
      name: "profile-plus-automation-on",
      configJSON: PROFILE_CONFIG,
      automation: [{ file: "automation-config.json", content: '{"policy": {"enabled": true}}' }],
      want: { automationEnabled: true, profilesNonEmpty: true, required: true },
    },
    {
      name: "malformed-automation",
      automation: [
        { file: "automation-config.json", content: "{not json" },
        { file: "automation-policy.json", content: '{"enabled": "yes"}' },
      ],
      want: { automationEnabled: false, profilesNonEmpty: false, required: false },
    },
  ];
  return fixtures.map((fixture) => {
    const dir = join(root, fixture.name);
    mkdirSync(dir, { recursive: true });
    if (fixture.configJSON !== undefined) {
      writeFileSync(join(dir, "config.json"), fixture.configJSON);
    }
    for (const file of fixture.automation ?? []) {
      const labDir = join(dir, "lab");
      mkdirSync(labDir, { recursive: true });
      writeFileSync(join(labDir, file.file), file.content);
    }
    return { dir, fixture };
  });
}

describeGo("Go Lab activation gate differential oracle (ticket #19)", () => {
  const cases = buildFixtures();
  for (const { dir, fixture } of cases) {
    test(`gate decision matches TypeScript for "${fixture.name}"`, () => {
      // Go reads the pristine fixture first; the TS config loader may repair a
      // config.json in place (adding defaulted providers), which would
      // otherwise change what Go sees.
      const go = goGate(dir);
      expect(go).toEqual(fixture.want);
      const ts = tsGate(dir);
      expect(ts).toEqual(fixture.want);
      expect(ts).toEqual(go);
    });
  }
});
