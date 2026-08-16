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
      signature,
    });
  });

  it("does not treat a semantic version as a structured field path", () => {
    // IDENTICAL lines on both issues: exact whole-line equality already holds,
    // so the ONLY thing deciding the outcome is whether the version counts as
    // specific evidence. An earlier version of this test used two different
    // sentences, which returned null for the wrong reason and proved nothing.
    for (const version of ["2.19.0", "v2.19.0", "V2.19.0", "2.19.0-preview.1"]) {
      const line =
        `Codex sync did not complete in version ${version} after updating the provider configuration.`;
      const match = selectStrongDuplicateMatch({
        currentIssue: { number: 2101, title: "new", body: line },
        candidateIssues: [{ number: 1801, title: "old", body: line }],
        duplicateNumbers: ["1801"],
      });
      assert.equal(match, null, `version ${version} must not qualify as a discriminator`);
    }
  });

  it("still accepts an exact IPv4 address as a discriminator", () => {
    // Excluding SemVer must not become "reject every numeric dotted token":
    // a specific host is legitimate shared evidence.
    const line =
      "The sync command failed while connecting to 192.168.1.10 during provider startup here.";
    const match = selectStrongDuplicateMatch({
      currentIssue: { number: 2104, title: "new", body: line },
      candidateIssues: [{ number: 1804, title: "old", body: line }],
      duplicateNumbers: ["1804"],
    });
    assert.deepEqual(match, { number: "1804", signature: line });
  });

  it("keeps case-distinct file paths distinct", () => {
    // Normalization used to lowercase the whole line, collapsing Config.toml and
    // config.toml into one signature. Filenames are case-bearing evidence, so an
    // "exact" match promise has to preserve them.
    const current =
      "The sync command failed with OSError while reading Config.toml during provider startup.";
    const candidate =
      "The sync command failed with OSError while reading config.toml during provider startup.";

    const match = selectStrongDuplicateMatch({
      currentIssue: { number: 2102, title: "new", body: current },
      candidateIssues: [{ number: 1802, title: "old", body: candidate }],
      duplicateNumbers: ["1802"],
    });

    assert.equal(match, null);
  });

  it("still matches a genuine structured field path", () => {
    // The negative lookahead must not disqualify real dotted identifiers.
    const signature =
      "The sync command failed with OSError while reading config.providers.baseUrl during startup.";

    const match = selectStrongDuplicateMatch({
      currentIssue: { number: 2103, title: "new", body: signature },
      candidateIssues: [{ number: 1803, title: "old", body: signature }],
      duplicateNumbers: ["1803"],
    });

    assert.deepEqual(match, { number: "1803", signature });
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
      signature,
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
      signature,
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
      signature: longer,
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
      signature: hyphen,
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

  it("workflow searches open and recently closed issues and closes only through duplicate state reason", () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, "..", "workflows", "issue-triage.yml"),
      "utf8",
    );

    assert.match(workflow, /gh issue list[^\n]*--state open/);
    assert.match(workflow, /closed_since="\$\(date -u -d '90 days ago' \+%Y-%m-%d\)"/);
    assert.match(
      workflow,
      /gh issue list[^\n]*--state closed[^\n]*--search "closed:>=\$\{closed_since\}"/,
    );
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
