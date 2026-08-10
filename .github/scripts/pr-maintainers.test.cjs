"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMaintainerLogins
} = require("./pr-maintainers.cjs");

const FIXTURE = [
  "## Current maintainers",
  "",
  "| GitHub account | Project role | Responsibilities |",
  "| --- | --- | --- |",
  "| [@lidge-jun](https://github.com/lidge-jun) | Project owner | x |",
  "| [@Ingwannu](https://github.com/Ingwannu) | Maintainer | x |",
  "| [@Wibias](https://github.com/Wibias) | Maintainer | x |",
  "",
  "## Change log",
  "",
  "- [@Wibias](https://github.com/Wibias) was added as a maintainer.",
  "- [@retired](https://github.com/retired) stepped down.",
].join("\n");

describe("parseMaintainerLogins", () => {
  it("reads the current-maintainers table and excludes the change log", () => {
    assert.deepEqual(parseMaintainerLogins(FIXTURE), [
      "lidge-jun",
      "Ingwannu",
      "Wibias",
    ]);
  });

  it("returns an empty list when the section heading is missing", () => {
    const text = "- [@only](https://github.com/only) is listed.";
    assert.deepEqual(parseMaintainerLogins(text), []);
  });
  it("does not match a ### subsection or prose mentioning the heading", () => {
    const subsection = [
      "### Current maintainers",
      "| [@subsection](https://github.com/subsection) | x |",
    ].join("\n");
    assert.deepEqual(parseMaintainerLogins(subsection), []);

    const prose = [
      "See the ## Current maintainers section below.",
      "| [@prose](https://github.com/prose) | x |",
    ].join("\n");
    assert.deepEqual(parseMaintainerLogins(prose), []);
  });

  it("accepts a valid CRLF heading with trailing whitespace and a following H2", () => {
    const crlf = [
      "## Current maintainers \t",
      "| [@crlf](https://github.com/crlf) | x |",
      "## Changelog",
      "| [@retired](https://github.com/retired) | y |",
    ].join("\r\n");
    assert.deepEqual(parseMaintainerLogins(crlf), ["crlf"]);
  });


  it("handles empty and duplicate-free output", () => {
    assert.deepEqual(parseMaintainerLogins(""), []);
    assert.deepEqual(
      parseMaintainerLogins(
        [
          "## Current maintainers",
          "| [@dup](https://github.com/dup) | x |",
          "| [@dup](https://github.com/dup) | y |",
        ].join("\n"),
      ),
      ["dup"],
    );
  });
});
