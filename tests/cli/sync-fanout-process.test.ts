import { describe, expect, test } from "bun:test";
import { runFanoutProcess, FanoutProcessError } from "../../src/cli/sync-fanout-process";

describe("fanout process ownership", () => {
  test("returns a child exit code", async () => {
    expect(await runFanoutProcess(["sh", "-c", "exit 255"], { timeoutMs: 1000 })).toEqual({ code: 255, stdout: "", stderr: "" });
  });
  test("escalates and waits for a child that ignores TERM", async () => {
    let pid = 0;
    try {
      await runFanoutProcess(["sh", "-c", "trap '' TERM; printf '%s' $$; while :; do :; done"], { timeoutMs: 200, onSpawn: value => { pid = value; } });
      throw new Error("expected deadline");
    } catch (error) {
      expect(error).toBeInstanceOf(FanoutProcessError);
      expect((error as FanoutProcessError).reason).toBe("deadline-exceeded");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 6000);
  test("does not wait indefinitely for an inherited pipe", async () => {
    const start = Date.now();
    const result = await runFanoutProcess(["sh", "-c", "(sleep 1) & exit 0"], { timeoutMs: 3000 });
    expect(result.code).toBe(0);
    expect(Date.now() - start).toBeLessThan(900);
  });
  test("rejects output above the cap", async () => {
    await expect(runFanoutProcess(["sh", "-c", "printf 123456789"], { timeoutMs: 1000, maxOutputBytes: 4 })).rejects.toMatchObject({ reason: "ssh-output" });
  });
});
