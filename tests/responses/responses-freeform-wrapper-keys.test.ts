import { describe, expect, spyOn, test } from "bun:test";
import { unwrapFreeformToolInput } from "../../src/responses/apply-patch-envelope";
import { MAX_FREEFORM_WRAPPER_SCAN_CHARS } from "../../src/responses/freeform-wrapper-scan";
import { ProgressiveFreeformInputReader, progressiveFreeformInput } from "../../src/responses/progressive-freeform-input";

/**
 * #5151. The progressive decoder matched the buffer against the literal wrapper opening
 * {"input":" so two spellings JSON.parse treats as the same wrapper matched nothing at all:
 * a canonical key arriving after another property, and one written with a JSON escape. Both
 * streamed the raw object as deltas and then completed as the unwrapped body, which is the
 * delta/completion disagreement #5047 closed for compact wrappers and #5129 for whitespace.
 *
 * These cases live in their own file rather than in the two transport suites that exercise the
 * same decoder: it is shared by the direct bridge and the routed restoration, so asserting it
 * once here keeps one contract instead of duplicating it into two capped files.
 */

/**
 * The delta each prefix publishes, using the rule BOTH callers apply: hold on null, and emit
 * only the suffix of a value that still starts with what was already emitted. Nothing may
 * rewind, so the concatenation is exactly what a client received.
 *
 * A value that does NOT extend what was emitted is recorded rather than quietly dropped. Both
 * callers drop it, which is what makes the transports safe, but a test that only mirrored that
 * would pass while the decoder proposed a retraction on some intermediate prefix. The proposal
 * is the defect; the callers refusing it is the backstop.
 */
function stream(body: string, toolName: string): { deltas: string[]; retractions: string[] } {
  const deltas: string[] = [];
  const retractions: string[] = [];
  let emitted = "";
  for (let end = 1; end <= body.length; end++) {
    const full = progressiveFreeformInput(body.slice(0, end), toolName);
    if (full === null) continue;
    if (!full.startsWith(emitted)) {
      retractions.push(full);
      continue;
    }
    if (full.length === emitted.length) continue;
    deltas.push(full.slice(emitted.length));
    emitted = full;
  }
  return { deltas, retractions };
}

const emissions = (body: string, toolName: string) => stream(body, toolName).deltas;
const published = (body: string, toolName: string) => emissions(body, toolName).join("");

describe("freeform wrapper keys the literal matcher could not see", () => {
  test.each(["exec", "apply_patch"])("holds a possible extra %s wrapper at every prefix", tool => {
    const source = tool === "exec" ? 'text("nested");' : "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch";
    for (const body of [
      JSON.stringify({ input: JSON.stringify({ input: source }) }),
      JSON.stringify({ code: JSON.stringify({ input: source }) }),
      JSON.stringify({ input: ' \n { "\\u0069nput": ' + JSON.stringify(source) + " }" }),
    ]) {
      // The alternate field is recognized only by exec; apply_patch uses patch.
      const args = tool === "apply_patch" ? body.replace('{"code":', '{"patch":') : body;
      expect(unwrapFreeformToolInput(args, tool)).toBe(source);
      expect(stream(args, tool)).toEqual({ deltas: [], retractions: [] });
      expect(progressiveFreeformInput(args, tool)).toBeNull();
    }
    const foreign = JSON.stringify({ input: JSON.stringify({ input: source }) });
    expect(published(foreign, "")).toBe(JSON.stringify({ input: source }));
    // A valid JS block can begin like an object too; it streams once it cannot be a wrapper.
    const block = "{ let x = 1; return x; }";
    const wrappedBlock = JSON.stringify({ input: block });
    expect(unwrapFreeformToolInput(wrappedBlock, tool)).toBe(block);
    expect(published(wrappedBlock, tool)).toBe(block);
  });

  // The extra-wrapper hold covers only prefixes that can still become {"input":<string>}.
  test.each(["exec", "apply_patch"])("object-leading %s bodies keep streaming progressively", tool => {
    for (const body of [
      "{ let x = 1; text(x); }",
      '({ a: 1, b: "two" }).b.length;\ntext("done");',
      '{"inputs": 1}; text("not a wrapper");',
      '{}; text("empty object first");',
    ]) {
      const args = JSON.stringify({ input: body });
      const { deltas, retractions } = stream(args, tool);
      expect(retractions).toEqual([]);
      expect(deltas.length, body).toBeGreaterThan(body.length / 2);
      expect(deltas.join("")).toBe(body);
      expect(unwrapFreeformToolInput(args, tool)).toBe(body);
    }
  });

  test.each(["exec", "apply_patch"])("a real double-wrapped %s body is unwrapped once and never previewed", tool => {
    const source = tool === "exec" ? "text(" + JSON.stringify("x".repeat(400)) + ");" : "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch";
    for (const nested of [
      JSON.stringify({ input: source }),
      ' \t{ "in\\u0070ut" :\n' + JSON.stringify(source) + " } \n",
      '{"input":"first","input":' + JSON.stringify(source) + "}",
    ]) {
      const args = JSON.stringify({ input: nested });
      expect(stream(args, tool)).toEqual({ deltas: [], retractions: [] });
      expect(unwrapFreeformToolInput(args, tool)).toBe(source);
    }
  });

  test.each(["exec", "apply_patch"])("late divergence from the wrapper shape flushes then streams (%s)", tool => {
    const long = "y".repeat(600);
    for (const [nested, divergeAt] of [
      ['{"input":"' + long + '","extra":true}', 14 + long.length],
      ['{"input":"' + long + '"} + text(2);', 14 + long.length],
      ['{"input":"' + long + "\\q" + long + '"}', 12 + long.length],
      ['{"inputs":"' + long + '"}', 8],
    ] as const) {
      const args = JSON.stringify({ input: nested });
      const { deltas, retractions } = stream(args, tool);
      expect(retractions).toEqual([]);
      // Everything held until the divergence arrives in one flush, then streaming resumes.
      expect(deltas[0], nested.slice(0, 20)).toBe(nested.slice(0, divergeAt));
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join("")).toBe(nested);
      expect(unwrapFreeformToolInput(args, tool)).toBe(nested);
    }
  });

  // `progressive` records whether the value can be previewed before the object closes. It is
  // the liveness half of the contract and it is asserted, because holding everything until
  // completion would satisfy the agreement half on its own while quietly ending progressive
  // streaming for the wrappers this change exists to preview.
  const REORDERED_AND_ESCAPED: Array<[label: string, body: string, progressive: boolean]> = [
    ["a scalar property before the canonical key", '{"metadata":1,"input":"cmd"}', true],
    ["an escaped canonical key", '{"\\u0069nput":"cmd"}', true],
    ["a nested preceding value", '{"a":[1,{"b":null},true],"input":"cmd"}', true],
    ["both spellings at once", '{"note":"x","\\u0069nput":"cmd"}', true],
    ["a preceding value holding a brace inside a string", '{"note":"}","input":"cmd"}', true],
    ["whitespace around a reordered key", '{ "metadata" : 1 , "input" : "cmd" }', true],
    // A fallback key only unwraps as the SINGLE string field, so a second field can still
    // arrive and no prefix decides it. It is the one case here that must NOT preview.
    ["an escaped fallback key", '{"\\u0063ode":"cmd"}', false],
  ];

  test("a reordered or escaped wrapper agrees with completion at every split", () => {
    for (const [label, body, progressive] of REORDERED_AND_ESCAPED) {
      const { deltas, retractions } = stream(body, "exec");
      // The authoritative answer, read the way the completed item is read.
      expect({ label, completed: unwrapFreeformToolInput(body, "exec") })
        .toEqual({ label, completed: "cmd" });
      // Characterwise, which covers every split boundary at once.
      expect({ label, streamed: deltas.join("") }).toEqual({ label, streamed: "cmd" });
      // And as one chunk, which is how a non-streaming upstream delivers it.
      expect({ label, whole: progressiveFreeformInput(body, "exec") })
        .toEqual({ label, whole: "cmd" });
      // No prefix may even PROPOSE a value that does not extend what was already published.
      expect({ label, retractions }).toEqual({ label, retractions: [] });
      // A decidable wrapper previews as it arrives; an undecidable one publishes once.
      expect({ label, multiple: deltas.length > 1 }).toEqual({ label, multiple: progressive });

      // The defect was not a wrong total but wrapper syntax reaching the client and then being
      // removed at completion, so assert the published bytes rather than only their sum.
      for (const delta of deltas) {
        expect({ label, delta, leaked: delta.includes("{") || delta.includes('"') })
          .toEqual({ label, delta, leaked: false });
      }
    }
  });

  test("bodies that are not wrappers keep their original bytes", () => {
    // Two string fallback fields: completion declines to guess. A non-string canonical value is
    // not a wrapper either. Both must reach the client byte-exact, not as a repaired body.
    for (const body of ['{"code":"a","script":"b"}', '{"code":1}', '{"input":1}', "{}"]) {
      expect({ body, completed: unwrapFreeformToolInput(body, "exec") })
        .toEqual({ body, completed: body });
      const { deltas, retractions } = stream(body, "exec");
      expect({ body, streamed: deltas.join("") }).toEqual({ body, streamed: body });
      expect({ body, retractions }).toEqual({ body, retractions: [] });
    }

    // Tool-name negative: code is a fallback key only for the tools that own the grammar, so
    // the same object is an ordinary body for any other freeform tool.
    expect(unwrapFreeformToolInput('{"code":"a"}', "")).toBe('{"code":"a"}');
    expect(published('{"code":"a"}', "")).toBe('{"code":"a"}');

    // A trailing comma is not a completed object: `JSON.parse` rejects it, so the scan must
    // not treat the `}` after a top-level comma as the close and unwrap a preview completion
    // hands back unchanged. Preview and completion both keep the raw bytes.
    const trailingComma = '{"code":"cmd",}';
    expect({ body: trailingComma, completed: unwrapFreeformToolInput(trailingComma, "exec") })
      .toEqual({ body: trailingComma, completed: trailingComma });
    expect({ body: trailingComma, streamed: published(trailingComma, "exec") })
      .toEqual({ body: trailingComma, streamed: trailingComma });

    // Text that opens like an object but is not JSON is decidable immediately and must not be
    // held: ordinary code-mode JavaScript reaches this function.
    const program = "{ let x = 1; return x; }";
    expect(published(program, "exec")).toBe(program);
    expect(emissions(program, "exec").length).toBeGreaterThan(1);
  });

  test("does not reparse a closed object on trailing whitespace deltas", () => {
    const parse = spyOn(JSON, "parse");
    try {
      const body = "{}" + " ".repeat(MAX_FREEFORM_WRAPPER_SCAN_CHARS + 1);
      // Inside the bound every whitespace prefix publishes byte-exact; past it the scan holds
      // and completion stays authoritative, exactly like every other budget-exhausted buffer.
      expect(published(body, "exec")).toBe(body.slice(0, MAX_FREEFORM_WRAPPER_SCAN_CHARS));
      // Nothing reparses the accumulated buffer at all anymore: a closed object resolves from
      // the scan's own member table, and `{}` carries no member names to decode. Provider-
      // controlled whitespace deltas therefore cannot turn into repeated parse work.
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  test("a closed object's trailing whitespace streams byte-exact", () => {
    // The review gap in the first fix: once the object closed, later whitespace prefixes held
    // forever, so the concatenated deltas lost the whitespace the completed item keeps. Every
    // raw-object spelling must publish all of its bytes, fragmented or in one chunk.
    for (const body of ["{} ", '{"a":1}   ', '{"code":"a","script":"b"}\t\n', '{ "x" : [ 1 , 2 ] } ']) {
      expect({ body, completed: unwrapFreeformToolInput(body, "exec") })
        .toEqual({ body, completed: body });
      expect({ body, streamed: published(body, "exec") }).toEqual({ body, streamed: body });
      expect({ body, whole: progressiveFreeformInput(body, "exec") })
        .toEqual({ body, whole: body });
      expect({ body, retractions: stream(body, "exec").retractions })
        .toEqual({ body, retractions: [] });
    }

    // A closed fallback wrapper publishes its value once; the trailing whitespace is wrapper
    // syntax rather than input bytes, so it is correctly absent whichever way it arrives.
    for (const body of ['{"code":"cmd"}', '{"code":"cmd"}  ', '{"code":"cmd"}\n']) {
      expect({ body, completed: unwrapFreeformToolInput(body, "exec") })
        .toEqual({ body, completed: "cmd" });
      expect({ body, streamed: published(body, "exec") }).toEqual({ body, streamed: "cmd" });
    }
  });

  test("canonical input and plain bodies stay progressive", () => {
    // Holding an undecided object must not cost the progressive streaming these paths provide.
    const canonical = '{"input":"line one\\nline two"}';
    expect(emissions(canonical, "exec").length).toBeGreaterThan(1);
    expect(published(canonical, "exec")).toBe("line one\nline two");
    expect(emissions("text(1)", "exec").length).toBeGreaterThan(1);
    expect(published("text(1)", "exec")).toBe("text(1)");
  });

  test("a preceding value larger than the scan budget holds rather than guessing", () => {
    // Classification is bounded so the work per delta cannot grow with the arguments. Past the
    // bound nothing is published at all, and the wrapper is still unwrapped by the
    // authoritative completion: the budget costs preview, never agreement.
    const pad = "x".repeat(MAX_FREEFORM_WRAPPER_SCAN_CHARS + 1);
    const body = '{"pad":"' + pad + '","input":"cmd"}';
    expect(unwrapFreeformToolInput(body, "exec")).toBe("cmd");
    expect(stream(body, "exec")).toEqual({ deltas: [], retractions: [] });

    // Braces inside that oversized value must not tempt a release either. Reading the whole
    // buffer on every delta whose last character happens to be a brace is the quadratic cost
    // the bound exists to prevent, and a prefix ending in one is not a complete object.
    const braces = "}".repeat(MAX_FREEFORM_WRAPPER_SCAN_CHARS + 1);
    const braced = '{"pad":"' + braces + '","input":"cmd"}';
    expect(unwrapFreeformToolInput(braced, "exec")).toBe("cmd");
    expect(stream(braced, "exec")).toEqual({ deltas: [], retractions: [] });

    // The same object under the bound still resolves, so the bound is what changed the answer
    // and not the shape: this is the identical body with a value the scan can walk.
    const small = '{"pad":"}}}}","input":"cmd"}';
    expect(published(small, "exec")).toBe("cmd");
  });

  test("a fenced body inside a reordered wrapper still publishes nothing", () => {
    // The fence hold is decided on the DECODED value, so reaching the canonical key through a
    // reordered object must not let fence bytes out that completion strips.
    const fence = "\u0060\u0060\u0060";
    const body = JSON.stringify({ metadata: 1, input: fence + "js\nconst x = 1;\n" + fence });
    expect(unwrapFreeformToolInput(body, "exec")).toBe("const x = 1;");
    expect(published(body, "exec")).toBe("");
  });

  test("the documented preview limits are unchanged by reordering", () => {
    // A duplicate key: JSON.parse keeps the last one after the first was already streamed.
    // Closing this means holding every canonical wrapper until it parses, which is the
    // progressive streaming the first case above requires.
    const duplicate = '{"metadata":1,"input":"first","input":"second"}';
    expect(published(duplicate, "exec")).toBe("first");
    expect(unwrapFreeformToolInput(duplicate, "exec")).toBe("second");

    // A wrapper that turns invalid after the preview committed: the preview stops at the last
    // decodable character and completion keeps the raw text. No rewind, nothing invented.
    const lateInvalid = '{"metadata":1,"input":"safe\\q"}';
    expect(published(lateInvalid, "exec")).toBe("safe");
    expect(unwrapFreeformToolInput(lateInvalid, "exec")).toBe(lateInvalid);
  });

  test("streaming a long nested wrapper one character at a time scans linearly", () => {
    // Each delta used to decode the whole accumulated value and walk the whole decoded body
    // again for a possible nested wrapper, so one-character deltas cost quadratic work. The
    // reader resumes where the previous delta stopped; count what it scans instead of timing it.
    const scanned = (length: number): { chars: number; args: number } => {
      const source = Array.from({ length }, (_, i) =>
        i % 17 === 0 ? "\n" : i % 13 === 0 ? '"' : i % 11 === 0 ? "\\" : i % 7 === 0 ? "\u00e9" : "a").join("");
      const args = JSON.stringify({ input: JSON.stringify({ input: source }) });
      expect(unwrapFreeformToolInput(args, "exec")).toBe(source);
      const reader = new ProgressiveFreeformInputReader();
      for (let end = 1; end <= args.length; end++) {
        // The wrapper stays hidden at every prefix, including the complete one.
        expect(reader.update(args.slice(0, end), "exec")).toBeNull();
      }
      return { chars: reader.scannedChars, args: args.length };
    };
    for (const length of [4_000, 16_000]) {
      const { chars, args } = scanned(length);
      expect({ length, linear: chars <= 3 * args }).toEqual({ length, linear: true });
    }
  });

  test("a non-string nested input holds only while a later duplicate can still unwrap it", () => {
    const wrap = (body: string) => JSON.stringify({ input: body });
    // Once text after the object rules a wrapper out, the held prefix flushes and streams on.
    for (const body of ['{"input":1}.input', '{"input":[1,"]"]} + 1', '{"input":"a","input":2}']) {
      expect({ body, completed: unwrapFreeformToolInput(wrap(body), "exec") }).toEqual({ body, completed: body });
      const { deltas, retractions } = stream(wrap(body), "exec");
      expect({ body, streamed: deltas.join(""), retractions }).toEqual({ body, streamed: body, retractions: [] });
    }
    expect(emissions(wrap('{"input":1}.input + more()'), "exec").length).toBeGreaterThan(1);
    // A later duplicate replaces the non-string value, so this one stays hidden throughout.
    const replaced = wrap('{"input":1,"input":{"a":"}"},"input":"x"}');
    expect(unwrapFreeformToolInput(replaced, "exec")).toBe("x");
    expect(stream(replaced, "exec")).toEqual({ deltas: [], retractions: [] });
  });

  test("a reader resumed across deltas answers like a fresh read of each prefix", () => {
    const bodies = [
      JSON.stringify({ input: JSON.stringify({ input: 'text("\\u00e9\\n")' }) }),
      JSON.stringify({ input: '{"input":1}.input' }),
      JSON.stringify({ input: "{ let x = 1; }\uD83D\uDE00" }).replace("\u{1F600}", "\\ud83d\\ude00"),
      '{"input":"a\\ud83dX"}',
      '{"metadata":1,"input":"cmd\\q"}',
      '{"code":"cmd"} ',
      "plain body",
    ];
    for (const tool of ["exec", "apply_patch", ""]) {
      for (const body of bodies) {
        const reader = new ProgressiveFreeformInputReader();
        for (let end = 1; end <= body.length; end++) {
          const prefix = body.slice(0, end);
          expect({ prefix, tool, resumed: reader.update(prefix, tool) })
            .toEqual({ prefix, tool, resumed: progressiveFreeformInput(prefix, tool) });
        }
      }
    }
  });
});
