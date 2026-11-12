import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { helperPath, repoPath, repoRoot } from "../helpers/repo-root";
const expected: Record<string, [number, string | null]> = {
  "kiro-continuation": [200, null],
  config: [400, null], "workflow-unbound": [429, null],
  "pool-refresh": [529, null],
  "native-pacing-send": [429, null], "native-pacing-preflight": [429, null],
  "cooldown-unpinned": [429, null], "hard-lock": [429, null], recovery: [429, null],
  "combo-count": [529, null],
  copilot: [403, null],
  "chat-roster": [403, "permission_denied"], provider: [403, null], "body-overflow": [502, null], "body-overflow-count": [502, null], "body-stall": [504, null],
  "scope-direct": [403, null], discovery: [401, null], muse: [401, null], "native-usage": [429, null],
  roster: [403, null], "roster-count": [200, null], "oauth-login": [401, null], pacing: [429, null], scope: [403, null], combo: [529, null], workflow: [429, null], cooldown: [429, null], input: [400, "context_length_exceeded"], outbound: [413, null], inbound: [413, null], send: [429, null], model: [400, null], storage: [529, null],
};
for (const kind of ["kiro-continuation", "config", "workflow-unbound", "pool-refresh", "native-pacing-send", "native-pacing-preflight", "cooldown-unpinned", "hard-lock", "recovery", "combo-count", "copilot", "chat-roster", "provider", "body-overflow", "body-overflow-count", "body-stall", "scope-direct", "discovery", "muse", "native-usage", "roster", "roster-count", "oauth-login", "pacing", "scope", "combo", "workflow", "cooldown", "input", "outbound", "inbound", "send", "model", "storage"]) test(`Messages fixed refusal ${kind}`, async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-local-refusal-")); mkdirSync(join(home, "ocx")); mkdirSync(join(home, "codex"));
  try {
    const red = kind === "config" || kind === "native-pacing-preflight" ? join(home, "red") : undefined;
    if (red) for (const path of ["src/lib/client-error-body.ts", "src/server/claude-messages.ts", "src/server/messages-native.ts", "src/claude/failure-verdict.ts"]) {
      const target = join(red, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "// L7_RED_SOURCE_MARKER\n" + readFileSync(repoPath(path), "utf8"));
    }
    const env = { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") };
    delete env.MESSAGES_RED_SOURCE;
    if (red) env.MESSAGES_RED_SOURCE = red;
    const child = Bun.spawn([process.execPath, helperPath("messages-proxy-refusal-case.ts"), kind], { cwd: repoRoot(), env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${kind} exited ${code}: ${stderr}`);
    const result = JSON.parse(stdout.split("REFUSAL_RESULT ").at(-1)!);
    console.info(`REFUSAL_STATUS ${kind} ${result.status} ${result.code}`);
    expect(result.text.length).toBeGreaterThan(0);
    expect([result.status, result.code]).toEqual(expected[kind]!);
    if (red) {
      expect(result.hooks.redFilterChecks.length).toBeGreaterThan(0);
      expect(result.hooks.redFilterChecks.every((check: { forward: boolean; backward: boolean }) => check.forward && check.backward)).toBe(true);
    } else expect(result.hooks.redInputs).toEqual([]);
    if (kind === "config" || kind === "workflow-unbound") expect(result.hooks.upstreamHits).toBeGreaterThan(0);
    if (kind === "config") for (const path of ["src/lib/client-error-body.ts", "src/server/claude-messages.ts", "src/claude/failure-verdict.ts"]) {
      expect(result.hooks.redInputs).toContainEqual({ path, marker: true });
    }
    if (kind === "native-pacing-preflight") {
      expect(result.hooks.nativeHits).toBeGreaterThan(0);
      expect(result.hooks.redInputs).toContainEqual({ path: "src/server/messages-native.ts", marker: true });
    }
    if (kind === "kiro-continuation") {
      expect(result.fetched).toBe(1); expect(result.text).not.toContain(result.absent);
      const error = result.text.split("\n").filter((line: string) => line.startsWith("data: ")).map((line: string) => JSON.parse(line.slice(6))).find((row: any) => row.type === "error");
      expect(error.error.message).toBe("The requested model is not allowed for this API key.");
    } else if (kind === "roster-count") { expect(result.status).toBe(200); expect(Number.isFinite(JSON.parse(result.text).input_tokens)).toBe(true); }
    else if (kind === "chat-roster") expect(result.text).toContain(result.absent);
    else { expect(result.text).not.toContain(result.absent); expect(result.status).toBeGreaterThanOrEqual(400); }
    if (kind === "copilot") { expect(result.copilotCalls).toEqual(["/models", "/models/session"]); expect(result.text).not.toContain("zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e"); }
    if (kind === "roster") { expect(result.status).toBe(403); expect(result.code).toBeNull(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);

test("presentation metadata preserves construction ownership across clones", async () => {
  const { markProxyError, carryProxyError, proxyErrorPresentation, isProxyError } = await import("../../src/lib/client-error-body");
  const source = markProxyError(Response.json({ error: { message: "fixture" } }, { status: 403 }), "roster");
  const clone = carryProxyError(source, new Response(source.clone().body, { status: 403 }));
  expect(proxyErrorPresentation(clone)).toBe("roster");
  const replacement = carryProxyError(source, Response.json({ error: { message: "buffer limit" } }, { status: 413 }));
  expect(isProxyError(replacement)).toBe(true); expect(proxyErrorPresentation(replacement)).toBeUndefined();
});

test("message registration reaches contexts carried before construction", async () => {
  const { carryProxyErrorContext, rememberProxyErrorMessage, proxyMessagePresentation } = await import("../../src/lib/client-error-body");
  const source = {}, target = {};
  carryProxyErrorContext(source, target);
  rememberProxyErrorMessage(source, "fixture", { status: 403, type: "permission_error", presentation: "roster" });
  expect(proxyMessagePresentation(target, "fixture", { type: "permission_error" })).toBe("roster");
  expect(proxyMessagePresentation({}, "fixture", { type: "permission_error" })).toBeUndefined();
});
