import { expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const modelsSource = await Bun.file(repoPath("gui", "src", "pages", "Models.tsx")).text();

/**
 * `publishFeedback` is called from 21 sites and, more importantly, from inside
 * `saveDisplayName`, which is itself a `useCallback`. Declared as a plain function it was a
 * new identity on every render, so `saveDisplayName` either captured a stale copy or had to
 * omit it from its dependency array — the omission is what dev shipped. React's setters are
 * the only values the body reads, and those are guaranteed stable, so `useCallback(..., [])`
 * is sound and makes the dependency honest instead of suppressed.
 */
test("publishFeedback is a stable useCallback with an empty dependency list", () => {
  const at = modelsSource.indexOf("const publishFeedback =");
  expect(at).toBeGreaterThan(-1);

  const declaration = modelsSource.slice(at, modelsSource.indexOf("\n  //", at));
  expect(declaration).toContain("useCallback((nextOk: boolean, message: string)");
  // The body may only touch setters; anything else would make [] a lie.
  expect(declaration).toContain("setOk(nextOk)");
  expect(declaration).toContain("setStatus(message)");
  expect(declaration).toContain("setFeedbackGen(g => g + 1)");
  expect(declaration.trimEnd().endsWith("}, []);")).toBe(true);
});

test("saveDisplayName declares publishFeedback in its dependency array", () => {
  const bodyAt = modelsSource.indexOf("const saveDisplayName = useCallback");
  expect(bodyAt).toBeGreaterThan(-1);

  const body = modelsSource.slice(bodyAt);
  const deps = body.slice(body.indexOf("}, ["), body.indexOf("]);") + 3);
  expect(body.slice(0, body.indexOf("}, [")))
    .toContain("publishFeedback(true, confirmed");
  expect(deps).toContain("publishFeedback");
});

