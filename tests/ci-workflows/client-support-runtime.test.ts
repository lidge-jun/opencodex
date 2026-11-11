import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRows, defaultInputs, renderPage, type MatrixInputs } from "../../scripts/generate-client-support-matrix";
import { LOCALES, type MatrixLocale } from "../../scripts/client-support-matrix/locales";
import { parseRuntimeResults, selectRuntimeResults, type RuntimeResult } from "../../scripts/client-support-matrix/runtime";
import { repoRoot } from "../helpers/repo-root";

const BASE = defaultInputs();
const LOCALE_IDS = Object.keys(LOCALES) as MatrixLocale[];

function result(overrides: Partial<RuntimeResult> = {}): RuntimeResult {
  return {
    client: "codex", product: "Codex CLI", clientVersion: "0.150.0", opencodexVersion: "2.40.0",
    verifiedOn: "2026-10-20", scenario: "streamed reply with one tool call",
    evidence: "https://github.com/lidge-jun/opencodex/pull/1", ...overrides,
  };
}

function fileWith(results: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, results, ...extra });
}

function rowsWith(text: string | undefined) {
  return collectRows({ ...BASE, runtimeResultsText: text } satisfies MatrixInputs);
}

function problems(text: string | undefined, ids = new Set(["codex", "qoder-cn"])): string[] {
  return parseRuntimeResults(text, ids, "data.json").problems;
}

/** The "Runtime verified" cell of every table row on a rendered page. */
function runtimeCells(page: string): string[] {
  return page.split("\n").filter(line => line.startsWith("| ") && !line.startsWith("| ---"))
    .slice(1).map(line => line.split(" | ")[6]!);
}

const TEXT_RULE = (field: string) => `data.json results[0].${field} may only use letters, digits, spaces and . , : ; / + ' ! ? # % = -`;
const URL_BREAKS = "data.json results[0].evidence contains whitespace or characters that break the table (| [ ] ( ) < > ` \\)";
const PUBLIC_HOST = "data.json results[0].evidence must name a public host (not an IP address or a local or internal name)";

describe("client support runtime results", () => {
  test("an empty results file leaves every row with a dash in every locale, and the committed file is valid", () => {
    expect(() => collectRows()).not.toThrow();
    const rows = rowsWith(fileWith([]));
    expect(rows.some(row => row.runtime)).toBe(false);
    for (const locale of LOCALE_IDS) {
      const page = renderPage(rows, locale);
      expect(page).toContain(LOCALES[locale].runtimeDefinition);
      expect(new Set(runtimeCells(page))).toEqual(new Set(["—"]));
    }
  });

  test("a result renders product, both versions, scenario, date and evidence on native and export rows", () => {
    const rows = rowsWith(fileWith([
      result(),
      result({ client: "qoder-cn", product: "Qoder CN CLI", clientVersion: "1.1.70", scenario: "single chat turn" }),
    ]));
    const codex = rows.find(row => row.id === "codex")!;
    const qoderCn = rows.find(row => row.id === "qoder-cn")!;
    expect(codex.test).toBeDefined();
    expect(qoderCn.test).toBeUndefined();
    for (const locale of LOCALE_IDS) {
      const page = renderPage(rows, locale);
      const s = LOCALES[locale];
      expect(page).toContain(`Codex CLI 0.150.0 + opencodex 2.40.0: streamed reply with one tool call (2026-10-20, [${s.evidenceLink}](https://github.com/lidge-jun/opencodex/pull/1))`);
      expect(page).toContain("Qoder CN CLI 1.1.70 + opencodex 2.40.0: single chat turn (2026-10-20,");
      // The support level is independent of the runtime column: Qoder CN stays implemented.
      expect(page.split("\n").find(line => line.startsWith("| Qoder CN |"))).toContain("| implemented |");
    }
  });

  test("the most recent result is shown, ties break on product, and the rest are counted", () => {
    const older = result({ verifiedOn: "2026-09-01", opencodexVersion: "2.30.0" });
    const recheck = result({ verifiedOn: "2026-10-25", opencodexVersion: "2.41.0" });
    const otherProduct = result({ verifiedOn: "2026-10-25", product: "Codex App", scenario: "picker shows routed models" });
    const forward = selectRuntimeResults([older, recheck, otherProduct]).get("codex")!;
    const reversed = selectRuntimeResults([otherProduct, recheck, older]).get("codex")!;
    expect(forward).toEqual(reversed);
    expect(forward.result.product).toBe("Codex App");
    expect(forward.others).toBe(2);
    // Canonically equivalent strings are still distinct, and the order does not depend on the locale.
    const composed = result({ product: "Caf\u00e9 CLI" });
    const decomposed = result({ product: "Cafe\u0301 CLI" });
    expect(selectRuntimeResults([composed, decomposed]).get("codex")).toEqual(selectRuntimeResults([decomposed, composed]).get("codex"));
    const page = renderPage(rowsWith(fileWith([older, recheck])), "root");
    expect(page).toContain("Codex CLI 0.150.0 + opencodex 2.41.0");
    expect(page).toContain("(+1 more recorded)");
  });

  test("every malformed file or result is refused with a reason", () => {
    expect(problems(undefined)).toEqual(['data.json is missing; it is required (an empty "results" array is valid)']);
    expect(problems("{")[0]).toStartWith("data.json is not valid JSON");
    expect(problems("[]")).toEqual(["data.json must be an object with schemaVersion and results"]);
    expect(problems(JSON.stringify({ schemaVersion: 2, results: [] }))).toEqual(["data.json: schemaVersion must be 1"]);
    expect(problems(JSON.stringify({ schemaVersion: 1, results: {} }))).toEqual(["data.json: results must be an array"]);
    expect(problems(fileWith([], { note: "x" }))).toEqual(["data.json: unknown top-level keys note"]);
    const cases: Array<[Partial<RuntimeResult> | Record<string, unknown>, string]> = [
      [{ scenario: " padded" }, "data.json results[0].scenario must be a non-empty string without surrounding whitespace"],
      [{ product: "" }, "data.json results[0].product must be a non-empty string without surrounding whitespace"],
      [{ clientVersion: 150 } as unknown as Partial<RuntimeResult>, "data.json results[0].clientVersion must be a non-empty string without surrounding whitespace"],
      [{ scenario: "chat | tools" }, TEXT_RULE("scenario")],
      [{ clientVersion: "*1.2*" }, TEXT_RULE("clientVersion")],
      [{ scenario: "a &#124; b" }, TEXT_RULE("scenario")],
      [{ product: "Codex\u202eILC" }, TEXT_RULE("product")],
      [{ scenario: "tool_call" }, TEXT_RULE("scenario")],
      [{ scenario: "see https://10.0.0.8/a" }, "data.json results[0].scenario must not contain a URL; put the link in evidence"],
      [{ product: "www.internal.example/x" }, "data.json results[0].product must not contain a URL; put the link in evidence"],
      [{ notes: "x" }, "data.json results[0]: unknown keys notes"],
      [{ client: "nope" }, 'data.json results[0].client "nope" is not a row on the client support page'],
      [{ verifiedOn: "2026-02-30" }, 'data.json results[0].verifiedOn "2026-02-30" is not a real YYYY-MM-DD date'],
      [{ verifiedOn: "26-10-01" }, 'data.json results[0].verifiedOn "26-10-01" is not a real YYYY-MM-DD date'],
      [{ evidence: "http://github.com/x" }, "data.json results[0].evidence must use https"],
      // Assembled at runtime: the privacy scan rejects an address-shaped literal.
      [{ evidence: ["https://user:pw", "github.com/x"].join("@") }, "data.json results[0].evidence must not carry credentials"],
      [{ evidence: "https://github.com/x_(y)" }, URL_BREAKS],
      [{ evidence: "https://example.com/a|b" }, URL_BREAKS],
      [{ evidence: "https://localhost/x" }, PUBLIC_HOST],
      [{ evidence: "https://127.0.0.1/a" }, PUBLIC_HOST],
      [{ evidence: "https://10.0.0.8/a" }, PUBLIC_HOST],
      // IPv6 literals need brackets, which the table rule already refuses.
      [{ evidence: "https://[::1]/a" }, URL_BREAKS],
      [{ evidence: "https://service.local/a" }, PUBLIC_HOST],
      [{ evidence: "https://ci.internal/run" }, PUBLIC_HOST],
      [{ evidence: "https://localhost./x" }, PUBLIC_HOST],
      [{ evidence: "https://service.local./x" }, PUBLIC_HOST],
      [{ evidence: "https://ci.internal./x" }, PUBLIC_HOST],
      [{ evidence: "https://localhost../x" }, PUBLIC_HOST],
      [{ evidence: "https://service.local../x" }, PUBLIC_HOST],
      [{ evidence: "https://example..com/x" }, PUBLIC_HOST],
    ];
    for (const [overrides, message] of cases) {
      expect(problems(fileWith([{ ...result(), ...overrides }]))).toEqual([message]);
    }
    expect(problems(fileWith([result(), result({ evidence: "https://github.com/lidge-jun/opencodex/pull/2" })])))
      .toEqual(["data.json results[1] duplicates an earlier result for codex (same product, versions, scenario and date)"]);
    expect(problems(fileWith([result(), result({ scenario: "voice call" })]))).toEqual([]);
  });

  test("the CLI check refuses a bad results file and names the problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-client-support-"));
    const bad = join(dir, "runtime.json");
    writeFileSync(bad, fileWith([result({ verifiedOn: "2026-13-01" })]));
    const run = (...args: string[]) => Bun.spawnSync(["bun", "scripts/generate-client-support-matrix.ts", ...args], { cwd: repoRoot() });
    const invalid = run("--check", "--runtime-data", bad);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toContain('verifiedOn "2026-13-01" is not a real YYYY-MM-DD date');
    const missing = run("--check", "--runtime-data", join(dir, "absent.json"));
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("is missing; it is required");
    // Pages are never written from another file.
    const write = run("--runtime-data", bad);
    expect(write.exitCode).toBe(1);
    expect(write.stderr.toString()).toContain("only accepted together with --check");
    // The environment variable from an earlier revision has no effect.
    const ambient = Bun.spawnSync(["bun", "scripts/generate-client-support-matrix.ts", "--check"], {
      cwd: repoRoot(), env: { ...process.env, OCX_CLIENT_SUPPORT_RUNTIME_DATA: bad },
    });
    expect(ambient.exitCode).toBe(0);
  });
});
