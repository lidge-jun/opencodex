"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_LOOKUPS,
  resolveReferencedAuthors,
} = require("./pr-referenced-authors.cjs");

function stubGithub({ pulls = {}, commits = {}, onGet = null }) {
  return {
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          onGet?.(pull_number);
          if (!(pull_number in pulls)) {
            const error = new Error("Not Found");
            error.status = 404;
            throw error;
          }
          return { data: pulls[pull_number] };
        },
        listCommits: "listCommits",
      },
    },
    paginate: async (route, { pull_number }) => {
      assert.equal(route, "listCommits");
      if (!(pull_number in commits)) throw new Error("commits unavailable");
      return commits[pull_number];
    },
  };
}

describe("resolveReferencedAuthors", () => {
  it("returns login, git names, and git emails for a referenced pull request", async () => {
    const github = stubGithub({
      pulls: { 2797: { user: { login: "rrmlima" } } },
      commits: {
        2797: [
          { commit: { author: { name: "Rodrigo Lima", email: "rrmlima@example.com" } } },
          { commit: { author: { name: "Rodrigo Lima", email: "rrmlima@example.com" } } },
        ],
      },
    });
    const resolved = await resolveReferencedAuthors({
      github,
      owner: "o",
      repo: "r",
      texts: ["Reimplements #2797."],
    });
    assert.deepEqual(resolved, {
      2797: {
        login: "rrmlima",
        names: ["Rodrigo Lima"],
        emails: ["rrmlima@example.com"],
      },
    });
  });

  it("resolves to null when the lookup fails, so the gate can fail open", async () => {
    const github = stubGithub({ pulls: {}, commits: {} });
    const resolved = await resolveReferencedAuthors({
      github,
      owner: "o",
      repo: "r",
      texts: ["Supersedes #9999."],
    });
    assert.deepEqual(resolved, { 9999: null });
  });

  it("keeps the login when only the commit listing fails", async () => {
    const github = stubGithub({ pulls: { 42: { user: { login: "someone" } } }, commits: {} });
    const resolved = await resolveReferencedAuthors({
      github,
      owner: "o",
      repo: "r",
      texts: ["Carry of #42."],
    });
    assert.deepEqual(resolved, { 42: { login: "someone", names: [], emails: [] } });
  });

  it("bounds the number of lookups", async () => {
    const seen = [];
    const pulls = {};
    const commits = {};
    for (let n = 1; n <= 9; n += 1) {
      pulls[n] = { user: { login: "u" + n } };
      commits[n] = [];
    }
    const github = stubGithub({ pulls, commits, onGet: (n) => seen.push(n) });
    const body = [1, 2, 3, 4, 5, 6, 7, 8, 9]
      .map((n) => "Reimplements #" + n + ".")
      .join("\n");
    await resolveReferencedAuthors({ github, owner: "o", repo: "r", texts: [body] });
    assert.equal(seen.length, MAX_LOOKUPS);
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  });

  it("makes no request when nothing declares a carry", async () => {
    const seen = [];
    const github = stubGithub({ pulls: {}, commits: {}, onGet: (n) => seen.push(n) });
    const resolved = await resolveReferencedAuthors({
      github,
      owner: "o",
      repo: "r",
      texts: ["Closes #2797.", "An ordinary description."],
    });
    assert.deepEqual(resolved, {});
    assert.equal(seen.length, 0);
  });
});

