"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const workflow = fs.readFileSync(path.join(__dirname, "../workflows/agent-maintenance.yml"), "utf8");

describe("agent maintenance workflow", () => {
  it("uses trusted events, reconciliation, and curated schedules", () => {
    assert.match(workflow, /^  issues:\n\s+types: \[labeled\]/m);
    assert.match(workflow, /^  pull_request_target:[\s\S]*?branches: \[main\]/m);
    assert.match(workflow, /^  check_run:\n\s+types: \[completed\]/m);
    assert.match(workflow, /^  workflow_dispatch:/m);
    for (const cron of ["*/15 * * * *", "23 7 * * 1", "41 8 1 * *"]) assert.match(workflow, new RegExp(cron.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(workflow, /actions\.createWorkflowDispatch/);
    assert.match(workflow, /workflow_id: "enforce-pr-target\.yml"/);
    assert.match(workflow, /pull_number: String\(pr\.number\)/);
    assert.match(workflow, /jobs:\n  control:[\s\S]*?permissions:\n\s+actions: write/);
  });

  it("checks out only trusted default-branch controller code", () => {
    assert.match(workflow, /^permissions: \{\}$/m);
    const checkout = workflow.split("- name: Checkout trusted controller")[1].split(/\n {6}- name:/)[0];
    assert.match(checkout, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(checkout, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(checkout, /persist-credentials: false/);
    assert.match(checkout, /sparse-checkout: \|\s*\n\s*\.github\/scripts\s*\n\s*MAINTAINERS\.md/);
    assert.doesNotMatch(workflow, /github\.event\.pull_request\.head|refs\/pull\/|gh\s+pr\s+checkout/);
  });

  it("keeps dispatch bounded, idempotent, and permission gated", () => {
    assert.match(workflow, /github\.event_name != 'workflow_dispatch' \|\|[\s\S]*?github\.ref == format/);
    assert.match(workflow, /context\.eventName === "workflow_dispatch"/);
    assert.match(workflow, /refs\/heads\/\$\{defaultBranch\}/);
    assert.match(workflow, /getCollaboratorPermissionLevel/);
    assert.match(workflow, /context\.payload\.sender\?\.login/);
    assert.match(workflow, /issues\.listEvents/);
    assert.match(workflow, /latestActiveLabelActor/);
    assert.match(workflow, /issue\.user\?\.login === "github-actions\[bot\]"/);
    assert.match(workflow, /\["write", "maintain", "admin"\]/);
    assert.match(workflow, /trustedActiveMaintenanceCount/);
    assert.doesNotMatch(workflow, /filter\(issue =>\s*\n\s*\(issue\.labels[^\n]+agent:running/);
    assert.match(workflow, /createSessionIdempotently/);
    assert.match(workflow, /state\.sessionId = session\.name\.slice\("sessions\/"\.length\)/);
    assert.match(workflow, /requirePlanApproval/);
    assert.match(workflow, /issue\.title\.startsWith\("\[agent:docs\]"\)/);
    assert.match(workflow, /issue\.title\.startsWith\("\[agent:tests\]"\)/);
    assert.match(workflow, /AGENT_MAINTENANCE_MODE/);
    assert.match(workflow, /AGENT_MAINTENANCE_SCHEDULES/);
    assert.match(workflow, /Schedule dispatch is disabled/);
    assert.match(workflow, /JULES_API_KEY/);
    assert.match(workflow, /context\.eventName === "check_run"/);
    assert.match(workflow, /context\.payload\.check_run\?\.name !== "Cursor Bugbot"/);
    assert.match(workflow, /Number\(context\.payload\.check_run\?\.app\?\.id\) !== configuredBugbotAppId/);
    assert.ok(
      workflow.indexOf('if (mode === "shadow")') < workflow.indexOf("const client = createJulesClient"),
      "off and shadow modes must return before Jules client construction",
    );
  });

  it("reconciles exact-head reviews and enforces the repair ceiling", () => {
    assert.match(workflow, /exactHeadBugbotEvidence/);
    assert.match(workflow, /validateSessionPullRequest/);
    assert.match(workflow, /state\.pullRequestNumber !== validated\.number/);
    assert.match(workflow, /Jules session changed pull request identity/);
    assert.match(workflow, /latestBugbot\.conclusion !== "failure" && latestBugbot\.conclusion !== "neutral"/);
    assert.match(workflow, /github\.graphql/);
    assert.match(workflow, /reviewThreads/);
    assert.match(workflow, /verifiedBugbotFindings/);
    assert.match(workflow, /buildJulesRepairComment/);
    assert.match(workflow, /repairAttempts >= MAX_REPAIR_ATTEMPTS/);
    assert.match(workflow, /repairMarker/);
    assert.match(workflow, /isExpectedJulesHeadAdvance/);
    assert.match(workflow, /repos\.compareCommitsWithBasehead/);
    assert.match(workflow, /repos\.getCommit/);
    assert.match(workflow, /JULES_BOT_USER_ID/);
    assert.match(workflow, /isAgentProtectedPath/);
    assert.match(workflow, /file\.previous_filename/);
    assert.match(workflow, /changedFileListComplete/);
    assert.match(workflow, /agent:needs-human/);
    assert.match(workflow, /\["ci", "enforce-target", "hygiene"\]/);
    assert.match(workflow, /baselineReady/);
    assert.match(workflow, /state\.reason = `automated-review-passed:\$\{pr\.head\.sha\}`/);
    assert.match(workflow, /pr\.merged \? "PR merged" : "Maintenance PR closed without merge"/);
    assert.match(workflow, /quotaExhaustionExpired/);
    assert.match(workflow, /Jules quota remained exhausted for more than 24 hours/);
    assert.match(workflow, /state\.reason = error\.message/);
    assert.match(workflow, /comments\.filter\(item =>/);
    assert.match(workflow, /\.sort\(\(a, b\) => Number\(b\.id\) - Number\(a\.id\)\)/);
    assert.match(workflow, /error\.comment/);
    assert.match(workflow, /julesSessionDisposition/);
  });
});
