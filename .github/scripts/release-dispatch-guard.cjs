"use strict";

const ALLOWED_RELEASE_REFS = new Set([
  "refs/heads/main",
  "refs/heads/preview",
]);

function validateReleaseDispatch({
  eventName,
  ref,
  expectedSha,
  actualSha,
}) {
  if (eventName !== "workflow_dispatch") {
    return `Release must be triggered by workflow_dispatch; got ${eventName || "(empty)"}.`;
  }

  if (!ALLOWED_RELEASE_REFS.has(ref)) {
    return `Release must run from main or preview; got ${ref || "(empty)"}.`;
  }

  if (!expectedSha) {
    return "expected-sha is required; refusing to publish without an audited commit.";
  }

  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    return `expected-sha must be a full 40-character commit SHA; got ${expectedSha}.`;
  }

  if (actualSha !== expectedSha) {
    return (
      `branch moved after the release audit ` +
      `(expected ${expectedSha}, got ${actualSha || "(empty)"}) — ` +
      "refusing to publish an unaudited commit."
    );
  }

  return null;
}

module.exports = {
  ALLOWED_RELEASE_REFS,
  validateReleaseDispatch,
};
