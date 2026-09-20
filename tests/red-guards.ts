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
  {
    name: "a non-multipart transcription body is refused",
    file: "src/server/audio-transcriptions.ts",
    from: '  if (!/^multipart\\/form-data\\s*;/i.test(req.headers.get("content-type") ?? "")) {',
    to: "  if (false) {",
    expect: "refuses a body that is not multipart",
    suite: VOICE,
  },
  {
    name: "a compressed transcription body is refused",
    file: "src/server/audio-transcriptions.ts",
    from: '  if (encoding && encoding !== "identity") return invalid("Compressed audio request bodies are not supported");',
    to: "",
    expect: "refuses a compressed body",
    suite: VOICE,
  },
  {
    name: "an unknown transcription field is refused",
    file: "src/server/audio-transcriptions.ts",
    from: "    if (!FIELDS.has(name)) return invalid(",
    to: "    if (false) return invalid(",
    expect: "refuses a field the OpenAI shape does not define",
    suite: VOICE,
  },
  {
    name: "the transcription model allowlist is enforced",
    file: "src/server/audio-transcriptions.ts",
    from: '  if (typeof model !== "string" || !MODELS.has(model))',
    to: "  if (false)",
    expect: "refuses a model the route does not serve",
    suite: VOICE,
  },
  {
    name: "the 16 KiB text field cap is enforced",
    file: "src/server/audio-transcriptions.ts",
    from: "Buffer.byteLength(value) > AUDIO_FIELD_MAX_BYTES",
    to: "false",
    expect: "refuses a text field past the 16 KiB cap",
    suite: VOICE,
  },
  {
    name: "the transcription language tag is validated",
    file: "src/server/audio-transcriptions.ts",
    from: "  if (language !== null && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language))",
    to: "  if (false)",
    expect: "refuses a language tag that is not BCP-47 shaped",
    suite: VOICE,
  },
  {
    name: "a non-string target is named as such",
    file: "src/config/voice-target.ts",
    from: '    if (typeof target !== "string") return `schema_invalid: ${route.label}.${field}: must be a string`;',
    to: "",
    expect: "a target that is not a string says so, naming the field",
    suite: VOICE,
  },
  {
    name: "an unresolvable target reports the resolution error",
    file: "src/config/voice-target.ts",
    from: '    if (resolution.kind === "invalid") return `schema_invalid: ${route.label}.${field}: ${resolution.error}`;',
    to: '    if (resolution.kind === "invalid") return `schema_invalid: ${route.label}.${field}: bad`;',
    expect: "a target naming no configured provider says which name is unknown",
    suite: VOICE,
  },
  {
    name: "a provider missing the route endpoint reports which endpoint",
    file: "src/config/voice-target.ts",
    from: "      if (endpointError) return `schema_invalid: ${route.label}.${field}: ${endpointError}`;",
    to: "      if (endpointError) return `schema_invalid: ${route.label}.${field}: not configured`;",
    expect: "a provider that exists but lacks the route's endpoint names the endpoint",
    suite: VOICE,
  },
  {
    name: "route headers must be strings",
    file: "src/config/voice-target.ts",
    from: "    if (!isRecord(headers) || Object.values(headers).some(value => typeof value !== \"string\")) {",
    to: "    if (false) {",
    expect: "headers that are not strings are refused, naming the field",
    suite: VOICE,
  },
  {
    name: "route protocols must be an array of strings",
    file: "src/config/voice-target.ts",
    from: "      if (!Array.isArray(protocols) || !protocols.every(protocol => typeof protocol === \"string\")) {",
    to: "      if (false) {",
    expect: "protocols that are not an array of strings are refused",
    suite: VOICE,
  },
];
