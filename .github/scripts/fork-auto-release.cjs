"use strict";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_NAME = "@yansigit/opencodex";

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredSha(value, name) {
  requiredString(value, name);
  if (!FULL_SHA.test(value)) {
    throw new TypeError(`${name} must be a full 40-character commit SHA`);
  }
  return value;
}

/**
 * Decide whether a successful main-branch CI completion may dispatch release.yml.
 *
 * The function is deliberately pure so the workflow's publish eligibility can be
 * tested without GitHub or npm credentials.
 */
function decideForkAutoRelease({
  eventName,
  workflowName,
  conclusion,
  headBranch,
  headSha,
  liveMainSha,
  packageName,
  packageVersion,
  versionOnNpm,
}) {
  requiredString(eventName, "eventName");
  requiredString(workflowName, "workflowName");
  requiredString(conclusion, "conclusion");
  requiredString(headBranch, "headBranch");
  requiredSha(headSha, "headSha");
  requiredSha(liveMainSha, "liveMainSha");
  requiredString(packageName, "packageName");
  requiredString(packageVersion, "packageVersion");

  if (!SEMVER.test(packageVersion)) {
    throw new TypeError("packageVersion must be valid semver");
  }
  if (versionOnNpm !== undefined && versionOnNpm !== null && typeof versionOnNpm !== "string") {
    throw new TypeError("versionOnNpm must be a string when provided");
  }

  if (eventName !== "workflow_run") {
    return { action: "skip", reason: `event must be workflow_run; got ${eventName}.` };
  }
  if (workflowName !== "Cross-platform CI") {
    return { action: "skip", reason: `triggering workflow must be Cross-platform CI; got ${workflowName}.` };
  }
  if (conclusion !== "success") {
    return { action: "skip", reason: `CI conclusion must be success; got ${conclusion}.` };
  }
  if (headBranch !== "main") {
    return { action: "skip", reason: `CI head branch must be main; got ${headBranch}.` };
  }
  if (headSha !== liveMainSha) {
    return {
      action: "skip",
      reason: `live main moved after CI; audited ${headSha}, current ${liveMainSha}.`,
    };
  }
  if (packageName !== PACKAGE_NAME) {
    return {
      action: "skip",
      reason: `package must be ${PACKAGE_NAME}; got ${packageName}.`,
    };
  }
  if (packageVersion.includes("-")) {
    return {
      action: "skip",
      reason: `package version must be stable semver; got ${packageVersion}.`,
    };
  }
  if (versionOnNpm) {
    return {
      action: "skip",
      reason: `${PACKAGE_NAME}@${packageVersion} is already published on npm.`,
    };
  }

  return { action: "dispatch" };
}

module.exports = {
  decideForkAutoRelease,
};
