import { describe, expect, test } from "bun:test";

describe("CL-07 fabric persistence export boundary", () => {
  test("authority-free persistence helper is module-private", async () => {
    const observeExports = await import("../src/lab/fabric/observe");

    expect("persistFabricOutcome" in observeExports).toBe(false);
    expect(typeof observeExports.persistFabricRunResult).toBe("function");
  });
});
