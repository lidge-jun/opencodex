"use strict";

const ALLOWED_RELEASE_REFS = new Set(["refs/heads/dev"]);
const FULL_SHA = /^[0-9a-f]{40}$/;

function validateReleaseDispatch({ eventName, ref, sourceSha, workflowSha, expectedSha, actualSha }) {
  if (eventName !== "workflow_dispatch") {
    return `Release must be triggered by workflow_dispatch; got ${eventName || "(empty)"}.`;
  }
  if (!ALLOWED_RELEASE_REFS.has(ref)) {
    return `Release must run from dev; got ${ref || "(empty)"}.`;
  }
  // Accept the old parameter names while callers migrate; the source is independently
  // validated by release-evidence, not compared with the workflow revision.
  const source = sourceSha ?? expectedSha ?? "";
  const workflow = workflowSha ?? actualSha ?? "";
  if (source && !FULL_SHA.test(source)) return "source-sha must be a full 40-character commit SHA.";
  if (!FULL_SHA.test(workflow)) return "workflow SHA must be a full 40-character commit SHA.";
  return null;
}

module.exports = { ALLOWED_RELEASE_REFS, validateReleaseDispatch };
