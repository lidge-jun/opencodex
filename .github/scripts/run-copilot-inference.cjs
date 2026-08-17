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

const rawTimeout = Number(process.env.COPILOT_TIMEOUT_MS || 120_000);
const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
  ? Math.floor(rawTimeout)
  : 120_000;

const args = [
  '-s',
  '--no-ask-user',
  '--no-custom-instructions',
  '--no-auto-update',
];

const copilotEnv = { ...process.env };
if (copilotEnv.COPILOT_GITHUB_TOKEN) {
  // Copilot CLI v1.0.74 authenticates from GH_TOKEN or GITHUB_TOKEN.
  copilotEnv.GITHUB_TOKEN = copilotEnv.COPILOT_GITHUB_TOKEN;
}

const result = spawnSync('copilot', args, {
  input: prompt,
  encoding: 'utf8',
  env: copilotEnv,
  maxBuffer: 16 * 1024 * 1024,
  timeout,
  killSignal: 'SIGKILL',
});

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.error) {
  const errorCode = result.error.code || 'spawn_error';
  const signal = result.signal || 'none';
  fail(`Copilot CLI execution failed (${errorCode}; signal=${signal}): ${result.error.message}`);
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
