import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";
import {
  analyzeWarmupRegistration,
  dispositionComplaints,
  warmupIsRegistered,
  warmupRegistrationComplaints,
} from "../helpers/warmup-registration";

/**
 * The regression set for the invocation oracle in tests/helpers/warmup-registration.ts.
 *
 * #5060: the coverage guard accepted the substring "helpers/cold-spawn-warmup" as proof that a file
 * pays its cold module-graph load in setup, so a comment, a string, or an import left behind after
 * its call was deleted all passed.
 *
 * The judge answers that by recognising four shapes exactly and refusing everything else, so this
 * file has to pin both halves. The first describe is the accepted grammar - if one of those stops
 * being accepted, ordinary test files start failing for no reason. The second is the refusals,
 * which are the point: each one is a construct that either does not warm, or does warm in a way
 * this judge will not claim to have proved. The third is the disposition contract, which is how a
 * refusal records a legitimate file instead of blocking it.
 *
 * The fixtures are source text, never imported and never run. The fixture path is a real directory
 * under tests/, so the relative specifier resolves to the real helper module, which is what makes
 * the same-name-from-another-file case fail rather than pass by spelling.
 */
const FIXTURE = repoPath("tests", "ci-workflows", "warmup-registration-fixture.test.ts");

const BUN_TEST = 'import { beforeAll, describe, test } from "bun:test";';
const HELPER = 'import { warmModuleGraph } from "../helpers/cold-spawn-warmup";';

function judge(...lines: string[]) {
  return analyzeWarmupRegistration(FIXTURE, lines.join("\n"));
}

function registers(...lines: string[]): boolean {
  return warmupIsRegistered(judge(...lines));
}

function why(...lines: string[]): string {
  return warmupRegistrationComplaints(judge(...lines)).join(" | ");
}

/** The registration shape every warmed file in this repository uses today. */
function hook(...body: string[]): string[] {
  return [
    'describe("subject", () => {',
    "  beforeAll(async () => {",
    ...body.map(line => "    " + line),
    "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    '  test("case", () => {});',
    "});",
  ];
}

describe("warm-up judge: the shapes it accepts", () => {
  test("a describe, a beforeAll, and the warm-up as a whole awaited statement", () => {
    const report = judge(BUN_TEST, HELPER, ...hook("await warmModuleGraph(options);"));
    expect(warmupIsRegistered(report)).toBe(true);
    expect(report.registrations).toEqual([
      { helper: "warmModuleGraph", local: "warmModuleGraph", shape: "hook-statement", line: 5 },
    ]);
  });

  test("the same hook at the top level, with no describe around it", () => {
    expect(registers(
      BUN_TEST,
      HELPER,
      "beforeAll(async () => {",
      "  await warmModuleGraph(options);",
      "}, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    )).toBe(true);
  });

  test("return and a concise body connect the promise as well as await does", () => {
    const shapes = (...lines: string[]): string[] =>
      judge(...lines).registrations.map(entry => entry.shape);
    expect(shapes(BUN_TEST, HELPER, ...hook("return warmModuleGraph(options);"))).toEqual(["hook-return"]);
    expect(shapes(BUN_TEST, HELPER, ...hook("return await warmModuleGraph(options);"))).toEqual(["hook-return"]);
    expect(shapes(
      BUN_TEST,
      HELPER,
      "beforeAll(() => warmModuleGraph(options), COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    )).toEqual(["hook-expression"]);
    expect(registers(
      BUN_TEST,
      HELPER,
      "beforeAll(async () => await warmModuleGraph(options), COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    )).toBe(true);
  });

  test("a function expression stands in for the arrow", () => {
    expect(registers(
      BUN_TEST,
      HELPER,
      "beforeAll(async function () {",
      "  await warmModuleGraph(options);",
      "}, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    )).toBe(true);
  });

  test("an alias is followed, and an optional call is still a call", () => {
    const aliased = judge(
      BUN_TEST,
      'import { warmModuleGraph as warmUp } from "../helpers/cold-spawn-warmup";',
      ...hook("await warmUp(options);"),
    );
    expect(aliased.registrations).toEqual([
      { helper: "warmModuleGraph", local: "warmUp", shape: "hook-statement", line: 5 },
    ]);
    expect(registers(BUN_TEST, HELPER, ...hook("await warmModuleGraph?.(options);"))).toBe(true);
  });

  test("both entry points are recognised, not only the one most files use", () => {
    // warmColdSpawn is the replay form, used where an import scan cannot reach the cold cost. If
    // it fell out of the recognised set, its files would be refused as never calling the helper.
    const report = judge(
      BUN_TEST,
      'import { warmColdSpawn } from "../helpers/cold-spawn-warmup";',
      ...hook("await warmColdSpawn(graph, replay);"),
    );
    expect(report.registrations).toEqual([
      { helper: "warmColdSpawn", local: "warmColdSpawn", shape: "hook-statement", line: 5 },
    ]);
  });

  test("a module-level await is a warm-up the file always pays", () => {
    // No hook to register: the statement runs when the module loads, which is before any test in
    // it is timed. It has to be the whole statement, exactly as it does inside a hook.
    const report = judge(BUN_TEST, HELPER, "await warmModuleGraph(options);");
    expect(report.registrations.map(entry => entry.shape)).toEqual(["module-top-level"]);
    expect(registers(BUN_TEST, HELPER, "const warmed = await warmModuleGraph(options);")).toBe(false);
  });

  test("a template substitution and a regular expression do not derail the token walk", () => {
    // Both are scanner rescans rather than plain tokens. Read naively, the closing brace of a
    // substitution leaks an unmatched brace and a regular expression is read as a division that
    // swallows whatever delimiters sit inside it, and either one moves the rest of the file to a
    // depth where the hook no longer looks like a hook.
    expect(registers(BUN_TEST, HELPER, ...hook(
      "const label = \`graph-\${options.graph}-\${JSON.stringify({ warm: true })}\`;",
      'const trimmed = label.replace(/[^a-z-]{1,4}/g, "");',
      "await warmModuleGraph(options);",
    ))).toBe(true);
  });
});

describe("warm-up judge: what it refuses, and says why", () => {
  test("a comment or a string that names the warm-up binds nothing", () => {
    // These two are the defect verbatim. Both contain every character the old substring check
    // looked for, and neither loads a module.
    const commented = judge(BUN_TEST, ...hook("// await warmModuleGraph(options); helpers/cold-spawn-warmup"));
    const quoted = judge(BUN_TEST, ...hook('const note = "warmModuleGraph(options) helpers/cold-spawn-warmup";'));
    expect([warmupIsRegistered(commented), warmupIsRegistered(quoted)]).toEqual([false, false]);
    expect([commented.bindings, quoted.bindings, commented.mentionsEntryPoint]).toEqual([[], [], false]);
  });

  test("an import left behind after the call was deleted is not a warm-up", () => {
    expect(why(BUN_TEST, HELPER, ...hook("const unrelated = 1;"))).toContain("never called");
  });

  test("a helper reached without a direct named import is refused rather than guessed", () => {
    // A namespace import and a barrel both warm at run time. Following either one means resolving
    // a binding through another module, and a judge that guesses there is a judge that can be
    // wrong in the direction that matters. The disposition table is where such a file is recorded.
    const namespaced = judge(
      BUN_TEST,
      'import * as warmup from "../helpers/cold-spawn-warmup";',
      ...hook("await warmup.warmModuleGraph(options);"),
    );
    expect([warmupIsRegistered(namespaced), namespaced.mentionsEntryPoint]).toEqual([false, true]);
    expect(warmupRegistrationComplaints(namespaced).join(" ")).toContain("namespace");

    const barrel = judge(
      BUN_TEST,
      'import { warmModuleGraph } from "../helpers/test-helpers";',
      ...hook("await warmModuleGraph(options);"),
    );
    expect([warmupIsRegistered(barrel), barrel.mentionsEntryPoint]).toEqual([false, true]);
    expect(warmupRegistrationComplaints(barrel).join(" ")).toContain("direct named import");
  });

  test("a type-only import loads nothing, and a local function of the same name is not the import", () => {
    expect(why(
      BUN_TEST,
      'import type { warmModuleGraph } from "../helpers/cold-spawn-warmup";',
      ...hook("await warmModuleGraph(options);"),
    )).toContain("type only");
    expect(registers(
      BUN_TEST,
      "async function warmModuleGraph(options) { return options; }",
      ...hook("await warmModuleGraph(options);"),
    )).toBe(false);
  });

  test("a hook the file never reaches registers nothing", () => {
    // Each of these calls beforeAll with a correct, awaited warm-up, and none of them runs: one
    // sits in a helper nobody calls, one behind a false condition, and one inside an
    // expression-bodied callback, which has no braces to give the scope away.
    const uncalled = judge(BUN_TEST, HELPER,
      "function installWarmUp() {",
      "  beforeAll(async () => {",
      "    await warmModuleGraph(options);",
      "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
      "}");
    const guarded = judge(BUN_TEST, HELPER,
      "if (false) {",
      "  beforeAll(async () => {",
      "    await warmModuleGraph(options);",
      "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
      "}");
    const expressionBodied = judge(BUN_TEST, HELPER,
      "register(() => beforeAll(async () => {",
      "  await warmModuleGraph(options);",
      "}));");
    expect([uncalled, guarded, expressionBodied].map(warmupIsRegistered)).toEqual([false, false, false]);
    expect(warmupRegistrationComplaints(expressionBodied).join(" ")).toContain("does not model");
  });

  test("a suite that is not a plain describe statement does not make its hooks run", () => {
    // A suite reached through a member - describe.each here, and describe.skip or describe.only by
    // the same path - is a callee this judge cannot claim runs, and a describe behind a false
    // condition is never called at all. Both leave a correctly written beforeAll inside a suite
    // that is not there, which is a registration in shape only.
    const member = judge(BUN_TEST, HELPER,
      'describe.each([1, 2])("subject %s", () => {',
      "  beforeAll(async () => {",
      "    await warmModuleGraph(options);",
      "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
      "});");
    const guardedSuite = judge(BUN_TEST, HELPER,
      'if (false) describe("subject", () => {',
      "  beforeAll(async () => {",
      "    await warmModuleGraph(options);",
      "  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
      "});");
    expect([member, guardedSuite].map(warmupIsRegistered)).toEqual([false, false]);
    expect(warmupRegistrationComplaints(guardedSuite).join(" ")).toContain("plain statement");
  });

  test("an expression-bodied arrow is a scope, so a warm-up inside an uncalled one is refused", () => {
    expect(registers(BUN_TEST, HELPER, "const warmUp = async () => await warmModuleGraph(options);"))
      .toBe(false);
    expect(registers(BUN_TEST, HELPER, "const warmUp = () => warmModuleGraph(options);")).toBe(false);
  });

  test("a rebound beforeAll or describe is not the bun:test one", () => {
    // The shadowed hook takes a correct callback and runs nothing at all. Provenance has to hold
    // for the hook name exactly as it does for the warm-up name.
    const shadowedHook = judge(BUN_TEST, HELPER,
      'describe("subject", () => {',
      "  const beforeAll = (body) => body;",
      "  beforeAll(async () => {",
      "    await warmModuleGraph(options);",
      "  });",
      "});");
    const shadowedSuite = judge(BUN_TEST, HELPER,
      "const describe = (name, body) => body();",
      ...hook("await warmModuleGraph(options);"));
    expect([shadowedHook, shadowedSuite].map(warmupIsRegistered)).toEqual([false, false]);
    expect(warmupRegistrationComplaints(shadowedHook).join(" ")).toContain("rebound");
    expect(warmupRegistrationComplaints(shadowedSuite).join(" ")).toContain("rebound");
  });

  test("a parameter, a variable alias, and a callback reached by name are all refused", () => {
    const parameter = judge(BUN_TEST, HELPER,
      'describe("subject", () => {',
      "  beforeAll(async (warmModuleGraph) => {",
      "    await warmModuleGraph(options);",
      "  });",
      "});");
    const alias = judge(BUN_TEST, HELPER, "const warm = warmModuleGraph;", ...hook("await warm(options);"));
    const byName = judge(BUN_TEST, HELPER,
      "const warmUpHook = async () => {",
      "  await warmModuleGraph(options);",
      "};",
      "beforeAll(warmUpHook, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);");
    expect([parameter, alias, byName].map(warmupIsRegistered)).toEqual([false, false, false]);
    expect(warmupRegistrationComplaints(alias).join(" ")).toContain("without being called");
  });

  test("fire and forget, void, and a partial expression leave the hook settling first", () => {
    expect(registers(BUN_TEST, HELPER, ...hook("warmModuleGraph(options);"))).toBe(false);
    expect(registers(BUN_TEST, HELPER, ...hook("void warmModuleGraph(options);"))).toBe(false);
    expect(registers(BUN_TEST, HELPER, ...hook("return warmModuleGraph(options), ready();"))).toBe(false);
    expect(registers(
      BUN_TEST,
      HELPER,
      "beforeAll(() => warmModuleGraph(options) && ready(), COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);",
    )).toBe(false);
  });

  test("a conditional call is refused even when every branch warms", () => {
    // Refused rather than analysed. Deciding that two branches both warm means modelling control
    // flow, and the judge that models control flow from tokens is the one that gets it wrong.
    expect(registers(BUN_TEST, HELPER, ...hook(
      "if (portable) {",
      "  await warmModuleGraph(portableOptions);",
      "} else {",
      "  await warmModuleGraph(nativeOptions);",
      "}",
    ))).toBe(false);
    expect(registers(BUN_TEST, HELPER, ...hook("if (false) await warmModuleGraph(options);"))).toBe(false);
  });

  test("a file this judge cannot read is a failure, never an absence", () => {
    const report = judge(BUN_TEST, HELPER, 'describe("unclosed", () => {');
    expect(report.refusals.length).toBeGreaterThan(0);
    expect(warmupIsRegistered(report)).toBe(false);
  });
});

describe("warm-up judge: what a disposition has to match", () => {
  const warmed = { warmed: true, why: "the canonical hook" };
  const unwarmed = { warmed: false, why: "nothing here spawns a child that loads a repository graph" };
  const canonical = () => judge(BUN_TEST, HELPER, ...hook("await warmModuleGraph(options);"));
  const dropped = () => judge(BUN_TEST, HELPER, ...hook("warmModuleGraph(options);"));
  const namespaced = () => judge(
    BUN_TEST,
    'import * as warmup from "../helpers/cold-spawn-warmup";',
    ...hook("await warmup.warmModuleGraph(options);"),
  );

  test("warmed means an accepted shape and nothing refused", () => {
    expect(dispositionComplaints("f.test.ts", warmed, canonical())).toEqual([]);
    expect(dispositionComplaints("f.test.ts", warmed, dropped()).join(" ")).toContain("recorded warmed");
  });

  test("unwarmed means the file does not reach the helper at all", () => {
    expect(dispositionComplaints("f.test.ts", unwarmed, judge(BUN_TEST, ...hook("const x = 1;")))).toEqual([]);
    expect(dispositionComplaints("f.test.ts", unwarmed, canonical()).join(" ")).toContain("recorded unwarmed");
    // A namespace import binds no name this judge follows, so bindings alone would read this as an
    // absence. It is the reason the unwarmed test asks whether the helper is reached at all.
    expect(dispositionComplaints("f.test.ts", unwarmed, namespaced()).join(" ")).toContain("reaches the warm-up helper");
  });

  test("an unmodelled shape is recorded, and the record has to keep matching", () => {
    // This is how a refusal records a legitimate file instead of blocking it. The escape is not a
    // silence: the judge still has to see the warm-up and still has to refuse it for the stated
    // reason, so deleting the call or dropping the await changes the refusal and fails again.
    const recorded = { warmed: true, why: "warms through a namespace import", unmodeled: "namespace" };
    expect(dispositionComplaints("f.test.ts", recorded, namespaced())).toEqual([]);
    expect(dispositionComplaints("f.test.ts", recorded, dropped()).join(" ")).toContain("not what was refused");
    expect(dispositionComplaints("f.test.ts", recorded, canonical()).join(" ")).toContain("drop the note");
    expect(dispositionComplaints("f.test.ts", recorded, judge(BUN_TEST, ...hook("const x = 1;"))).join(" "))
      .toContain("nothing here reaches");
  });
});
