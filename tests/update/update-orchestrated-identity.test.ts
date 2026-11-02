import { expect, test } from "bun:test";
import { inspectOrchestratedServingIdentity } from "../../src/update/orchestrated-identity";

const command = ["/fixture/bun", "/fixture/install/src/cli/index.ts"];
const record = JSON.stringify({ pid: 22, port: 10101, hostname: "127.0.0.1", attestationSecret: "a".repeat(43), command });
const base = {
  readRecord: () => ({ kind: "record" as const, raw: record }),
  prove: async () => "proven" as const,
  probeConfigured: async () => "dead" as const,
  realpath: (path: string) => path,
};

test("identity requires a stable, attested runtime record", async () => {
  expect(await inspectOrchestratedServingIdentity(base)).toMatchObject({ kind: "live", servingRoot: "/fixture/install", runtime: { pid: 22, command } });
  for (const proof of ["refuted", "indeterminate"] as const) {
    expect(await inspectOrchestratedServingIdentity({ ...base, prove: async () => proof })).toEqual({ kind: "unknown" });
  }
  let count = 0;
  expect(await inspectOrchestratedServingIdentity({ ...base, readRecord: () => ({ kind: "record", raw: ++count === 1 ? record : record + " " }) })).toEqual({ kind: "unknown" });
  expect(await inspectOrchestratedServingIdentity({ ...base, readRecord: () => ({ kind: "record", raw: JSON.stringify({ pid: 22, port: 10101, hostname: "127.0.0.1", command }) }) })).toEqual({ kind: "unknown" });
});

test("only a missing record plus a dead configured listener proves absence", async () => {
  const absent = { ...base, readRecord: () => ({ kind: "missing" as const }) };
  expect(await inspectOrchestratedServingIdentity(absent)).toEqual({ kind: "absent" });
  expect(await inspectOrchestratedServingIdentity({ ...absent, probeConfigured: async () => "unknown" })).toEqual({ kind: "unknown" });
  expect(await inspectOrchestratedServingIdentity({ ...absent, probeConfigured: async () => "live" })).toEqual({ kind: "unknown" });
  expect(await inspectOrchestratedServingIdentity({ ...base, readRecord: () => ({ kind: "unreadable" }) })).toEqual({ kind: "unknown" });
});
