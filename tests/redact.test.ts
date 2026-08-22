import { describe, expect, test } from "bun:test";
import {
  REDACTED_SECRET,
  redactHeaders,
  redactSecretString,
  redactSecrets,
  redactUrlForLog,
} from "../src/lib/redact";

describe("redactSecretString", () => {
  test("masks bearer, api, access, refresh, and profile values", () => {
    const input = [
      "Authorization: Bearer access-token-value-123456",
      "api_key=sk-secret-provider-key",
      "accessToken=access-live-value",
      "refresh_token=refresh-live-value",
      "clientSecret=client-secret-live-value",
      "profile arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
    ].join("\n");

    const redacted = redactSecretString(input);
    expect(redacted).toContain(`Bearer ${REDACTED_SECRET}`);
    expect(redacted).toContain(`api_key=${REDACTED_SECRET}`);
    expect(redacted).toContain(`accessToken=${REDACTED_SECRET}`);
    expect(redacted).toContain(`refresh_token=${REDACTED_SECRET}`);
    expect(redacted).toContain(`clientSecret=${REDACTED_SECRET}`);
    expect(redacted).not.toContain("access-token-value-123456");
    expect(redacted).not.toContain("sk-secret-provider-key");
    expect(redacted).not.toContain("refresh-live-value");
    expect(redacted).not.toContain("client-secret-live-value");
    expect(redacted).not.toContain("arn:aws:codewhisperer");
  });

  test("preserves non-secret diagnostic text", () => {
    expect(redactSecretString("status=429 model=gpt-5.5")).toBe("status=429 model=gpt-5.5");
  });

  test("masks colon-labelled credentials echoed back by an upstream error", () => {
    // #1020 review: upstream 4xx bodies quote the offending header at us. The
    // `=` rules never fire for `header: value`, so a custom credential used to
    // survive into the client-visible error text.
    const input = [
      "x-api-key: customcredential123456",
      "X-Goog-Api-Key: another-live-credential",
      "client_secret: not-a-sk-shaped-value",
      "token: opaque-session-value",
    ].join("\n");

    const redacted = redactSecretString(input);
    expect(redacted).toContain(`x-api-key: ${REDACTED_SECRET}`);
    expect(redacted).toContain(`X-Goog-Api-Key: ${REDACTED_SECRET}`);
    expect(redacted).not.toContain("customcredential123456");
    expect(redacted).not.toContain("another-live-credential");
    expect(redacted).not.toContain("not-a-sk-shaped-value");
    expect(redacted).not.toContain("opaque-session-value");
  });

  test("leaves non-credential colon labels readable", () => {
    // The colon rule must not swallow ordinary diagnostics.
    expect(redactSecretString("model: gpt-5.5\nstatus: 429\nrequest: ocx-abc123"))
      .toBe("model: gpt-5.5\nstatus: 429\nrequest: ocx-abc123");
  });

  test("masks the WHOLE colon-labelled value, including delimiter-bearing forms", () => {
    // Re-review of the first fix: tokenizing the value on quotes, spaces, and
    // semicolons leaked every variant that contains one. A credential header's
    // value is the rest of the line, so that is what must be masked.
    // An unquoted header LABEL always masks to end of line, quotes and all —
    // only a quoted label (a proven serialized field) terminates early.
    expect(redactSecretString('x-api-key: "quotedcredential123456"'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Basic dXNlcjpwYXNz"))
      .toBe(`Authorization: ${REDACTED_SECRET}`);
    expect(redactSecretString("Cookie: session=secret-one; csrf=secret-two"))
      .toBe(`Cookie: ${REDACTED_SECRET}`);
  });

  test("keeps the Bearer scheme readable while masking its token", () => {
    // An auth scheme is diagnostically useful; the credential after it is not.
    expect(redactSecretString("Authorization: Bearer abcdefgh12345678"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("a Bearer-prefixed value cannot smuggle a credential past the header rule", () => {
    // Re-review history: the colon rule first EXEMPTED `Bearer` and left it to
    // a separate rule, so anything that rule could not parse escaped both — a
    // quoted value, one containing punctuation, or one under the length floor.
    // The scheme is now handled in the same pass, so the token after it is
    // always consumed whatever its shape.
    // The Bearer carve-out is also scoped to headers where a scheme is
    // meaningful; on x-api-key the word buys nothing and the value is masked
    // whole, which closed `x-api-key: Bearer first <secret>`.
    expect(redactSecretString('x-api-key: Bearer "smuggledcredential123456"'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer custom:credential123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: Bearer short"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: Bearer first secondsecret123456"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
  });

  test("a suffix appended after the public marker is not trusted", () => {
    // `[REDACTED]` is a PUBLIC string: an upstream can emit it too. Treating it
    // as proof that a prefix was already sanitized let a credential ride along
    // behind it. Nothing in the value grants trust now.
    expect(redactSecretString("x-api-key: Bearer [REDACTED].smuggledcredential123456"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: [REDACTED],smuggledcredential123456"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer abcdefgh12345678,smuggledcredential123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("nothing after a credential label survives, at any nesting depth", () => {
    // Four review rounds each found a new way to hide a credential inside
    // whatever the previous round chose to preserve: a second label, a
    // repeated scheme word, then a third token two levels deep. Preserving
    // attacker-controlled text next to a credential was the bug itself.
    expect(redactSecretString("Authorization: Bearer firstsecret123456 x-api-key: secondsecret123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer Bearer nestedcredential123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization: Bearer a123456 Bearer b123456 c123456"))
      .toBe(`Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("colon look-alikes do not bypass credential-label recognition", () => {
    // A full-width or small-form colon reads as a separator to a human and to
    // whatever produced the error body, so matching only ASCII ":" was a
    // bypass rather than strictness.
    // The fold is a MATCHING view: the original separator byte is preserved.
    for (const colon of ["\uFF1A", "\uFE55", "\uFE13", "\u205A", "\u0589", "\u1361", "\u16EC", "\u1803"]) {
      expect(redactSecretString(`x-api-key${colon}unicodesecret123456`))
        .toBe(`x-api-key${colon}${REDACTED_SECRET}`);
    }
    expect(redactSecretString("x-api-key\u200B: secretcredential123456"))
      .toBe(`x-api-key\u200B: ${REDACTED_SECRET}`);
    expect(redactSecretString("Authorization\u2060: Basic dXNlcjpwYXNz"))
      .toBe(`Authorization\u2060: ${REDACTED_SECRET}`);
  });

  test("folding never rewrites an unrelated diagnostic", () => {
    // Normalizing the string itself turned `ratio∶1` into `ratio:1`. Offsets
    // map back to the original bytes so untouched text is byte-identical.
    const diagnostic = "model\u2236gpt-5.5 status\u205A429 ratio\u2236 1";
    expect(redactSecretString(diagnostic)).toBe(diagnostic);
  });

  test("a label disguised with homoglyphs or invisible characters is still recognized", () => {
    // Review kept finding another character that splits or spoofs the label.
    // The matching view now folds cross-script homoglyphs and drops every
    // default-ignorable code point, rather than growing another finite list.
    const disguised = [
      "x-api-k\u0435y",      // Cyrillic e
      "x-\u0430pi-key",      // Cyrillic a
      "x-api-ke\u034Fy",     // combining grapheme joiner
      "x-api-ke\u2066y",     // bidi isolate
      "x-api-ke\u2069y",     // pop directional isolate
      "x-api-ke\u061Cy",     // arabic letter mark
      "x-api-ke\u180Ey",     // mongolian vowel separator
    ];
    for (const label of disguised) {
      expect(redactSecretString(`${label}: secretcredential123456`))
        .toBe(`${label}: ${REDACTED_SECRET}`);
    }
  });

  test("a longer field name that merely ends with a credential label is untouched", () => {
    // `\b` matched after `-` and `_`, so these were redacted as if they were
    // the credential headers they only end with.
    expect(redactSecretString("not-authorization: public-diagnostic-value"))
      .toBe("not-authorization: public-diagnostic-value");
    expect(redactSecretString("internal_token: public-diagnostic-value"))
      .toBe("internal_token: public-diagnostic-value");
  });

  test("supplementary-plane characters are canonicalized, not split", () => {
    // The fold iterated UTF-16 code UNITS, so a supplementary character arrived
    // as two halves and neither half matched any property test. Mathematical
    // letters and high variation selectors walked straight past.
    expect(redactSecretString("\u{1D569}-api-key: credentialvalue123456"))
      .toBe(`\u{1D569}-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("\u{1D431}-api-key: credentialvalue123456"))
      .toBe(`\u{1D431}-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-ke\u{E0100}y: credentialvalue123456"))
      .toBe(`x-api-ke\u{E0100}y: ${REDACTED_SECRET}`);
  });

  test("cross-script homoglyphs NFKD leaves alone are still folded", () => {
    expect(redactSecretString("passwor\u0501: credentialvalue123456"))
      .toBe(`passwor\u0501: ${REDACTED_SECRET}`);
    expect(redactSecretString("s\u03B5cret: credentialvalue123456"))
      .toBe(`s\u03B5cret: ${REDACTED_SECRET}`);
    expect(redactSecretString("\u03C4oken: credentialvalue123456"))
      .toBe(`\u03C4oken: ${REDACTED_SECRET}`);
  });

  test("ordinary supplementary text survives the fold unchanged", () => {
    expect(redactSecretString("emoji \u{1F600} and text stay intact"))
      .toBe("emoji \u{1F600} and text stay intact");
  });

  test("a serialized headers object does not hide the credential", () => {
    // Structural, not a confusable gap: ordinary JSON serialization puts a
    // closing quote between the field name and the colon, so a bare `label:`
    // pattern never saw it, and the older JSON rules listed only a few field
    // names without sharing the credential-label grammar.
    for (const input of [
      'request headers: {"x-api-key":"credentialvalue123456"}',
      'headers={"authorization":"Basic dXNlcjpwYXNz"}',
      'headers={"cookie":"session=credentialvalue123456"}',
      "{'x-api-key': 'credentialvalue123456'}",
      '"x-goog-api-key" : "credentialvalue123456"',
    ]) {
      const redacted = redactSecretString(input);
      expect(redacted).toContain(REDACTED_SECRET);
      expect(redacted).not.toContain("credentialvalue123456");
      expect(redacted).not.toContain("dXNlcjpwYXNz");
    }
  });

  test("the value always runs to end of line, siblings included", () => {
    // Three attempts tried to stop early and keep the siblings readable — at
    // the first closing quote, at a quote followed by punctuation, and only
    // when the LABEL was quoted. Each leaked, because every early stop reads
    // attacker-controlled text to decide where a secret ends. Losing the
    // siblings makes a diagnostic uglier; stopping early makes it leak.
    expect(redactSecretString('{"x-api-key":"secret123456","model":"gpt-5.5"}'))
      .toBe(`{"x-api-key":${REDACTED_SECRET}`);
  });

  test("a decoy quoted value does not end the mask early", () => {
    // Early termination is decided by the LABEL, not the value. Two attempts
    // inspected the value instead — first "stop at the closing quote", then
    // "stop at a closing quote followed by punctuation" — and both let a decoy
    // end the mask and hand the real credential back as a suffix, masking LESS
    // than the rule did before quoted-key support existed.
    expect(redactSecretString('x-api-key: "decoy"credential-suffix-123456'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: 'decoy'credential-suffix-123456"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString('Authorization: "decoy"Bearer realsecret123456'))
      .toBe(`Authorization: ${REDACTED_SECRET}`);
    // A terminator after the decoy does not help either.
    for (const terminator of [",", ";", ")", "]", "}"]) {
      expect(redactSecretString(`x-api-key: "decoy"${terminator}credential-suffix-123456`))
        .toBe(`x-api-key: ${REDACTED_SECRET}`);
    }
  });

  test("no framing or quoting makes the rule mask less", () => {
    // The monotonicity guarantee, asserted directly.
    expect(redactSecretString('x-api-key: "quotedcredential123456"'))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    expect(redactSecretString("x-api-key: plain secret with spaces 123456"))
      .toBe(`x-api-key: ${REDACTED_SECRET}`);
    // An UNMATCHED opening quote before the label is not a serialized field.
    expect(redactSecretString('"x-api-key: "decoy",credential-suffix-123456'))
      .toBe(`"x-api-key: ${REDACTED_SECRET}`);
    // Nor is a correctly quoted key whose value quote is a decoy.
    expect(redactSecretString('{"x-api-key":"decoy"credential-suffix-123456}'))
      .toBe(`{"x-api-key":${REDACTED_SECRET}`);
  });

  test("credential names are recognized in non-colon framings", () => {
    // An upstream error body is not always a header dump: it can echo the
    // request form-encoded, as XML, or as a multipart part. A colon-only
    // matcher sees none of those.
    expect(redactSecretString("authorization=Basic%20dXNlcjpwYXNz&model=gpt-5.5"))
      .toBe(`authorization=${REDACTED_SECRET}&model=gpt-5.5`);
    expect(redactSecretString("<x-api-key>secret123456</x-api-key>"))
      .toBe(`<x-api-key${REDACTED_SECRET}`);
    const multipart = redactSecretString('Content-Disposition: form-data; name="authorization"\r\n\r\nBasic dXNlcjpwYXNz\r\n--boundary');
    expect(multipart).toContain(REDACTED_SECRET);
    expect(multipart).not.toContain("dXNlcjpwYXNz");
  });

  test("exaApiKey is masked in JSON, colon, and query framings", () => {
    for (const input of [
      '{"exaApiKey":"exa-canary-1234567890"}',
      "exaApiKey: exa-canary-1234567890",
      "exaApiKey=exa-canary-1234567890&model=x",
    ]) {
      const redacted = redactSecretString(input);
      expect(redacted).toContain(REDACTED_SECRET);
      expect(redacted).not.toContain("exa-canary-1234567890");
    }
  });

  test("XML credentials are covered by tag name, identifying attribute, and attribute value", () => {
    // A qualifying tag keeps only its NAME and masks to end of line. Using the
    // closing tag as the stopping point was the same early-termination mistake
    // as everywhere else: same-name nesting ended the mask at the INNER
    // `</authorization>` and exposed the outer element's remaining content, and
    // a self-closing tag had no closing tag to find at all.
    for (const input of [
      '<header name="authorization">Basic dXNlcjpwYXNz</header>',
      '<field key="x-api-key">secret123456</field>',
      '<authorization value="Basic dXNlcjpwYXNz">public-status</authorization>',
      '<authorization type="Basic" value="dXNlcjpwYXNz">public</authorization>',
      '<header name="authorization" value="Basic dXNlcjpwYXNz">public</header>',
      '<authorization><value>Basic dXNlcjpwYXNz</value></authorization>',
      // Self-closing, namespace-qualified, and same-name nesting.
      '<authorization value="Basic dXNlcjpwYXNz"/>',
      '<header name="authorization" value="Basic dXNlcjpwYXNz"/>',
      "<ns:authorization>Basic dXNlcjpwYXNz</ns:authorization>",
      "<authorization><authorization>decoy</authorization>credential-suffix-123456</authorization>",
      // An opening tag may legally span lines, and XML allows whitespace
      // around an attribute `=`. End-of-line was the second stopping point
      // that leaked here, after the closing tag.
      '<authorization\n value="Basic dXNlcjpwYXNz">\npublic-status\n</authorization>',
      '<header name = "authorization">Basic dXNlcjpwYXNz</header>',
      '<field key\t=\t"x-api-key">secret123456</field>',
    ]) {
      const redacted = redactSecretString(input);
      expect(redacted).toContain(REDACTED_SECRET);
      expect(redacted).not.toContain("dXNlcjpwYXNz");
      expect(redacted).not.toContain("secret123456");
      expect(redacted).not.toContain("credential-suffix-123456");
    }
  });

  test("a tag that merely starts with a credential word keeps its value", () => {
    // Without an exact tag-name boundary these lost their values.
    expect(redactSecretString("<authorizationStatus>denied</authorizationStatus>"))
      .toBe("<authorizationStatus>denied</authorizationStatus>");
    expect(redactSecretString("<token-count>42</token-count>"))
      .toBe("<token-count>42</token-count>");
    // A prefixed attribute does not identify a credential either.
    expect(redactSecretString('<field data-name="authorization">public-status</field>'))
      .toBe('<field data-name="authorization">public-status</field>');
  });

  test("a multipart credential part is masked through the rest of the body", () => {
    // Line-based masking left a multi-line body and the no-blank-line shape
    // partly intact, and stopping at the first `--` trusted an attacker-chosen
    // boundary token: a body line reading `--not-the-boundary` ended the mask.
    for (const input of [
      'name="authorization"\r\nBasic dXNlcjpwYXNz\r\n--boundary',
      'name="authorization"\r\n\r\ndecoy\r\ncredential-suffix-123456\r\n--boundary',
      "name=authorization\r\n\r\nBasic dXNlcjpwYXNz\r\n--boundary",
      'name="authorization"\r\n\r\n--not-the-boundary\r\ncredential-suffix-123456\r\n--boundary',
    ]) {
      const redacted = redactSecretString(input);
      expect(redacted).toContain(REDACTED_SECRET);
      expect(redacted).not.toContain("dXNlcjpwYXNz");
      expect(redacted).not.toContain("credential-suffix-123456");
    }
  });

  test("a quoted form value is masked too", () => {
    expect(redactSecretString('authorization="Basic%20dXNlcjpwYXNz"&model=gpt-5.5'))
      .toBe(`authorization=${REDACTED_SECRET}&model=gpt-5.5`);
    // A decoy quoted value does not end it early either.
    expect(redactSecretString('authorization="decoy"credential-suffix-123456&model=gpt-5.5'))
      .toBe(`authorization=${REDACTED_SECRET}&model=gpt-5.5`);
  });

  test("serialization escapes are aliases for the label, not a disguise", () => {
    // A JSON `\u0069`, a percent-encoded `%69`, and an XML `&#105;` all spell
    // the credential name to whatever parses the body, while spelling
    // something else to a literal matcher. The matching view decodes them.
    for (const input of [
      '{"author\\u0069zation":"opaquecredential123456"}',
      "author%69zation=opaquecredential123456&model=gpt-5.5",
      '<header name="author&#105;zation">opaquecredential123456</header>',
      '{"x-api-\\u006bey":"opaquecredential123456"}',
      "x%2Dapi%2Dkey=opaquecredential123456&model=gpt-5.5",
      '<header name="x-api-&#x6b;ey">opaquecredential123456</header>',
    ]) {
      const redacted = redactSecretString(input);
      expect(redacted).toContain(REDACTED_SECRET);
      expect(redacted).not.toContain("opaquecredential123456");
    }
  });

  test("decoding may add coverage but never remove it", () => {
    // Decoding `&#x1d569;` yields a mathematical letter that folds to `x`,
    // which changed the FOLLOWING label's left boundary and suppressed a match
    // the plain view made. The rule now runs over both views and masks what
    // either one finds, so the change is one-way by construction.
    expect(redactSecretString("&#x1d569;x-api-key: opaquecredential123456"))
      .toBe(`&#x1d569;x-api-key: ${REDACTED_SECRET}`);
    // An escaped supplementary character emits two UTF-16 units; giving it one
    // offset entry desynchronized the map and left part of the credential.
    expect(redactSecretString("&#x1F600;authorization=opaquecredential123456&model=gpt-5.5"))
      .toBe(`&#x1F600;authorization=${REDACTED_SECRET}&model=gpt-5.5`);
  });

  test("HTML named entities are decoded too", () => {
    // `&colon;` IS the separator, and `&iota;` decodes to a character the
    // homoglyph fold already covers — decoding is what connects the two.
    expect(redactSecretString("x-api-key&colon; opaquecredential123456"))
      .toBe(`x-api-key&colon; ${REDACTED_SECRET}`);
    const xml = redactSecretString('<header name="author&iota;zation">opaquecredential123456</header>');
    expect(xml).toContain(REDACTED_SECRET);
    expect(xml).not.toContain("opaquecredential123456");
  });

  test("multi-unit escapes decode as one character", () => {
    // A JSON surrogate PAIR is one code point; decoding the halves separately
    // left two lone surrogates that normalize to nothing. Percent encoding is
    // UTF-8, so consecutive bytes are one character too — `%D0%B5` is Cyrillic
    // `е`, not two Latin-1 characters.
    expect(redactSecretString('{"\\uD835\\uDD69-api-key":"opaquecredential123456"}'))
      .not.toContain("opaquecredential123456");
    expect(redactSecretString("x-api-k%D0%B5y=opaquecredential123456&model=gpt-5.5"))
      .toBe(`x-api-k%D0%B5y=${REDACTED_SECRET}&model=gpt-5.5`);
  });

  test("any named entity inside a label is treated as one opaque letter", () => {
    // The WHATWG table has ~2200 entries and neither Bun nor Node exposes it.
    // Rather than promise a subset, an unresolved name folds to a placeholder
    // the label accepts wherever a letter may appear — so `&ii;`, `&ee;`, and
    // `&DifferentialD;` are covered without claiming to know what they mean.
    for (const input of [
      '<header name="author&ii;zation">opaquecredential123456</header>',
      '<header name="s&ee;cret">opaquecredential123456</header>',
      '<header name="passwor&DifferentialD;">opaquecredential123456</header>',
    ]) {
      const redacted = redactSecretString(input);
      expect(redacted).toContain(REDACTED_SECRET);
      expect(redacted).not.toContain("opaquecredential123456");
    }
  });

  test("non-credential fields in those framings are untouched", () => {
    expect(redactSecretString("model=gpt-5.5&status=429")).toBe("model=gpt-5.5&status=429");
    expect(redactSecretString("<model>gpt-5.5</model>")).toBe("<model>gpt-5.5</model>");
  });

  test("a pathological repeated-header line neither overflows nor leaks", () => {
    // The first rescan attempt recursed per match and blew the stack here.
    const line = "Authorization: Bearer tok ".repeat(3000);
    const redacted = redactSecretString(line);
    expect(redacted).not.toContain("Bearer tok");
  });

  test("text before a quoted header is kept; everything after it is not", () => {
    // The scheme word still says which auth failed. The trailing path is lost
    // deliberately — keeping it meant keeping an attacker-controlled suffix,
    // which is exactly what the earlier rounds kept getting wrong.
    expect(redactSecretString("failed with Authorization: Bearer secret-abc123 at /Users/example/secret.json"))
      .toBe(`failed with Authorization: Bearer ${REDACTED_SECRET}`);
  });

  test("a Bearer token never masks across a line break", () => {
    // `\s+` included newlines, so a header quoted with a trailing break masked
    // the first word of the NEXT line as if it were the token.
    expect(redactSecretString("Authorization: Bearer\nrequestidentifier123456 diagnostic"))
      .toBe(`Authorization: ${REDACTED_SECRET}\nrequestidentifier123456 diagnostic`);
  });

  test("masks each credential line independently without eating the next", () => {
    // End-of-line, not end-of-string: a multi-line error body must not collapse.
    expect(redactSecretString("x-api-key: one-secret\nmodel: gpt-5.5\ncookie: two=secret"))
      .toBe(`x-api-key: ${REDACTED_SECRET}\nmodel: gpt-5.5\ncookie: ${REDACTED_SECRET}`);
  });
});

describe("redactSecrets", () => {
  test("recursively masks sensitive keys and embedded secret strings", () => {
    const input = {
      ok: true,
      count: 3,
      headers: {
        Authorization: "Bearer nested-secret-token",
        "content-type": "application/json",
      },
      tokens: [
        { accessToken: "access-abc" },
        "refreshToken=refresh-abc",
      ],
      nested: {
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
      },
    };

    const redacted = redactSecrets(input) as typeof input;
    expect(redacted.ok).toBe(true);
    expect(redacted.count).toBe(3);
    expect(redacted.headers.Authorization).toBe(REDACTED_SECRET);
    expect(redacted.headers["content-type"]).toBe("application/json");
    expect(redacted.tokens[0].accessToken).toBe(REDACTED_SECRET);
    expect(redacted.tokens[1]).toBe(`refreshToken=${REDACTED_SECRET}`);
    expect(redacted.nested.profileArn).toBe(REDACTED_SECRET);
  });

  test("leaves dates and primitive non-secrets intact", () => {
    const date = new Date("2026-06-29T00:00:00.000Z");
    expect(redactSecrets(date)).toBe(date);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(42)).toBe(42);
  });
});

describe("redactHeaders", () => {
  test("masks sensitive headers and preserves safe metadata", () => {
    const redacted = redactHeaders(new Headers({
      Authorization: "Bearer header-token-value",
      Cookie: "session=secret",
      "Set-Cookie": "session=secret",
      "X-Api-Key": "sk-header-key",
      "Content-Type": "application/json",
      "X-Request-Id": "req_123",
    }));

    expect(redacted.authorization).toBe(REDACTED_SECRET);
    expect(redacted.cookie).toBe(REDACTED_SECRET);
    expect(redacted["set-cookie"]).toBe(REDACTED_SECRET);
    expect(redacted["x-api-key"]).toBe(REDACTED_SECRET);
    expect(redacted["content-type"]).toBe("application/json");
    expect(redacted["x-request-id"]).toBe("req_123");
  });

  test("supports plain header records", () => {
    const redacted = redactHeaders({
      "x-goog-api-key": "google-secret",
      accept: "application/json",
      "x-extra": undefined,
    });

    expect(redacted["x-goog-api-key"]).toBe(REDACTED_SECRET);
    expect(redacted.accept).toBe("application/json");
    expect(redacted).not.toHaveProperty("x-extra");
  });
});

describe("redactUrlForLog", () => {
  test("strips credentials, query, and hash from valid URLs", () => {
    expect(redactUrlForLog("https://user:pass@example.test/v1/models?api_key=sk-secret#frag"))
      .toBe("https://example.test/v1/models");
  });

  test("best-effort redacts invalid URL strings", () => {
    expect(redactUrlForLog("not a url?refreshToken=refresh-secret")).toBe("not a url");
  });
});
