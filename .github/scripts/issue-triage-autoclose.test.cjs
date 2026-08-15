"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractStrongFailureSignatures,
  selectStrongDuplicateMatch,
} = require("./issue-triage-autoclose.cjs");

describe("deterministic duplicate auto-close", () => {
  it("does not treat the generic #1672 final sync message as duplicate proof", () => {
    const signature =
      "Codex sync did not complete. Fix the reported Codex config issue and retry.";

    assert.deepEqual(
      extractStrongFailureSignatures({
        number: 1672,
        title: signature,
        body: `### Reproduction\n${signature}`,
      }),
      [],
    );
  });

  it("selects an AI-nominated duplicate when both reports share an exact specific failure signature", () => {
    const signature =
      "POST /v1/responses returns HTTP 503 with ECONNRESET in the OpenRouter adapter.";
    const currentIssue = {
      number: 2001,
      title: "OpenRouter responses fail",
      body: `### Logs or error output\n${signature}`,
    };
    const sourceIssue = {
      number: 1453,
      title: "Existing OpenRouter failure",
      body: `Observed repeatedly:\n${signature}`,
    };

    const match = selectStrongDuplicateMatch({
      currentIssue,
      candidateIssues: [sourceIssue],
      duplicateNumbers: ["1453"],
    });

    assert.deepEqual(match, {
      number: "1453",
      signature: signature.toLowerCase(),
    });
  });

  it("recognizes fails as a strong failure signal", () => {
    const signature =
      "POST /v1/responses fails with HTTP 503 in the OpenRouter adapter after authentication.";
    const match = selectStrongDuplicateMatch({
      currentIssue: { number: 2002, title: "new", body: signature },
      candidateIssues: [{ number: 1454, title: "old", body: signature }],
      duplicateNumbers: ["1454"],
    });

    assert.deepEqual(match, {
      number: "1454",
      signature: signature.toLowerCase(),
    });
  });

  it("recognizes short-prefix named error classes as specific duplicate evidence", () => {
    const signature =
      "The sync command failed with OSError while loading the provider catalog during startup.";
    const match = selectStrongDuplicateMatch({
      currentIssue: { number: 2004, title: "new", body: signature },
      candidateIssues: [{ number: 1457, title: "old", body: signature }],
      duplicateNumbers: ["1457"],
    });

    assert.deepEqual(match, {
      number: "1457",
      signature: signature.toLowerCase(),
    });
  });

  it("selects the longest shared signature across all nominated candidates", () => {
    const shorter =
      "POST /v1/responses returns HTTP 503 in the OpenRouter adapter during requests.";
    const longer =
      "POST /v1/responses returns HTTP 503 with ECONNRESET in the OpenRouter adapter during streamed requests.";
    const currentIssue = {
      number: 2003,
      title: "new",
      body: `${shorter}\n${longer}`,
    };

    const match = selectStrongDuplicateMatch({
      currentIssue,
      candidateIssues: [
        { number: 1455, title: "first", body: shorter },
        { number: 1456, title: "second", body: longer },
      ],
      duplicateNumbers: ["1455", "1456"],
    });

    assert.deepEqual(match, {
      number: "1456",
      signature: longer.toLowerCase(),
    });
  });

  it("preserves technical punctuation so distinct signatures cannot collapse together", () => {
    const currentSignature =
      "The sync command failed while reading user_profile.yml from ~/config.yml during provider startup.";
    const candidateSignature =
      "The sync command failed while reading userprofile.yml from /config.yml during provider startup.";

    assert.equal(
      selectStrongDuplicateMatch({
        currentIssue: { number: 2005, title: "new", body: currentSignature },
        candidateIssues: [{ number: 1458, title: "old", body: candidateSignature }],
        duplicateNumbers: ["1458"],
      }),
      null,
    );
  });

  it("never selects the current issue as its own duplicate", () => {
    const signature =
      "POST /v1/responses returns HTTP 503 with ECONNRESET in the OpenRouter adapter.";
    const currentIssue = { number: 2006, title: "new", body: signature };

    assert.equal(
      selectStrongDuplicateMatch({
        currentIssue,
        candidateIssues: [currentIssue],
        duplicateNumbers: ["2006"],
      }),
      null,
    );
  });

  it("uses a locale-independent code-unit tie-breaker for equal-length signatures", () => {
    const hyphen =
      "POST /v1/a returns HTTP 503 with ECONNRESET in adapter-a during requests.";
    const underscore =
      "POST /v1/a returns HTTP 503 with ECONNRESET in adapter_a during requests.";
    assert.equal(hyphen.length, underscore.length);

    const match = selectStrongDuplicateMatch({
      currentIssue: { number: 2007, title: "new", body: `${underscore}\n${hyphen}` },
      candidateIssues: [
        { number: 1459, title: "underscore", body: underscore },
        { number: 1460, title: "hyphen", body: hyphen },
      ],
      duplicateNumbers: ["1459", "1460"],
    });

    assert.deepEqual(match, {
      number: "1460",
      signature: hyphen.toLowerCase(),
    });
  });

  it("does not auto-close an AI duplicate without an exact strong failure signature", () => {
    const match = selectStrongDuplicateMatch({
      currentIssue: {
        number: 2000,
        title: "Codex sync fails",
        body: "The Codex sync command fails after editing config.toml.",
      },
      candidateIssues: [{
        number: 1453,
        title: "Codex sync failure",
        body: "ocx sync fails because the catalog is rewritten before injection.",
      }],
      duplicateNumbers: ["1453"],
    });

    assert.equal(match, null);
  });

  it("ignores exact strong matches that the AI did not nominate as duplicates", () => {
    const signature =
      "POST /v1/responses returns HTTP 503 with ECONNRESET in the OpenRouter adapter.";
    const match = selectStrongDuplicateMatch({
      currentIssue: { number: 2001, title: "new report", body: signature },
      candidateIssues: [{ number: 1453, title: "old report", body: signature }],
      duplicateNumbers: [],
    });

    assert.equal(match, null);
  });

  it("does not promote short generic HTTP failures to auto-close signatures", () => {
    assert.deepEqual(
      extractStrongFailureSignatures({
        title: "Proxy error",
        body: "Proxy returns HTTP 500.",
      }),
      [],
    );
  });

  it("workflow searches open and closed issues and closes only through duplicate state reason", () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, "..", "workflows", "issue-triage.yml"),
      "utf8",
    );

    assert.match(workflow, /gh issue list[^\n]*--state open/);
    assert.match(workflow, /gh issue list[^\n]*--state closed/);
    assert.match(workflow, /issue-triage-autoclose\.cjs/);
    assert.match(workflow, /state_reason:\s*["']duplicate["']/);
    assert.match(
      workflow,
      /eligible for automatic duplicate closure after final revalidation/,
    );
    assert.doesNotMatch(
      workflow,
      /This issue will be closed automatically as a duplicate/,
    );
  });
});
