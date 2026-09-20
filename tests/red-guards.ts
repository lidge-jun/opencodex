/**
 * The guards: which source each one removes, and the test that must fail
 * without it.
 *
 * A module rather than a list inside `red.ts`, because
 * `scripts/guard-coverage.ts` needs the same data and used to recover it by
 * parsing that file's source. The hand-rolled parser was wrong four times —
 * escaped backticks, `\$`, `\"`, `\\`, then double-processing once the
 * fixes were chained — each caught only by its own floor. Two tools reading
 * one exported array cannot disagree about what the entries say.
 */

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

export const VOICE = "tests/server/audio-voice-routes.test.ts";

export const GUARDS: Guard[] = [
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
  {
    name: "a non-JSON speech body is refused",
    file: "src/server/audio-speech.ts",
    from: '  if (!/^application\\/json\\b/i.test(req.headers.get("content-type") ?? "")) {',
    to: "  if (false) {",
    expect: "refuses a body that is not JSON at all",
    suite: VOICE,
  },
  {
    name: "a speech body that is not an object is refused",
    file: "src/server/audio-speech.ts",
    from: "  if (!payload || typeof payload !== \"object\" || Array.isArray(payload)) {",
    to: "  if (false) {",
    expect: "refuses valid JSON that is not an object",
    suite: VOICE,
  },
  {
    name: "an unknown speech field is refused",
    file: "src/server/audio-speech.ts",
    from: "  const unknown = Object.keys(body).find(key => !FIELDS.has(key));",
    to: "  const unknown = undefined;",
    expect: "refuses a field the OpenAI shape does not define",
    suite: VOICE,
  },
  {
    name: "the speech input character cap is enforced",
    file: "src/server/audio-speech.ts",
    from: "  if (body.input.length > SPEECH_INPUT_MAX_CHARS) {",
    to: "  if (false) {",
    expect: "refuses an input past the character cap",
    suite: VOICE,
  },
];
