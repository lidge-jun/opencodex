import { expect, test } from "bun:test";
import {
  assignFamily,
  effectiveFamilyDefaults,
  listedDesktopModels,
  removableUnavailableRoutes,
  removeAssignments,
  roleListOrder,
  roleOptions,
  roleValue,
  type DesktopProfile,
} from "../src/pages/claude-desktop-roles";

const models = [
  { route: "p/a", label: "Alpha", available: true },
  { route: "p/b", label: "Bravo", available: true },
  { route: "p/c", label: "Charlie", available: false },
  { route: "p/d", label: "Delta", available: true },
];

function profile(): DesktopProfile {
  return {
    version: 1,
    assignments: {
      "p/a": { family: "opus", alias: "claude-opus-a" },
      "p/b": { family: "opus", alias: "claude-opus-b" },
      "p/c": { family: "haiku", alias: "claude-haiku-c" },
      "p/d": { family: "sonnet", alias: "claude-sonnet-d" },
    },
    defaults: { opus: "p/a", fable: null, sonnet: "p/d", haiku: "p/c" },
    appliedFingerprint: "fp",
  };
}

test("making a model the default moves it and repairs the family it left", () => {
  const next = assignFamily(profile(), "p/d", "opus", true);
  expect(next.assignments["p/d"]).toEqual({ family: "opus", alias: "claude-sonnet-d" });
  expect(next.defaults.opus).toBe("p/d");
  expect(next.defaults.sonnet).toBeNull();
  expect(next.appliedFingerprint).toBe("fp");
});

test("a same-family pick still changes the default", () => {
  expect(assignFamily(profile(), "p/b", "opus", true).defaults.opus).toBe("p/b");
  // A lane move into the same family is a no-op, as before.
  expect(assignFamily(profile(), "p/b", "opus", false)).toEqual(profile());
});

test("moving the default away hands it to the first remaining member", () => {
  const next = assignFamily(profile(), "p/a", "haiku", true);
  expect(next.defaults.opus).toBe("p/b");
  expect(next.defaults.haiku).toBe("p/a");
});

test("a plain lane move only claims an empty family's default", () => {
  const next = assignFamily(profile(), "p/b", "fable", false);
  expect(next.defaults.fable).toBe("p/b");
  expect(assignFamily(profile(), "p/b", "sonnet", false).defaults.sonnet).toBe("p/d");
});

test("effective defaults skip unavailable members; the select keeps the stored one", () => {
  const p = profile();
  const effective = effectiveFamilyDefaults(models, p);
  expect(effective.haiku).toBeNull();
  expect(roleValue(p, effective, "haiku")).toBe("p/c");
  expect(roleValue({ ...p, defaults: { ...p.defaults, opus: null } }, effective, "opus")).toBe("p/a");
});

test("role options are available models minus the other role", () => {
  expect(roleOptions(models, "p/a").map(m => m.route)).toEqual(["p/b", "p/d"]);
});

test("the compact list leads with default then quick", () => {
  expect(roleListOrder(models, "p/d", "p/b").map(m => m.route)).toEqual(["p/d", "p/b", "p/a", "p/c"]);
});

// #8165: an assignment whose route left the catalog had no control that removed it.
test("only unavailable routes still assigned in the draft are removable", () => {
  expect(removableUnavailableRoutes(models, profile())).toEqual(["p/c"]);
  expect(removableUnavailableRoutes(models, removeAssignments(profile(), ["p/c"]))).toEqual([]);
});

test("removing a route drops its assignment and hands its default to the first remaining member", () => {
  const twoHaiku: DesktopProfile = {
    ...profile(),
    assignments: { ...profile().assignments, "p/e": { family: "haiku", alias: "claude-haiku-e" } },
  };
  const next = removeAssignments(twoHaiku, ["p/c"]);
  expect(next.assignments["p/c"]).toBeUndefined();
  expect(next.defaults.haiku).toBe("p/e");
  // A family left empty has no default, which is what the server's profile parser requires.
  expect(removeAssignments(profile(), ["p/c"]).defaults.haiku).toBeNull();
  // Everything else is untouched, including aliases and the applied marker.
  expect(next.assignments["p/a"]).toEqual(profile().assignments["p/a"]!);
  expect(next.defaults.opus).toBe("p/a");
  expect(next.appliedFingerprint).toBe("fp");
});

test("an available route is never removed, even when asked", () => {
  const next = removeAssignments(profile(), ["p/a"], models);
  expect(next.assignments["p/a"]).toBeDefined();
});

test("a removed route disappears from the listed models before the profile is saved", () => {
  const listed = listedDesktopModels(models, removeAssignments(profile(), ["p/c"]));
  expect(listed.map(model => model.route)).toEqual(["p/a", "p/b", "p/d"]);
  // An available model with no assignment yet still lists: the server assigns it on load.
  const fresh = { ...profile(), assignments: { "p/a": profile().assignments["p/a"]! } };
  expect(listedDesktopModels(models, fresh).map(model => model.route)).toEqual(["p/a", "p/b", "p/d"]);
});
