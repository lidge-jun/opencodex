import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePath, helperPath, repoRoot } from "../helpers/repo-root";

type Outcome = { bytes: string; calls?: { status: number; closeReason: string }[]; settlements?: { status: number; mode?: string }[]; sends?: number; status?: number; cancelled: string[] };
const outcomes: Record<string, Record<string, Outcome>> = {};
const cases = ["overflow", "throughput", "guard", "eof", "stop-error", "complete", "cap", "stall", "read-error", "cancel"];
beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocx-messages-parity-"));
  try {
    const golden = JSON.parse(readFileSync(fixturePath("messages-native-stream-parity.json"), "utf8"));
    expect(golden.baseCommit).toBe("895a859893147d3056ebd1881ec398ab03b037d2");
    outcomes.base = golden.results;
    for (const mode of ["head"]) {
      const home = join(scratch, mode); mkdirSync(join(home, "ocx"), { recursive: true }); mkdirSync(join(home, "codex"));
      const output = join(home, "results.json");
      const child = Bun.spawn([process.execPath, helperPath("messages-stream-differential.ts"), mode, home, output], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") }, stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (exit !== 0) throw new Error(`${mode} fixture exited ${exit}\n${stdout}\n${stderr}`);
      const fixture = JSON.parse(readFileSync(output, "utf8"));
      outcomes[mode] = fixture.results;
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
for (const lane of ["tap", "native-fixture", "native-anthropic"]) for (const scenario of cases) {
  test(`${lane} ${scenario}: executable 895a85989 parity`, () => {
    const key = `${lane}-${scenario}`;
    const base = outcomes.base![key]!; const head = outcomes.head![key]!;
    expect(base).toBeDefined();
    const { bytes: baseBytes, ...baseFacts } = base;
    const { bytes: headBytes, ...headFacts } = head;
    // A cancel now keeps the usage it already received (#7374 review); the base dropped it.
    if (scenario === "cancel" && lane !== "tap") {
      expect(head).toHaveProperty("usage", { inputTokens: 5, outputTokens: 0 });
      expect({ ...headFacts, usage: undefined }).toEqual({ ...baseFacts, usage: undefined });
    } else expect(headFacts).toEqual(baseFacts);
    // Changed client rows only: owned overflow data; fixed throughput/stall/cap/read wording.
    const changed = lane !== "tap" && ["overflow", "throughput", "cap", "stall", "read-error"].includes(scenario);
    if (changed) {
      expect(headBytes.length).toBeGreaterThan(0);
      expect(headBytes).not.toBe(baseBytes);
      expect(headBytes).not.toContain("zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e");
      if (scenario === "stall") expect(headBytes).not.toContain("1s");
      if (scenario === "cap") expect(headBytes).not.toContain("32 bytes");
      if (scenario === "read-error") expect(headBytes).not.toContain("fixture stream read failure");
    } else expect(headBytes).toBe(baseBytes);
    if (scenario === "cancel") expect(head.bytes).toBe(""); else expect(head.bytes.length).toBeGreaterThan(0);
    if (lane === "tap") {
      expect(head.calls).toHaveLength(1);
      expect(head.calls![0]!.status).toBe(scenario === "cancel" ? 499 : ["overflow", "throughput", "complete"].includes(scenario) ? 200 : 502);
    } else {
      expect(head.status).toBe(200); expect(head.sends).toBe(1); expect(head.settlements).toHaveLength(1);
      expect(head.settlements![0]!.mode).toBe("native");
      expect(head.settlements![0]!.status).toBe(scenario === "cancel" ? 499 : ["overflow", "throughput", "complete"].includes(scenario) ? 200 : 502);
    }
    if (scenario === "overflow") expect(head.bytes).toContain("prompt is too long");
    if (scenario === "throughput") expect(head.bytes).toContain(lane === "tap" ? "too many tokens per minute" : "The provider rate limit was reached; retry later.");
    if (scenario === "guard" && lane !== "tap") expect(head.bytes).toContain("undeclared_tool_call");
    if (["cancel", "cap", "stall"].includes(scenario)) expect(head.cancelled.length).toBeGreaterThan(0);
  });
}
