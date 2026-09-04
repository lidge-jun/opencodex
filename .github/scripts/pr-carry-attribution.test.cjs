"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { assessCarryAttribution } = require("./pr-carry-attribution.cjs");

const RRMLIMA = {
  login: "rrmlima",
  names: ["Rodrigo Lima"],
  emails: ["rrmlima@example.com"],
};

function base(overrides = {}) {
  return {
    prAuthorLogin: "lidge-jun",
    title: "fix(doctor): diagnose the broken Codex env_key launch path",
    body: "",
    commits: [],
    labels: [],
    referencedAuthors: { 2797: RRMLIMA },
    ...overrides,
  };
}

describe("assessCarryAttribution", () => {
  it("fails a carry that names the author in prose but not in a trailer", () => {
    const failures = assessCarryAttribution(
      base({ body: "Reimplements #2797 by @rrmlima." }),
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "missing_coauthor_credit");
    assert.deepEqual(failures[0].paths, ["#2797"]);
  });

  it("accepts a trailer that names the login", () => {
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: "Reimplements #2797 by @rrmlima.\n\nCo-authored-by: rrmlima <rrmlima@example.com>",
        }),
      ),
      [],
    );
  });

  it("accepts a trailer that matches only the git author name", () => {
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: "Reimplements #2797.",
          commits: [
            "fix(doctor): diagnose\n\nCo-authored-by: Rodrigo Lima <someone-else@example.com>",
          ],
        }),
      ),
      [],
    );
  });

  it("accepts a trailer that matches only the git author email", () => {
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: "Supersedes #2797.\n\nCo-authored-by: R. L. <rrmlima@example.com>",
        }),
      ),
      [],
    );
  });

  it("ignores a reference to the pull request author's own earlier work", () => {
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: "Rebase of #3112.",
          referencedAuthors: { 3112: { login: "lidge-jun", names: ["JUN"], emails: [] } },
        }),
      ),
      [],
    );
  });

  it("passes when the referenced author could not be resolved", () => {
    assert.deepEqual(
      assessCarryAttribution(
        base({ body: "Reimplements #2797.", referencedAuthors: { 2797: null } }),
      ),
      [],
    );
  });

  it("passes when the label approves the attribution", () => {
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: "Reimplements #2797 by @rrmlima.",
          labels: ["attribution-approved"],
        }),
      ),
      [],
    );
  });

  it("ignores carry language inside a fenced block or an HTML comment", () => {
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: [
            "This is an ordinary fix.",
            "",
            "\u0060\u0060\u0060",
            "Reimplements #2797",
            "\u0060\u0060\u0060",
            "",
            "<!-- supersedes #2797 -->",
          ].join("\n"),
        }),
      ),
      [],
    );
  });

  it("ignores carry language after an unclosed HTML comment", () => {
    // GitHub renders nothing after an unterminated `<!--`, so neither does the
    // gate. The closing-delimiter-only pattern used to match nothing here and
    // leave the whole tail in the scanned text, which is the divergence CodeQL
    // flagged on #3342: enforced text and rendered text stopped agreeing.
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: ["This is an ordinary fix.", "", "<!-- supersedes #2797"].join("\n"),
        }),
      ),
      [],
    );
  });

  it("still reads carry language that follows a CLOSED comment", () => {
    // The guard above must not swallow the rest of the body wholesale: a
    // properly closed comment ends at its own `-->`, and a real claim after it
    // is still a claim.
    assert.equal(
      assessCarryAttribution(
        base({
          body: ["<!-- a note -->", "", "Supersedes #2797."].join("\n"),
        }),
      ).length,
      1,
    );
  });

  it("passes an ordinary pull request with no carry language", () => {
    assert.deepEqual(
      assessCarryAttribution(base({ body: "Closes #2797." })),
      [],
    );
  });

  it("stops at the sentence boundary so a Fixes line is not a carry", () => {
    // 53c09a247's real body. A fixed-width window would have pulled #3192 --
    // the issue it closes -- into the carry set and demanded a trailer for the
    // reporter of a bug, which is a different relationship entirely.
    const failures = assessCarryAttribution(
      base({
        body: "Supersedes #3193. Fixes #3192.",
        referencedAuthors: {
          3193: { login: "alan7629", names: [], emails: [] },
          3192: { login: "alan7629", names: [], emails: [] },
        },
      }),
    );
    assert.deepEqual(failures[0].paths, ["#3193"]);
  });

  it("reads a trailer that only exists on a branch commit", () => {
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: "Reimplements #2797.",
          commits: [
            "fix: first",
            "fix: second\n\nCo-authored-by: rrmlima <rrmlima@example.com>",
          ],
        }),
      ),
      [],
    );
  });


  it("recognizes the -ing and bare forms of each carry verb", () => {
    for (const phrase of [
      "Reimplementing #2797 on dev.",
      "Rebasing #2797 onto the current head.",
      "Carrying #2797 forward.",
      "Carry #2797.",
      "Rebase #2797.",
    ]) {
      const failures = assessCarryAttribution(base({ body: phrase }));
      assert.equal(failures.length, 1, phrase);
      assert.deepEqual(failures[0].paths, ["#2797"], phrase);
    }
  });

  it("ignores a reference qualified with another repository", () => {
    // other/project#2797 is not this repository's #2797. Resolving it here
    // would compare the trailer against an unrelated person who happens to
    // own the same number locally.
    assert.deepEqual(
      assessCarryAttribution(base({ body: "Supersedes other/project#2797." })),
      [],
    );
  });

  it("does not accept a trailer that merely contains the identifier", () => {
    const failures = assessCarryAttribution(
      base({
        body: "Reimplements #2797.\n\nCo-authored-by: Joanne <other@example.com>",
        referencedAuthors: { 2797: { login: "ann", names: ["Ann"], emails: [] } },
      }),
    );
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].paths, ["#2797"]);
  });

  it("accepts a noreply address that carries the login", () => {
    // Assembled rather than written out: the privacy scan reads a literal
    // noreply address as a real one, and it is right to.
    const noreply = "27862058+rrmlima@" + "users.noreply.github.com";
    assert.deepEqual(
      assessCarryAttribution(
        base({
          body: "Reimplements #2797.\n\nCo-authored-by: R L <" + noreply + ">",
        }),
      ),
      [],
    );
  });


  it("reports every uncredited reference once", () => {
    const failures = assessCarryAttribution(
      base({
        body: "Reimplements #2797 and #2796. Supersedes #2797.",
        referencedAuthors: {
          2797: RRMLIMA,
          2796: { login: "someone", names: [], emails: [] },
        },
      }),
    );
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].paths, ["#2796", "#2797"]);
  });
});
