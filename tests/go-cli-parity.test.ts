import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { createLocalAttestationChallenge, createLocalAttestationProof } from "../src/lib/local-management-attestation";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/** First CLI differential for ADR-0008 ticket #35; #36 extends its matrix. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
function goToolchainAvailable(): boolean { return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success; }
function buildGoCLI(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-cli-"));
  const binary = join(dir, process.platform === "win32" ? "ocx.exe" : "ocx");
  const result = Bun.spawnSync(["go", "build", "-o", binary, "./cmd/ocx"], { cwd: join(repoRoot, "go"), env: { ...process.env, CGO_ENABLED: "0" }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("go build ./cmd/ocx failed: " + new TextDecoder().decode(result.stderr));
  return binary;
}
const goAvailable = goToolchainAvailable();
const goCLI = goAvailable ? buildGoCLI() : null;
let testHome = "";
afterEach(async () => { delete process.env.OPENCODEX_HOME; if (testHome && existsSync(testHome)) removeTreeWithRetry(testHome); testHome = ""; });
describe.skipIf(!goAvailable || goCLI === null)("Go CLI parity (ADR-0008, ticket #35)", () => {
  test("prints byte-identical TypeScript version output", () => {
    const ts = Bun.spawnSync([process.execPath, "src/cli/index.ts", "--version"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const go = Bun.spawnSync([goCLI!, "--version"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    expect(ts.exitCode).toBe(0); expect(go.exitCode).toBe(0); expect(new TextDecoder().decode(go.stdout)).toBe(new TextDecoder().decode(ts.stdout)); expect(new TextDecoder().decode(go.stderr)).toBe("");
  });
  test("attests and reports the live TypeScript proxy health JSON", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-")); process.env.OPENCODEX_HOME = testHome; saveConfig({ port: 0, hostname: "127.0.0.1", providers: {} });
    const server = startServer(0, { localAttestationSecret: secret });
    try {
      writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: server.port, hostname: "127.0.0.1", attestationSecret: secret }));
      const challenge = createLocalAttestationChallenge(); const ts = await fetch(new URL("/healthz", server.url), { headers: { "x-opencodex-attestation-challenge": challenge } }); const tsBody = await ts.json() as Record<string, unknown>;
      expect(ts.headers.get("x-opencodex-attestation-proof")).toBe(createLocalAttestationProof(secret, challenge, process.pid, server.port));
      const go = Bun.spawn([goCLI!, "health", "--json"], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: testHome }, stdout: "pipe", stderr: "pipe" });
      expect(await go.exited).toBe(0); expect(await new Response(go.stderr).text()).toBe("");
      const goBody = JSON.parse(await new Response(go.stdout).text()) as Record<string, unknown>; for (const field of ["status", "service", "version", "pid", "port"]) expect(goBody[field]).toBe(tsBody[field]); expect(typeof goBody.uptime).toBe("number");
    } finally { await server.stop(true); }
  });
});
