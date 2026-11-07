import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelemetryStatsV1 } from "../../services/telemetry-collector/src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";

const _assertAvgDailyActiveInstallsType: TelemetryStatsV1["totals"]["avgDailyActiveInstalls"] = 0;

describe("telemetry collector typecheck", () => {
  test("services/telemetry-collector typechecks cleanly with the repository toolchain", () => {
    expect(typeof _assertAvgDailyActiveInstallsType).toBe("number");
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "check",
        "--no-script",
        "--noEmit",
        "-p",
        repoPath("services", "telemetry-collector", "tsconfig.json"),
      ],
      {
        cwd: repoRoot(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = proc.stdout.toString() + proc.stderr.toString();
    expect({ exitCode: proc.exitCode, output }).toEqual({
      exitCode: 0,
      output: expect.any(String),
    });
  });

  test("collector typecheck catches an injected type error in a temporary copy", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ocx-collector-typecheck-"));
    try {
      mkdirSync(join(tempRoot, "src", "telemetry"), { recursive: true });
      mkdirSync(join(tempRoot, "services", "telemetry-collector"), { recursive: true });
      cpSync(repoPath("tsconfig.json"), join(tempRoot, "tsconfig.json"));
      symlinkSync(
        repoPath("node_modules"),
        join(tempRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      cpSync(
        repoPath("src", "telemetry", "contract.ts"),
        join(tempRoot, "src", "telemetry", "contract.ts"),
      );
      cpSync(
        repoPath("services", "telemetry-collector"),
        join(tempRoot, "services", "telemetry-collector"),
        { recursive: true },
      );

      // Inject a type error against TelemetryStatsV1 / contract types
      writeFileSync(
        join(tempRoot, "services", "telemetry-collector", "src", "injected-error.ts"),
        [
          'import type { TelemetryStatsV1 } from "./types";',
          'export const brokenStats: TelemetryStatsV1["range"] = "14d";',
        ].join("\n"),
      );

      const proc = Bun.spawnSync(
        [
          process.execPath,
          "check",
          "--no-script",
          "--noEmit",
          "-p",
          join(tempRoot, "services", "telemetry-collector", "tsconfig.json"),
        ],
        {
          cwd: tempRoot,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = proc.stdout.toString() + proc.stderr.toString();
      expect(proc.exitCode).not.toBe(0);
      expect(output).toContain("TS2322");
    } finally {
      removeTreeWithRetry(tempRoot);
    }
  });

  test("collector tsconfig excludes bun-types so Bun globals fail typecheck", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ocx-collector-nobun-"));
    try {
      mkdirSync(join(tempRoot, "src", "telemetry"), { recursive: true });
      mkdirSync(join(tempRoot, "services", "telemetry-collector"), { recursive: true });
      cpSync(repoPath("tsconfig.json"), join(tempRoot, "tsconfig.json"));
      symlinkSync(
        repoPath("node_modules"),
        join(tempRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      cpSync(
        repoPath("src", "telemetry", "contract.ts"),
        join(tempRoot, "src", "telemetry", "contract.ts"),
      );
      cpSync(
        repoPath("services", "telemetry-collector"),
        join(tempRoot, "services", "telemetry-collector"),
        { recursive: true },
      );

      writeFileSync(
        join(tempRoot, "services", "telemetry-collector", "src", "injected-bun.ts"),
        "export const leakedBunGlobal = Bun.version;\n",
      );

      const proc = Bun.spawnSync(
        [
          process.execPath,
          "check",
          "--no-script",
          "--noEmit",
          "-p",
          join(tempRoot, "services", "telemetry-collector", "tsconfig.json"),
        ],
        {
          cwd: tempRoot,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = proc.stdout.toString() + proc.stderr.toString();
      expect(proc.exitCode).not.toBe(0);
      expect(output).toContain("Cannot find name 'Bun'");
    } finally {
      removeTreeWithRetry(tempRoot);
    }
  });
});
