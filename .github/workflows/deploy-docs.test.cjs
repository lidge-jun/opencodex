const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, 'deploy-docs.yml'), 'utf8');
function scriptFor(step) {
  const start = workflow.indexOf(`      - name: ${step}\n`);
  assert.notEqual(start, -1);
  const rest = workflow.slice(start);
  const match = rest.match(/\n        run: \|\n((?:          .*\n|\n)+)/);
  assert.ok(match);
  return match[1].replace(/^          /gm, '');
}
const selection = scriptFor('Resolve published stable source');
const guard = scriptFor('Require trusted dispatch');
const sha = 'a'.repeat(40);
function run(script, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-pages-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/bash\nprintf "%s" "$MOCK_RELEASE"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'git'), '#!/bin/bash\nif [ "$MOCK_GIT_FAIL" = 1 ]; then exit 1; fi\nprintf "%s\\n" "$MOCK_SHA"\n', { mode: 0o755 });
    const output = path.join(dir, 'output');
    fs.writeFileSync(output, '');
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev', RELEASE_TAG: '',
      MOCK_RELEASE: JSON.stringify({ tag_name: 'v2.3.4', draft: false, prerelease: false }), MOCK_SHA: sha,
      ...overrides };
    const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
    return { ...result, output: fs.readFileSync(output, 'utf8') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('only trusted dev dispatch reaches the build', () => {
  assert.equal(run(guard).status, 0);
  assert.notEqual(run(guard, { GITHUB_REF: 'refs/heads/pr-head' }).status, 0);
  assert.notEqual(run(guard, { GITHUB_EVENT_NAME: 'push' }).status, 0);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /ref: \$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(workflow, /permissions:\n      pages: write\n      id-token: write/);
});
test('latest and explicit published stable release select immutable commit', () => {
  const latest = run(selection);
  assert.equal(latest.status, 0, latest.stderr);
  assert.equal(latest.output, `sha=${sha}\n`);
  const explicit = run(selection, { RELEASE_TAG: 'v2.3.4', MOCK_RELEASE: JSON.stringify({ tagName: 'v2.3.4', isDraft: false, isPrerelease: false }) });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.output, `sha=${sha}\n`);
});
test('refuses prereleases, drafts, mismatch, malformed tags and missing commits', () => {
  for (const overrides of [
    { RELEASE_TAG: 'v2.3.4-preview.1' }, { RELEASE_TAG: '$(touch evil)' },
    { MOCK_RELEASE: JSON.stringify({ tag_name: 'v2.3.4', draft: true, prerelease: false }) },
    { MOCK_RELEASE: JSON.stringify({ tag_name: 'v2.3.4', draft: false, prerelease: true }) },
    { RELEASE_TAG: 'v2.3.4', MOCK_RELEASE: JSON.stringify({ tagName: 'v2.3.5', isDraft: false, isPrerelease: false }) },
    { MOCK_GIT_FAIL: '1' }, { MOCK_SHA: 'bad' }, { MOCK_RELEASE: '{}' },
  ]) {
    const result = run(selection, overrides);
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.equal(result.output, '');
  }
});
