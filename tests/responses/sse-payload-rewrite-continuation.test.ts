import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { helperPath, repoRoot } from "../helpers/repo-root";
import { ownedCrError, continuationTails } from "../helpers/messages-sse-continuation-cases";
for (const layer of ["rewrite", "tap", "reader"] as const) for (const [name, tail] of [...continuationTails, ["eof", ""]] as const) {
  test(`${layer}: suppressed late LF resumes ${name}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-rewrite-continuation-"));
    try {
      mkdirSync(join(home, "ocx")); mkdirSync(join(home, "codex"));
      const output = join(home, "result.json");
      const child = Bun.spawn([process.execPath, helperPath("messages-sse-continuation-run.ts"), `direct-${layer}`, name, output], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") }, stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 2500);
      try {
        const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (timedOut) throw new Error("No later event/EOF after the suppressed LF within 2500ms");
        if (exit !== 0) throw new Error(`Continuation fixture exited ${exit}\n${stdout}\n${stderr}`);
        const result = JSON.parse(readFileSync(output, "utf8"));
        const bytes = Buffer.from(result.body, "base64");
        expect(bytes.length).toBeGreaterThan(0);
        if (tail) expect(bytes.toString()).toContain(tail);
        expect(bytes).toEqual(Buffer.from(ownedCrError + tail));
        expect(result.sawEof).toBe(true);
      } finally { clearTimeout(timer); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
