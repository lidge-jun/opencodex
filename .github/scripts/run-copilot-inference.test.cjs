const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'run-copilot-inference.cjs');

function makeFakeCopilot(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-copilot-'));
  const file = path.join(dir, 'copilot');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return { dir, file };
}

function outputValue(file, key) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(new RegExp(`${key}<<([^\\n]+)\\n([\\s\\S]*?)\\n\\1(?:\\n|$)`));
  assert.ok(match, `missing ${key} output in ${text}`);
  return match[2];
}

test('streams a large prompt over stdin and maps the Copilot token to GITHUB_TOKEN', () => {
  const fake = makeFakeCopilot(`
    const fs = require('node:fs');
    const input = fs.readFileSync(0, 'utf8');
    const argvBytes = Buffer.byteLength(process.argv.slice(2).join(' '));
    if (argvBytes > 8192) {
      console.error('prompt leaked into argv');
      process.exit(91);
    }
    process.stdout.write(JSON.stringify({
      inputBytes: Buffer.byteLength(input),
      argv: process.argv.slice(2),
      githubToken: process.env.GITHUB_TOKEN || '',
    }));
  `);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-runner-test-'));
  const promptFile = path.join(dir, 'prompt.txt');
  const outputFile = path.join(dir, 'output.txt');
  const prompt = 'x'.repeat(512 * 1024);
  fs.writeFileSync(promptFile, prompt);
  fs.writeFileSync(outputFile, '');

  const result = spawnSync(process.execPath, [RUNNER, promptFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
      COPILOT_SYSTEM_PROMPT: 'system instruction',
      COPILOT_GITHUB_TOKEN: 'test-token',
      GITHUB_TOKEN: '',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(outputValue(outputFile, 'response'));
  assert.ok(response.inputBytes > Buffer.byteLength(prompt));
  assert.deepEqual(response.argv, ['-s', '--no-ask-user', '--no-custom-instructions', '--no-auto-update']);
  assert.equal(response.githubToken, 'test-token');
});

test('surfaces Copilot stderr and preserves a non-zero exit code', () => {
  const fake = makeFakeCopilot(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.error('copilot auth failed: test diagnostic');
      process.exit(7);
    });
  `);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-runner-test-'));
  const promptFile = path.join(dir, 'prompt.txt');
  const outputFile = path.join(dir, 'output.txt');
  fs.writeFileSync(promptFile, 'hello');
  fs.writeFileSync(outputFile, '');

  const result = spawnSync(process.execPath, [RUNNER, promptFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
      COPILOT_SYSTEM_PROMPT: 'system instruction',
      COPILOT_GITHUB_TOKEN: 'test-token',
    },
  });

  assert.equal(result.status, 7);
  assert.match(result.stderr, /copilot auth failed: test diagnostic/);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), '');
});

test('kills a hung Copilot process at the configured timeout', () => {
  const fake = makeFakeCopilot(`
    process.stderr.write('copilot started\\n');
    setInterval(() => {}, 1000);
  `);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-runner-test-'));
  const promptFile = path.join(dir, 'prompt.txt');
  const outputFile = path.join(dir, 'output.txt');
  fs.writeFileSync(promptFile, 'hello');
  fs.writeFileSync(outputFile, '');

  const result = spawnSync(process.execPath, [RUNNER, promptFile], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
      COPILOT_SYSTEM_PROMPT: 'system instruction',
      COPILOT_GITHUB_TOKEN: 'test-token',
      COPILOT_TIMEOUT_MS: '75',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ETIMEDOUT/);
  assert.match(result.stderr, /SIGKILL/);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), '');
});
