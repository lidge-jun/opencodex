import { expect, test } from "bun:test";
import { isOrchestratedUpdateArgv, parseOrchestratedUpdateArgs, parseOrchestratedChildArgs } from "../../src/update/orchestrated-arguments.mjs";

test("internal child flags require the parent environment and an exact pin", () => {
  const args = ["--version", "2.1.0", "--orchestrated-expect", "encoded", "--orchestrated-result", "/tmp/result", "--not-after", "123"];
  const child = { OCX_UPDATE_ORCHESTRATED_CHILD: "1", OCX_UPDATE_RESULT_CAPABILITY: "c".repeat(43) };
  expect(parseOrchestratedChildArgs(args, {})).toEqual({ ok: false });
  expect(parseOrchestratedChildArgs(args, child)).toMatchObject({ ok: true, version: "2.1.0", expect: "encoded", resultPath: "/tmp/result", resultCapability: "c".repeat(43), notAfter: 123 });
  for (const capability of [undefined, "", "c".repeat(42), "c".repeat(44), "!".repeat(43)]) {
    expect(parseOrchestratedChildArgs(args, { ...child, OCX_UPDATE_RESULT_CAPABILITY: capability })).toEqual({ ok: false });
  }
  for (const invalid of [args.slice(2), [...args, "--tag", "latest"], [...args, "--version", "2.2.0"], args.slice(0, -1)]) {
    expect(parseOrchestratedChildArgs(invalid, child)).toEqual({ ok: false });
  }
});

test("parsing takes the result capability out of the environment so no later subprocess inherits it", () => {
  const args = ["--version", "2.1.0", "--orchestrated-expect", "encoded", "--orchestrated-result", "/tmp/result"];
  for (const [argv, marker] of [[args, "1"], [args.slice(2), "1"], [args, "0"]] as const) {
    const env: Record<string, string | undefined> = { OCX_UPDATE_ORCHESTRATED_CHILD: marker, OCX_UPDATE_RESULT_CAPABILITY: "c".repeat(43), PATH: "/bin" };
    parseOrchestratedChildArgs([...argv], env);
    expect(env).toEqual({ OCX_UPDATE_ORCHESTRATED_CHILD: marker, PATH: "/bin" });
  }
});

test("orchestrated arguments validate selectors, deadline, and plan binding", () => {
  expect(parseOrchestratedUpdateArgs(["--plan", "--json", "--tag", "preview"])).toMatchObject({ ok: true, mode: "plan", tag: "preview" });
  expect(parseOrchestratedUpdateArgs(["--yes", "--json", "--tag", "preview"])).toMatchObject({ ok: true, mode: "apply", tag: "preview" });
  expect(parseOrchestratedUpdateArgs(["--yes", "--json", "--version", "2.1.0-preview.2", "--expect-plan", "A".repeat(43), "--not-after", "123456"])).toMatchObject({ ok: true, mode: "apply", version: "2.1.0-preview.2", notAfter: 123456 });
  for (const args of [
    ["--plan"], ["--yes", "--json", "--plan"], ["--plan", "--json", "--tag", "latest", "--version", "2.0.0"],
    ["--plan", "--json", "--version", "01.2.3"], ["--plan", "--json", "--version", "1.2.3-01"],
    ["--yes", "--json", "--not-after", "0"], ["--yes", "--json", "--not-after", "9007199254740992"],
    ["--yes", "--json", "--expect-plan", "short"], ["--plan", "--json", "--not-after", "5"],
    ["--yes", "--json", "--tag", "preview", "--version", "2.1.0"],
    ["--plan", "--json", "--tag", "latest", "--tag", "preview"],
  ]) expect(parseOrchestratedUpdateArgs(args)).toMatchObject({ ok: false });
});

test("orchestrated or malformed orchestration flags never reach legacy update", () => {
  for (const args of [["--plan"], ["--yes"], ["--json"], ["--plan=true"], ["--yes=1"], ["--json=false"], ["--not-after=3"], ["--expect-plan", "token"]]) expect(isOrchestratedUpdateArgv(args)).toBe(true);
  expect(isOrchestratedUpdateArgv(["--tag", "latest"])).toBe(false);
  for (const args of [["--version", "2.0.0", "--orchestrated-result", "/fixture"], ["--orchestrated-expect", "fixture"], ["--orchestrated-result=/fixture"]]) {
    expect(isOrchestratedUpdateArgv(args)).toBe(true);
    expect(parseOrchestratedUpdateArgs(args)).toMatchObject({ ok: false });
  }
});
