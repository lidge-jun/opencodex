import { expect, test } from "bun:test";
import {
  createGuardrailsPlaceholderState,
  demaskGuardrailsText,
  demaskGuardrailsTextWithDiagnosticsForTests,
  maskGuardrailsText,
} from "../src/guardrails/placeholders";
import type { GuardrailsFinding } from "../src/guardrails/types";

function finding(input: string, value: string, start: number, placeholderType = "SECRET", ruleId = "test.secret"): GuardrailsFinding {
  return {
    ruleId,
    dataType: 1,
    placeholderType,
    start,
    end: start + value.length,
    value: input.slice(start, start + value.length),
  };
}

test("placeholder masking is deterministic, reuses originals, and reserves literal placeholders", () => {
  const input = "keep <SECRET_1>; alpha; alpha";
  const first = input.indexOf("alpha");
  const second = input.indexOf("alpha", first + 1);

  const result = maskGuardrailsText(input, [
    finding(input, "alpha", first),
    finding(input, "alpha", second),
  ]);

  expect(result.maskedText).toBe("keep <SECRET_1>; <SECRET_2>; <SECRET_2>");
  expect(result.state.replacements).toEqual([
    expect.objectContaining({ original: "alpha", placeholder: "<SECRET_2>" }),
  ]);
  expect(demaskGuardrailsText(result.maskedText, result.state)).toBe(input);
});

test("placeholder state remains stable across texts and supports controlled drift on demask", () => {
  const state = createGuardrailsPlaceholderState(["literal <ACCESS_TOKEN_1>"]);
  const firstInput = "access token";
  const first = maskGuardrailsText(firstInput, [finding(firstInput, "access token", 0, "ACCESS_TOKEN")], state);
  const secondInput = "access token again";
  const second = maskGuardrailsText(secondInput, [finding(secondInput, "access token", 0, "ACCESS_TOKEN")], first.state);

  expect(first.maskedText).toBe("<ACCESS_TOKEN_2>");
  expect(second.maskedText).toBe("<ACCESS_TOKEN_2> again");
  expect(demaskGuardrailsText("answer < access-token-002 >", second.state)).toBe("answer < access-token-002 >");
  expect(demaskGuardrailsText("answer < access-token-002 >", second.state, {
    allowNormalizedPlaceholderDrift: true,
  })).toBe("answer access token");
});

test("demask preserves nested-token overlap and uses the first closing delimiter", () => {
  const input = "secret";
  const masked = maskGuardrailsText(input, [finding(input, input, 0)]);

  expect(demaskGuardrailsText("<<SECRET_1>", masked.state)).toBe("<secret");
  expect(demaskGuardrailsText("<UNKNOWN><SECRET_1>", masked.state)).toBe("<UNKNOWN>secret");
});

test("normalized placeholder drift accepts 256 code units and rejects 257", () => {
  const input = "secret";
  const masked = maskGuardrailsText(input, [finding(input, input, 0)]);
  const exactLimit = `<${" ".repeat(246)}SECRET_1>`;
  const overLimit = `<${" ".repeat(247)}SECRET_1>`;

  expect(exactLimit.length).toBe(256);
  expect(overLimit.length).toBe(257);
  expect(demaskGuardrailsText(exactLimit, masked.state, {
    allowNormalizedPlaceholderDrift: true,
  })).toBe(input);
  expect(demaskGuardrailsText(overLimit, masked.state, {
    allowNormalizedPlaceholderDrift: true,
  })).toBe(overLimit);
});

test("demask tokenizer does not rescan an unterminated placeholder suffix", () => {
  const input = "<".repeat(128 * 1024);
  const result = demaskGuardrailsTextWithDiagnosticsForTests(
    input,
    createGuardrailsPlaceholderState(),
  );

  expect(result.text).toBe(input);
  expect(result.diagnostics).toEqual({
    candidateTokens: 0,
    closingSearchCodeUnits: input.length,
    maxCandidateTokenLength: 0,
    visitedCodeUnits: input.length,
  });
});

test("partial overlaps are coalesced before replacement so no sensitive suffix leaks", () => {
  const input = "abcdef";
  const result = maskGuardrailsText(input, [
    finding(input, "abcd", 0, "SECRET", "left"),
    finding(input, "cdef", 2, "KEY", "right"),
  ]);

  expect(result.maskedText).toBe("<SECRET_1>");
  expect(result.state.replacements).toEqual([
    expect.objectContaining({ original: "abcdef", placeholder: "<SECRET_1>", ruleId: "left" }),
  ]);
});

test("masking rejects a finding that does not match its declared UTF-16 range", () => {
  const input = "safe";
  expect(() => maskGuardrailsText(input, [{
    ...finding(input, "safe", 0),
    value: "other",
  }])).toThrow("does not match its input range");
});
