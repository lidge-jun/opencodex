import { expect, test } from "bun:test";
import { isOrchestratedUpdateArgv, parseOrchestratedUpdateArgs } from "../../src/update/orchestrated-arguments.mjs";

test("orchestrated arguments validate selectors, deadline, and plan binding", () => {
  expect(parseOrchestratedUpdateArgs(["--plan", "--json", "--tag", "preview"])).toMatchObject({ ok: true, mode: "plan", tag: "preview" });
  expect(parseOrchestratedUpdateArgs(["--yes", "--json", "--version", "2.1.0-preview.2", "--expect-plan", "A".repeat(43), "--not-after", "123456"])).toMatchObject({ ok: true, mode: "apply", version: "2.1.0-preview.2", notAfter: 123456 });
  for (const args of [
    ["--plan"], ["--yes", "--json", "--plan"], ["--plan", "--json", "--tag", "latest", "--version", "2.0.0"],
    ["--plan", "--json", "--version", "01.2.3"], ["--plan", "--json", "--version", "1.2.3-01"],
    ["--yes", "--json", "--not-after", "0"], ["--yes", "--json", "--not-after", "9007199254740992"],
    ["--yes", "--json", "--expect-plan", "short"], ["--plan", "--json", "--not-after", "5"],
    ["--yes", "--json", "--tag", "latest"],
    ["--plan", "--json", "--tag", "latest", "--tag", "preview"],
  ]) expect(parseOrchestratedUpdateArgs(args)).toMatchObject({ ok: false });
});

test("orchestrated or malformed orchestration flags never reach legacy update", () => {
  for (const args of [["--plan"], ["--yes"], ["--json"], ["--not-after=3"], ["--expect-plan", "token"]]) expect(isOrchestratedUpdateArgv(args)).toBe(true);
  expect(isOrchestratedUpdateArgv(["--tag", "latest"])).toBe(false);
  expect(isOrchestratedUpdateArgv(["--version", "2.0.0", "--orchestrated-result", "/fixture"])).toBe(false);
});
