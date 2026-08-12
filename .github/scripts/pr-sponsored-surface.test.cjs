"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { assessSponsoredSurface, isRestrictedPath } = require("./pr-sponsored-surface.cjs");

describe("isRestrictedPath", () => {
  it("covers auth, workflow, release, and dependency surfaces", () => {
    for (const path of [
      "src/oauth/store.ts",
      ".github/workflows/release.yml",
      "scripts/release.ts",
      "src/server/management-auth.ts",
      "package.json",
      "bun.lock",
    ]) {
      assert.equal(isRestrictedPath(path), true, path);
    }
  });

  it("leaves ordinary product surfaces alone", () => {
    for (const path of [
      "src/adapters/anthropic.ts",
      "src/providers/registry.ts",
      "gui/src/pages/Providers.tsx",
      "tests/anthropic.test.ts",
      "docs-site/src/content/docs/x.md",
    ]) {
      assert.equal(isRestrictedPath(path), false, path);
    }
  });
});

describe("assessSponsoredSurface", () => {
  it("requires sponsorship for a restricted surface", () => {
    const failures = assessSponsoredSurface({ changedFiles: ["src/oauth/store.ts"] });
    assert.equal(failures[0].code, "unsponsored_surface");
    assert.deepEqual(failures[0].paths, ["src/oauth/store.ts"]);
  });

  it("passes once a maintainer sponsors it", () => {
    assert.deepEqual(
      assessSponsoredSurface({
        changedFiles: ["src/oauth/store.ts"],
        labels: ["maintainer-sponsored"],
      }),
      [],
    );
    assert.deepEqual(
      assessSponsoredSurface({
        changedFiles: ["src/oauth/store.ts"],
        labels: [{ name: "maintainer-sponsored" }],
      }),
      [],
    );
  });

  it("exempts an author who can already push", () => {
    assert.deepEqual(
      assessSponsoredSurface({
        authorHasPushPermission: true,
        changedFiles: ["scripts/release.ts"],
      }),
      [],
    );
  });

  it("applies to every contributor, not only first-timers", () => {
    // The upstream trust lane exited early for anyone who was not a first-time
    // contributor. Blast radius does not depend on how many PRs someone has
    // merged, so this one does not carry that exemption.
    const failures = assessSponsoredSurface({
      authorAssociation: "MEMBER",
      changedFiles: [".github/workflows/release.yml"],
    });
    assert.equal(failures[0].code, "unsponsored_surface");
  });

  it("ignores a pull request that touches nothing restricted", () => {
    assert.deepEqual(
      assessSponsoredSurface({ changedFiles: ["src/adapters/anthropic.ts", "tests/a.test.ts"] }),
      [],
    );
  });
});
