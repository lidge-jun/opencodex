/**
 * The privacy scanner must recognize a Meta Model API key.
 *
 * The `meta-muse` provider imports one of these from the Muse Code CLI, and the plan
 * names `privacy:scan` as the gate that would catch it if it ever escaped into a tracked
 * file. The pre-existing `token-looking` pattern matches `sk-`, `ghp_` and JWTs — none
 * of which resemble Meta's `LLM|<digits>|<tail>` shape.
 *
 * This exercises the REAL `scanText` used by `bun run privacy:scan`, not a copy of its
 * regex: a test that re-declared the pattern would keep passing after the production
 * detector was deleted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  scanText,
  scanTextWithFileExemptions,
} from "../../scripts/privacy-scan";

/** Assembled at runtime so this file contains no secret-shaped literal of its own. */
const canary = ["LLM", "1".repeat(16), "c".repeat(27)].join("|");

describe("privacy scan: Meta API keys", () => {
  test("flags a Meta-shaped key in a tracked file", () => {
    const findings = scanText("src/example.ts", `const key = "${canary}";`);
    expect(findings.some(f => f.kind === "meta-api-key")).toBe(true);
  });

  test("the pre-existing token patterns would have missed it", () => {
    const findings = scanText("src/example.ts", `const key = "${canary}";`);
    // Proves the new detector is doing the work, not an incidental match.
    expect(findings.some(f => f.kind === "token-looking")).toBe(false);
  });

  test("ordinary prose mentioning the prefix is not a finding", () => {
    const findings = scanText("docs/example.md", "Meta keys start with an LLM| prefix.");
    expect(findings.some(f => f.kind === "meta-api-key")).toBe(false);
  });

  test("a Bearer header carrying one is still caught", () => {
    const findings = scanText("src/example.ts", `Authorization: Bearer ${canary}`);
    expect(findings.length).toBeGreaterThan(0);
  });

  test("a public-attribution exemption stops applying after any file mutation", () => {
    const file = "LICENSES/yaml-ISC.txt";
    const text = readFileSync(file, "utf8");
    expect(scanTextWithFileExemptions(file, text)).toHaveLength(0);

    const findings = scanTextWithFileExemptions(file, `${text}\n`);
    expect(findings.some(finding => finding.kind === "email")).toBe(true);
  });

  test("a synthetic-fixture exemption stops applying after any file mutation", () => {
    const file = "tests/fixtures/guardrails-donor-rule-cases.json";
    const text = readFileSync(file, "utf8");
    expect(scanTextWithFileExemptions(file, text)).toHaveLength(0);

    const findings = scanTextWithFileExemptions(file, `${text}\n`);
    expect(findings.length).toBeGreaterThan(0);
  });
});
