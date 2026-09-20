/**
 * Break each guard this branch added, and require the named test to fail.
 *
 * A green suite proves the tests pass. It does not prove they would notice if
 * the code were wrong — and in this work they four times would not have, every
 * time because the test called a helper or used a fixture tidier than the real
 * thing. The most recent: the redacted-presence test asserted on
 * `redactedFieldPresence` while the bug lived in `safeConfigDTO`, and stayed
 * green with the DTO reverted.
 *
 * The lesson did not transfer by being written down. It transferred to the
 * sibling repo by becoming a command, so here is the command.
 *
 * Run: bun tests/red.ts
 */

import { $ } from "bun";

type Guard = {
  name: string;
  file: string;
  /** Exact source to remove or replace. Must appear once. */
  from: string;
  to: string;
  /** The test that must fail without it — not merely "something failed". */
  expect: string;
  /** The file to run. Narrower than the suite, so this stays usable. */
  suite: string;
};

const VOICE = "tests/server/audio-voice-routes.test.ts";

const GUARDS: Guard[] = [
  {
    name: "the caller's model is not forwarded to a custom backend",
    file: "src/server/audio-transcriptions.ts",
    from: `    if (target.model !== undefined) form.append("model", target.model);`,
    to: `    form.append("model", String(input.model ?? ""));`,
    expect: "the caller's OpenAI model name is not forwarded to a custom backend",
    suite: VOICE,
  },
  {
    name: "speech reads speechUrl, not the transcription endpoint",
    file: "src/config/voice-target.ts",
    from: `    url: "speechUrl",`,
    to: `    url: "transcriptionUrl",`,
    expect: "each route reads its own endpoint field",
    suite: VOICE,
  },
  {
    name: "an unconfigured speech backend is 501, not a fallback",
    file: "src/server/audio-speech.ts",
    from: `    return formatErrorResponse(501, "unsupported_route",`,
    to: `    return formatErrorResponse(404, "unsupported_route",`,
    expect: "an unconfigured speech backend reports 501, not a silent OpenAI fallback",
    suite: VOICE,
  },
  {
    name: "the voice routing blocks are readable through the DTO",
    file: "src/server/auth-cors.ts",
    from: `    ...(config.speech ? { speech: config.speech } : {}),\n`,
    to: "",
    expect: "returns the voice routing blocks so they can be read back",
    suite: VOICE,
  },
  {
    name: "a presence flag for every redacted field",
    file: "src/server/auth-cors.ts",
    from: `      ...redactedFieldPresence(provider),`,
    to: `      hasApiKey: !!provider.apiKey,\n      hasHeaders: !!provider.headers && Object.keys(provider.headers).length > 0,`,
    expect: "a provider carrying route headers no longer reports none",
    suite: VOICE,
  },
  {
    name: "the speech route is classified for inbound body admission",
    file: "src/server/inbound-body-admission.ts",
    from: `  "/v1/audio/speech",`,
    to: "",
    expect: "every loopback /v1 route is classified for inbound body admission",
    suite: "tests/server/server-request-body-size.test.ts",
  },
  {
    name: "an unknown key in a route block is refused",
    file: "src/config/voice-target.ts",
    from: `  if (unknown) return \`schema_invalid: \${route.label}.\${unknown}: unknown key\`;`,
    to: "",
    expect: "an unknown key in a route block is refused",
    suite: VOICE,
  },
  {
    name: "a route block that is not an object is refused",
    file: "src/config/voice-target.ts",
    from: `  if (!isRecord(value)) return \`schema_invalid: \${route.label}: must be an object\`;`,
    to: "",
    expect: "a route block that is not an object is refused",
    suite: VOICE,
  },
  {
    name: "a byModel map that is not an object is refused",
    file: "src/config/voice-target.ts",
    from: `    if (!isRecord(byModel)) return \`schema_invalid: \${route.label}.byModel: must be an object\`;`,
    to: "",
    expect: "a byModel map that is not an object is refused",
    suite: VOICE,
  },
  {
    name: "a provider with no endpoint for the route is named",
    file: "src/config/voice-target.ts",
    from: "  if (typeof url !== \"string\" || url.trim() === \"\") {",
    to: "  if (false) {",
    expect: "a provider with no voice endpoint at all is refused",
    suite: VOICE,
  },
];

async function runSuite(suite: string): Promise<{ ok: boolean; output: string }> {
  const done = await $`bun test ${suite}`.nothrow().quiet();
  return { ok: done.exitCode === 0, output: done.stdout.toString() + done.stderr.toString() };
}

const misses: string[] = [];

for (const guard of GUARDS) {
  const path = Bun.file(guard.file);
  const original = await path.text();
  const occurrences = original.split(guard.from).length - 1;
  if (occurrences !== 1) {
    misses.push(`${guard.name}: its source appears ${occurrences} times in ${guard.file}`);
    continue;
  }
  await Bun.write(guard.file, original.replace(guard.from, guard.to));
  try {
    const { ok, output } = await runSuite(guard.suite);
    if (ok) misses.push(`${guard.name}: nothing failed — "${guard.expect}" did not notice`);
    else if (!output.includes(guard.expect)) {
      misses.push(`${guard.name}: something failed, but not "${guard.expect}"`);
    } else console.log(`  red   ${guard.name}`);
  } finally {
    await Bun.write(guard.file, original);
  }
}

const { ok, output } = await runSuite(VOICE);
if (!ok) {
  console.log("restore failed — the suite is red with the original source\n" + output);
  process.exit(1);
}
for (const miss of misses) console.log(`  MISS  ${miss}`);
console.log(`\n${GUARDS.length - misses.length}/${GUARDS.length} guards are actually tested`);
process.exit(misses.length ? 1 : 0);
