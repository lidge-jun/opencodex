const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const promptPath = process.argv[2];
let userPrompt;
try {
  userPrompt = promptPath
    ? fs.readFileSync(promptPath, 'utf8')
    : fs.readFileSync(0, 'utf8');
} catch (error) {
  fail(`Unable to read Copilot prompt: ${error instanceof Error ? error.message : String(error)}`);
}

const systemPrompt = String(process.env.COPILOT_SYSTEM_PROMPT || '').trim();
const prompt = systemPrompt
  ? `${systemPrompt}\n\n${userPrompt}`
  : userPrompt;

const args = [
  '-s',
  '--no-ask-user',
  '--no-custom-instructions',
  '--no-auto-update',
];

const result = spawnSync('copilot', args, {
  input: prompt,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) {
  fail(`Failed to spawn Copilot CLI: ${result.error.message}`);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.status !== 0) {
  process.exit(Number.isInteger(result.status) ? result.status : 1);
}

const outputFile = process.env.GITHUB_OUTPUT;
if (!outputFile) {
  fail('GITHUB_OUTPUT is not set.');
}

const response = String(result.stdout || '').trimEnd();
const delimiter = `COPILOT_RESPONSE_${crypto.randomBytes(12).toString('hex')}`;
fs.appendFileSync(outputFile, `response<<${delimiter}\n${response}\n${delimiter}\n`);
