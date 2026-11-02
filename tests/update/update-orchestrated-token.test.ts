import { expect, test } from "bun:test";
import { createUpdatePlanToken } from "../../src/update/orchestrated-token.mjs";

test("plan token binds canonical install and runtime fields without the attestation secret", () => {
  const input = {
    currentVersion: "1.0.0", targetVersion: "1.1.0", installer: "npm",
    cliRoot: "/fixture/one", servingRoot: "/fixture/one", runtimeOwner: "service",
    runtime: { pid: 45, port: 10101, hostname: "127.0.0.1", command: ["/fixture/bun", "/fixture/one/src/cli/index.ts"] },
  };
  const token = createUpdatePlanToken(input);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(createUpdatePlanToken({ ...input, runtime: { ...input.runtime } })).toBe(token);
  expect(createUpdatePlanToken({ ...input, runtime: { ...input.runtime, pid: 46 } })).not.toBe(token);
  expect(createUpdatePlanToken({ ...input, servingRoot: "/fixture/two" })).not.toBe(token);
  expect(createUpdatePlanToken({ ...input, runtime: { ...input.runtime, command: [...input.runtime.command, "other"] } })).not.toBe(token);
  const runtimeWithSecret = { ...input.runtime, attestationSecret: "fixture-secret" };
  expect(createUpdatePlanToken({ ...input, runtime: runtimeWithSecret })).toBe(token);
});
