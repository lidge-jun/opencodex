import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

interface ResolveRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runResolveCli(args: string[], home: string): Promise<ResolveRun> {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe("ocx resolve real subprocess", () => {
  test("a home whose configured port is closed resolves with a proven-absent verdict", async () => {
    // Port 9 is the suite's conventional dead port (see cli-help.test.ts): the liveness
    // fallback probes the configured port when no records exist, and on a developer
    // machine a real proxy can answer the 10100 default — that is findLiveProxy working
    // as designed, so the deterministic verdict case pins a closed port instead.
    const home = mkdtempSync(join(tmpdir(), "ocx-resolve-closed-port-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 9 }), "utf8");
      const run = await runResolveCli(["resolve", "--json"], home);
      expect(run.exitCode).toBe(0);
      const parsed = JSON.parse(run.stdout) as {
        schema: string;
        configHome: string;
        port: { effective: number; configured: number; source: string };
        liveness: { status: string; pid: null; port: null; source: null };
      };
      expect(parsed.schema).toBe("ocx-resolve/1");
      expect(parsed.configHome).toBe(home);
      expect(parsed.port).toEqual({ effective: 9, configured: 9, source: "config" });
      expect(parsed.liveness).toEqual({ status: "absent-proven", pid: null, port: null, source: null });
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("a configured custom port stays the effective port while nothing is live", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-resolve-custom-port-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 23456 }), "utf8");
      const run = await runResolveCli(["resolve", "--json"], home);
      expect(run.exitCode).toBe(0);
      const parsed = JSON.parse(run.stdout) as { port: { effective: number; configured: number; source: string } };
      expect(parsed.port).toEqual({ effective: 23456, configured: 23456, source: "config" });
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("any argument is a usage error before preflight side effects", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-resolve-usage-"));
    try {
      const run = await runResolveCli(["resolve", "extra"], home);
      expect(run.exitCode).toBe(64);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("Usage: ocx resolve");
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("help is registered for the verb", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-resolve-help-"));
    try {
      mkdirSync(home, { recursive: true });
      const run = await runResolveCli(["help", "resolve"], home);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("Usage: ocx resolve");
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("the default form prints human output, not JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-resolve-human-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 9 }), "utf8");
      const run = await runResolveCli(["resolve"], home);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain(`Config home: ${home}`);
      expect(run.stdout).toContain("No live proxy (absence proven); effective port 9 (configured).");
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("an invalid config.json is refused rather than resolved to defaults", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-resolve-invalid-config-"));
    try {
      writeFileSync(join(home, "config.json"), "{ not json", "utf8");
      const run = await runResolveCli(["resolve", "--json"], home);
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("refusing to guess");
    } finally {
      removeTreeWithRetry(home);
    }
  });
});
