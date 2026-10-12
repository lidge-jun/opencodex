import { expect, test } from "bun:test";

// Module fixtures must not replace persistent key rotation in neighboring endpoint tests.
if (process.env.OCX_BILLING_BUDGET_DRIVER === "1") {
  await import("../helpers/anthropic-billing-send-budget-driver");
} else {
  test("observe-only Anthropic mixed refusals retain the real send ceiling and terminal errors", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OCX_BILLING_BUDGET_DRIVER: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const [output, errors, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode, output + errors).toBe(0);
      expect(errors).toContain("3 pass");
      expect(errors).toContain("0 fail");
    } finally {
      // A parent timeout must not leave the child driver running into later tests.
      if (child.exitCode === null) child.kill();
    }
    // Covers a second Bun process starting under a loaded runner, not just the three probes.
  }, 30_000);
}
