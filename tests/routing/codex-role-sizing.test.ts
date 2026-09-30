import { describe, expect, test } from "bun:test";
import {
  DELEGATED_WORK_SIZING_SYSTEM_PROMPT,
  ROLE_INSTRUCTIONS_EXCERPT_CHARS,
  ROLE_SIZING_SYSTEM_PROMPT,
  SIZING_EFFORTS,
  SIZING_TIERS,
  buildRoleSizingUserMessage,
  parseRoleSizingResponse,
  roleInstructionsExcerpt,
} from "../../src/codex/role-sizing";

const GOOD = {
  tier: "standard",
  effort: "measured",
  rationale: "Reads code and reports findings; wrong answers are cheap to catch.",
  move_up_if: "It starts deciding architecture.",
  move_down_if: "It only greps.",
};

describe("role sizing rubric", () => {
  test("names every tier and effort and asks for JSON without model names", () => {
    for (const word of [...SIZING_TIERS, ...SIZING_EFFORTS]) expect(ROLE_SIZING_SYSTEM_PROMPT).toContain(word);
    expect(ROLE_SIZING_SYSTEM_PROMPT).toContain("Do not name concrete model products");
    expect(ROLE_SIZING_SYSTEM_PROMPT).toContain('"move_down_if"');
  });

  test("the role rubric keeps its exact bytes, and one-shot work gets the rubric plus an addendum", () => {
    const digest = new Bun.CryptoHasher("sha256").update(ROLE_SIZING_SYSTEM_PROMPT).digest("hex");
    expect(digest).toBe("5b611bbea1629e217d9d3ef77aeb02a331d99b1aed1d7d0074082ac7a1c11ff4");
    expect(DELEGATED_WORK_SIZING_SYSTEM_PROMPT.startsWith(`${ROLE_SIZING_SYSTEM_PROMPT}\n\n`)).toBe(true);
    expect(DELEGATED_WORK_SIZING_SYSTEM_PROMPT).toContain("one-shot");
  });

  test("the user message carries each role's name and excerpt", () => {
    const message = buildRoleSizingUserMessage([{ role: "explorer", instructions: "Search the repo." }]);
    expect(message).toContain('"name": "explorer"');
    expect(message).toContain('"instructions": "Search the repo."');
  });
});

describe("roleInstructionsExcerpt", () => {
  test("joins description and developer_instructions and cuts at the excerpt length", () => {
    const toml = 'name = "x"\ndescription = "Finds files."\ndeveloper_instructions = """\n' + "a".repeat(3000) + '\n"""\n';
    const excerpt = roleInstructionsExcerpt(toml)!;
    expect(excerpt.startsWith("Finds files.\n\naaa")).toBe(true);
    expect(excerpt.length).toBe(ROLE_INSTRUCTIONS_EXCERPT_CHARS);
  });

  test("is null for a role with nothing to read or a file that is not TOML", () => {
    expect(roleInstructionsExcerpt('name = "x"\nmodel = "m"\n')).toBeNull();
    expect(roleInstructionsExcerpt("model = = broken")).toBeNull();
    expect(roleInstructionsExcerpt('\ufeffdescription = "ok"\n')).toBe("ok");
  });
});

describe("parseRoleSizingResponse", () => {
  test("accepts a valid answer and one surrounding code fence", () => {
    const body = JSON.stringify({ roles: { explorer: GOOD } });
    for (const text of [body, "\x60\x60\x60json\n" + body + "\n\x60\x60\x60"]) {
      expect(parseRoleSizingResponse(text, ["explorer"]).get("explorer")).toEqual({
        sizing: {
          tier: "standard",
          effort: "measured",
          rationale: GOOD.rationale,
          moveUpIf: GOOD.move_up_if,
          moveDownIf: GOOD.move_down_if,
        },
      });
    }
  });

  test("marks every role unsized when the answer is not the JSON shape", () => {
    for (const text of ["Sure! explorer is standard.", "[]", '{"explorer":{}}', 'Here: {"roles":{}}']) {
      const out = parseRoleSizingResponse(text, ["explorer", "worker"]);
      expect(out.get("explorer")).toHaveProperty("unsized");
      expect(out.get("worker")).toHaveProperty("unsized");
    }
  });

  test("marks only the bad role unsized and never guesses its fields", () => {
    const cases: Record<string, unknown> = {
      badTier: { ...GOOD, tier: "premium" },
      badEffort: { ...GOOD, effort: "high" },
      noRationale: { ...GOOD, rationale: "  " },
      noMoveDown: { tier: GOOD.tier, effort: GOOD.effort, rationale: GOOD.rationale, move_up_if: GOOD.move_up_if },
      notObject: "standard",
    };
    const roles = ["ok", ...Object.keys(cases), "missing"];
    const out = parseRoleSizingResponse(JSON.stringify({ roles: { ok: GOOD, ...cases } }), roles);
    expect(out.get("ok")).toHaveProperty("sizing");
    for (const role of roles.slice(1)) expect(out.get(role), role).toHaveProperty("unsized");
    expect(out.get("missing")).toEqual({ unsized: "the sizing model did not size this role" });
  });

  test("ignores keys beyond the five it reads and keeps them out of the sizing", () => {
    const out = parseRoleSizingResponse(JSON.stringify({
      roles: { explorer: { ...GOOD, confidence: 0.8, notes: ["cheap"] } },
    }), ["explorer"]);
    expect(out.get("explorer")).toEqual({
      sizing: {
        tier: "standard",
        effort: "measured",
        rationale: GOOD.rationale,
        moveUpIf: GOOD.move_up_if,
        moveDownIf: GOOD.move_down_if,
      },
    });
  });

  test("ignores roles the model invented", () => {
    const out = parseRoleSizingResponse(JSON.stringify({ roles: { explorer: GOOD, ghost: GOOD } }), ["explorer"]);
    expect([...out.keys()]).toEqual(["explorer"]);
  });
});
