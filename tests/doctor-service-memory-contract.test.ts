import { describe, expect, test } from "bun:test";
import { fetchServiceMemory } from "../src/cli/doctor";

type ServiceMemoryDeps = NonNullable<Parameters<typeof fetchServiceMemory>[1]>;
type TimeoutOptionIsHidden = "timeoutMs" extends keyof ServiceMemoryDeps ? false : true;

const timeoutOptionIsHidden: TimeoutOptionIsHidden = true;

describe("doctor service memory contract", () => {
  test("owns its timeout instead of accepting a caller override", () => {
    expect(timeoutOptionIsHidden).toBe(true);
  });
});
