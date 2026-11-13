import { describe, expect, spyOn, test } from "bun:test";
import { runCapabilities } from "../../src/cli/capabilities-command";
import { findCommand } from "../../src/cli/registry";
import { CAPABILITY_CONTRACTS } from "../../src/cli/capability-contracts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

describe("capabilities argument validation", () => {
  test("update, sync and capabilities help expose orchestration contracts", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-help-"));
    try {
      const launcher = spawnSync(process.execPath, [repoPath("bin/ocx.mjs"), "update", "--help"], {
        encoding: "utf8", env: { ...process.env, HOME: home, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") },
      });
      expect(launcher.status).toBe(0);
      const entry = findCommand("update")!;
      for (const flag of ["--plan", "--yes", "--json", "--expect-plan", "--not-after"]) {
        expect([entry.usage, ...entry.details ?? []].join(" ")).toContain(flag);
        expect(launcher.stdout).toContain(flag);
      }
      for (const code of ["10", "11", "12", "64"]) expect(launcher.stdout).toContain(code);
      expect(findCommand("capabilities")!.usage).toContain("--contracts");
      expect(findCommand("sync")!.details!.join(" ")).toContain("exit 7");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("contracts are present in every JSON shape and can be queried alone", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const args of [["--json"], ["--json", "--route", "/api/logs"], ["--json", "--mutating-only"], ["--json", "--route", "/missing"]]) {
        out.mockClear();
        expect(await runCapabilities(args)).toBe(args.includes("/missing") ? 4 : 0);
        expect(JSON.parse(String(out.mock.calls[0]![0])).contracts).toEqual([...CAPABILITY_CONTRACTS]);
      }
      out.mockClear();
      expect(await runCapabilities(["--contracts", "--json"])).toBe(0);
      expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual({ schemaVersion: 1, contracts: [...CAPABILITY_CONTRACTS] });
      out.mockClear();
      expect(await runCapabilities(["--contracts"])).toBe(0);
      expect(out.mock.calls.map(call => call[0])).toEqual([...CAPABILITY_CONTRACTS]);
      expect(CAPABILITY_CONTRACTS).toContain("update.orchestrated/1");
      expect(CAPABILITY_CONTRACTS).toContain("sync.home-fanout/1");
      // The explicit, exclusive route of a Remote Link (structure/remote-link.md, "Explicit route").
      expect(CAPABILITY_CONTRACTS).toContain("link.route/1");
      // ocx link add|revoke --operation-id, --require-ephemeral and the journal (structure/remote-link.md, "Operation journal").
      expect(CAPABILITY_CONTRACTS).toContain("link.operation/1");
      for (const args of [["--contracts", "--mutating-only"], ["--contracts", "--route", "/api/logs"]]) expect(await runCapabilities(args)).toBe(64);
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  test.each([
    ["--mutating-onyl"], ["extra"], ["--json", "--json"],
    ["--route", "/api/logs", "--route", "/api/usage"],
    ["--route", "/not-a-route", "--typo"], ["--route", ""],
    ["--contracts", "--route", "/api/logs"], ["--contracts", "--mutating-only"],
  ].map(args => [args]))("rejects %j without a successful payload", async args => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCapabilities(args)).toBe(64);
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  test("exposes the contract list in every JSON form", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const args of [["--json"], ["--json", "--mutating-only"], ["--json", "--route", "/not-a-route"], ["--json", "--contracts"]]) {
        out.mockClear();
        expect(await runCapabilities(args)).toBe(args.includes("/not-a-route") ? 4 : 0);
        const payload = JSON.parse(String(out.mock.calls[0]![0]));
        expect(payload.contracts).toContain("sync.home-fanout/1");
        if (args.includes("--contracts")) expect(Object.keys(payload)).toEqual(["schemaVersion", "contracts"]);
      }
      out.mockClear();
      expect(await runCapabilities(["--contracts"])).toBe(0);
      expect(out.mock.calls.map(call => call[0])).toContain("sync.home-fanout/1");
    } finally { out.mockRestore(); }
  });
  test("keeps valid no-match distinct from invalid usage", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runCapabilities(["--route", "/not-a-route", "--json"])).toBe(4);
      expect(JSON.parse(String(out.mock.calls[0]![0])).capabilities).toEqual([]);
    } finally { out.mockRestore(); }
  });
  test("invalid capability arguments advertise contracts", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCapabilities(["--invalid"])).toBe(64);
      expect(String(err.mock.calls[0]![0])).toContain("--contracts");
    } finally { err.mockRestore(); }
  });
});
