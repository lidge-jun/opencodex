import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isOcxStartCommandLine, parsePidFile } from "../src/config/process-state";

const repoRoot = resolve(import.meta.dir, "..");
const goRoot = join(repoRoot, "go");

function goToolchainAvailable(): boolean {
  return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-process-state-"));
  const binary = join(dir, process.platform === "win32" ? "ocx-sidecar.exe" : "ocx-sidecar");
  const build = Bun.spawnSync(["go", "build", "-o", binary, "./cmd/ocx-sidecar"], {
    cwd: goRoot,
    env: { ...process.env, CGO_ENABLED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(
      `go build ./cmd/ocx-sidecar failed (${build.exitCode}):\n${new TextDecoder().decode(build.stderr)}`,
    );
  }
  return binary;
}

function readParseVectors(): string[] {
  return readFileSync(join(goRoot, "internal", "ocxcli", "testdata", "pid-parse-oracle.tsv"), "utf8")
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => {
      const separator = line.indexOf("\t");
      if (separator < 0) throw new Error(`invalid PID oracle row: ${line}`);
      return JSON.parse(line.slice(0, separator)) as string;
    });
}

const matcherVectors = [
  "bun run src/cli.ts start",
  '"C:/tools/bun/bin/bun.exe" "run" "src/cli/index.ts" "start"',
  "bun C:/tools/bun/install/global/node_modules/@bitkyc08/opencodex/src/cli.ts start",
  "bun C:/tools/bun/install/global/node_modules/@bitkyc08/.opencodex-3f2a/src/cli/index.ts start",
  "opencodex start",
  "C:/Users/example/AppData/Roaming/npm/ocx.cmd start",
  "/usr/local/bin/ocx start --port 10100",
  "/home/u/.opencodex/bin/opencodex start",
  "bun run src/cli.ts status",
  "bun test C:/work/opencodex/tests/config.test.ts",
  "notepad.exe",
  "ocx start-guard",
  "ocx /start",
  "python server.py --flag ocx startx",
  "C:/work/opencodex-start-guard/bin/server.exe",
  "bun run src/cli.ts restart",
];

const describeGo = goToolchainAvailable() ? describe : describe.skip;

describeGo("Go process-state differential oracle (ticket #34)", () => {
  test("matches TypeScript PID parsing and command identity", () => {
    const binary = buildSidecarBinary();
    const parse = readParseVectors();
    const input = JSON.stringify({ parse, match: matcherVectors });
    const result = Bun.spawnSync([binary, "processstatecheck", input], {
      env: { ...process.env, CGO_ENABLED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `ocx-sidecar processstatecheck failed (${result.exitCode}):\n${new TextDecoder().decode(result.stderr)}`,
      );
    }
    const output = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      parse: number[];
      match: boolean[];
    };
    expect(output.parse).toEqual(parse.map(value => parsePidFile(value) ?? 0));
    expect(output.match).toEqual(matcherVectors.map(value => isOcxStartCommandLine(value)));
  }, { timeout: 120_000 });
});
