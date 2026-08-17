const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const COPILOT_RUNNER = 'node .github/scripts/run-copilot-inference.cjs';
const CLI_INSTALL = 'bash .github/scripts/install-copilot-cli.sh';
const SETUP_NODE = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const TOKEN_FALLBACK = 'COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN || github.token }}';
const COPILOT_VERSION = 'COPILOT_VERSION="v1.0.74"';
const COPILOT_SHA256 = 'COPILOT_SHA256="4a708b0a1cbaef4c2ca5c546a622f887a3b70e8a0432bc3cee0d386704816650"';

function readWorkflow(name) {
  return fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
}

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

test('issue automation streams prompts through the digest-pinned Copilot CLI without tool access', () => {
  const quality = readWorkflow('enforce-issue-quality.yml');
  const triage = readWorkflow('issue-triage.yml');
  const combined = quality + '\n' + triage;
  const installer = fs.readFileSync(path.join(ROOT, '.github', 'scripts', 'install-copilot-cli.sh'), 'utf8');

  assert.equal(count(quality, COPILOT_RUNNER), 2);
  assert.equal(count(triage, COPILOT_RUNNER), 1);
  assert.equal(count(quality, SETUP_NODE), 2);
  assert.equal(count(triage, SETUP_NODE), 1);
  assert.equal(count(quality, CLI_INSTALL), 2);
  assert.equal(count(triage, CLI_INSTALL), 1);
  assert.equal(count(quality, 'copilot-requests: write'), 2);
  assert.equal(count(triage, 'copilot-requests: write'), 1);
  assert.equal(count(quality, TOKEN_FALLBACK), 2);
  assert.equal(count(triage, TOKEN_FALLBACK), 1);

  assert.match(installer, new RegExp(COPILOT_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(installer, new RegExp(COPILOT_SHA256.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(installer, /sha256sum --check --status/);
  assert.match(installer, /releases\/download\/\$\{COPILOT_VERSION\}\/\$\{COPILOT_ASSET\}/);

  assert.doesNotMatch(combined, /npm install --global @github\/copilot/);
  assert.doesNotMatch(combined, /actions\/ai-inference@/);
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
