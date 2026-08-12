const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_ACTION = 'actions/ai-inference@2c43c91ae16266ca159d311430343c67a5ffa222';
const CLI_INSTALL = 'npm install --global @github/copilot@1.0.74';
const SETUP_NODE = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';

function readWorkflow(name) {
  return fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
}

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

test('issue automation uses pinned Copilot inference without tool access', () => {
  const quality = readWorkflow('enforce-issue-quality.yml');
  const triage = readWorkflow('issue-triage.yml');
  const combined = quality + '\n' + triage;

  assert.equal(count(quality, AI_ACTION), 2);
  assert.equal(count(triage, AI_ACTION), 1);
  assert.equal(count(quality, SETUP_NODE), 2);
  assert.equal(count(triage, SETUP_NODE), 1);
  assert.equal(count(quality, CLI_INSTALL), 2);
  assert.equal(count(triage, CLI_INSTALL), 1);
  assert.equal(count(quality, 'copilot-requests: write'), 2);
  assert.equal(count(triage, 'copilot-requests: write'), 1);
  assert.equal(count(quality, 'GITHUB_TOKEN: ${{ github.token }}'), 2);
  assert.equal(count(triage, 'GITHUB_TOKEN: ${{ github.token }}'), 1);
  assert.equal(count(quality, 'model: ""'), 2);
  assert.equal(count(triage, 'model: ""'), 1);

  assert.doesNotMatch(combined, /\bmodels:\s*read\b/);
  assert.doesNotMatch(combined, /max-tokens:/);
  assert.doesNotMatch(combined, /copilot-allow-tools:/);
  assert.doesNotMatch(combined, /--allow-tool/);
  assert.doesNotMatch(combined, /GitHub Models/);
});

test('Copilot failures leave issue enforcement and triage retryable', () => {
  const quality = readWorkflow('enforce-issue-quality.yml');
  const triage = readWorkflow('issue-triage.yml');

  assert.equal(count(quality, 'continue-on-error: true'), 6);
  assert.equal(count(triage, 'continue-on-error: true'), 3);

  assert.equal(
    count(
      quality,
      "if: steps.prepare.outputs.should_translate == 'true' && steps.copilot.outcome == 'success'",
    ),
    2,
  );
  assert.equal(
    count(
      quality,
      "if: steps.prepare.outputs.should_translate == 'true' && steps.ai.outcome == 'success'",
    ),
    2,
  );
  assert.equal(count(quality, "steps.ai.outcome == 'success' &&"), 2);
  assert.equal(count(quality, "steps.parse.outcome == 'success' &&"), 2);
  assert.match(quality, /leaving the issue unchanged and retryable/);
  assert.match(quality, /leaving the comment unchanged and retryable/);

  assert.equal(
    count(quality, "if: steps.prepare.outputs.should_translate == 'true' && steps.node.outcome == 'success'"),
    2,
  );
  assert.match(triage, /if: steps\.node\.outcome == 'success'/);
  assert.match(triage, /if: steps\.copilot\.outcome == 'success'/);
  assert.match(triage, /if: steps\.infer\.outcome == 'success'/);
  assert.match(triage, /skipping duplicate suggestions for this issue/);

  // The deterministic quality gate must still run when translation fails.
  assert.match(quality, /needs: translate/);
  assert.match(quality, /always\(\) &&\n\s+needs\.translate\.result != 'cancelled'/);
});
