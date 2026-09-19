import { describe, expect, test } from "bun:test";
import { parseOptions } from "../../src/cli/skill";

const COMMON = new Set(["--agent", "--scope", "--dry-run", "--node", "--force-overwrite-unmanaged"]);

describe("skill CLI parseOptions strict parsing", () => {
  test("rejects unknown options before any deployment", () => {
    const result = parseOptions(["demo.skill", "--agen", "codex"], COMMON);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown option: --agen");
  });

  test("rejects missing values for --agent / --scope / --from / --to", () => {
    for (const [args, supported] of [
      [["demo.skill", "--agent"], COMMON],
      [["demo.skill", "--scope"], COMMON],
      [["demo.skill", "--from"], new Set(["--from", "--to"])],
      [["demo.skill", "--to"], new Set(["--from", "--to"])],
    ] as const) {
      const result = parseOptions([...args], new Set(supported));
      expect(result.ok, args.join(" ")).toBe(false);
      if (!result.ok) expect(result.error, args.join(" ")).toContain("requires a value");
    }
  });

  test("parses valid deploys with positionals and flags", () => {
    const result = parseOptions(
      ["demo.skill", "--agent", "codex", "--scope", "project", "--dry-run"],
      COMMON,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.positionals).toEqual(["demo.skill"]);
    expect(result.options["--agent"]).toEqual(["codex"]);
    expect(result.options["--scope"]).toEqual(["project"]);
    expect(result.options["--dry-run"]).toEqual(["true"]);
  });

  test("node add supported options parse values", () => {
    const result = parseOptions(
      ["vps.x", "--kind", "ssh", "--environment", "staging", "--host-key-fingerprint", "SHA256:abc"],
      new Set(["--kind", "--environment", "--hostname", "--port", "--username", "--auth-ref", "--host-key-fingerprint", "--allowed-root", "--tag"]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.positionals).toEqual(["vps.x"]);
    expect(result.options["--kind"]).toEqual(["ssh"]);
    expect(result.options["--host-key-fingerprint"]).toEqual(["SHA256:abc"]);
  });

  test("a flag-shaped token is not consumed as a value", () => {
    const result = parseOptions(["demo.skill", "--agent", "--dry-run"], COMMON);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("requires a value");
  });
});
