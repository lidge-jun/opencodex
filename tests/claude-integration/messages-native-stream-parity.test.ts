import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperPath, repoRoot } from "../helpers/repo-root";

type Outcome = { bytes: string; calls?: { status: number; closeReason: string }[]; settlements?: { status: number; mode?: string }[]; sends?: number; status?: number; cancelled: string[] };
const outcomes: Record<string, Record<string, Outcome>> = {};
const cases = ["overflow", "throughput", "guard", "eof", "stop-error", "complete", "cap", "stall", "read-error", "cancel"];
beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ocx-messages-parity-"));
  try {
    for (const mode of ["base", "head"]) {
      const home = join(scratch, mode); mkdirSync(join(home, "ocx"), { recursive: true }); mkdirSync(join(home, "codex"));
      const output = join(home, "results.json");
      const child = Bun.spawn([process.execPath, helperPath("messages-stream-differential.ts"), mode, home, output], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") }, stdout: "pipe", stderr: "pipe" });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (exit !== 0) throw new Error(`${mode} fixture exited ${exit}\n${stdout}\n${stderr}`);
      const fixture = JSON.parse(readFileSync(output, "utf8"));
      expect(fixture.overlayProbe).toEqual(mode === "base" ? { "request-id": "req_fixture" } : {});
      outcomes[mode] = fixture.results;
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 30000);
for (const lane of ["tap", "native-fixture", "native-anthropic"]) for (const scenario of cases) {
  test(`${lane} ${scenario}: executable 72e80d280 parity`, () => {
    const key = `${lane}-${scenario}`;
    const base = outcomes.base![key]!; const head = outcomes.head![key]!;
    expect(base).toBeDefined(); expect(head).toEqual(base);
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
    if (scenario === "throughput") expect(head.bytes).toContain("too many tokens per minute");
    if (scenario === "guard" && lane !== "tap") expect(head.bytes).toContain("undeclared_tool_call");
    if (["cancel", "cap", "stall"].includes(scenario)) expect(head.cancelled.length).toBeGreaterThan(0);
  });
}
