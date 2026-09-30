import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, validateConfigCandidate } from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function candidate(redirects: unknown) {
  return { ...getDefaultConfig(), blockedModelRedirects: redirects };
}

test("configuration writes reject malformed blocked-model redirect maps", () => {
  for (const redirects of [null, [], "m1", { "": "m2" }, { m1: "" }, { m1: "  " }, { m1: 3 }]) {
    const result = validateConfigCandidate(candidate(redirects));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("blockedModelRedirects");
  }
  expect(validateConfigCandidate(candidate({ m1: "m2" })).ok).toBe(true);
});

test("malformed hand edits degrade the redirect map with a diagnostic and load warning", () => {
  const raw = JSON.stringify(candidate({ m1: "" }));
  const diagnostics = configDiagnosticsFromRaw(raw);
  expect(diagnostics.source).toBe("file");
  expect(diagnostics.config.blockedModelRedirects).toBeUndefined();
  expect(diagnostics.warnings?.join(" ")).toContain("blockedModelRedirects ignored");

  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-blocked-redirects-"));
  process.env.OPENCODEX_HOME = home;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeFileSync(getConfigPath(), raw, "utf8");
    expect(loadConfig().blockedModelRedirects).toBeUndefined();
    expect(warning.mock.calls.some(call => String(call[0]).includes("invalid blockedModelRedirects"))).toBe(true);
  } finally {
    warning.mockRestore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});
